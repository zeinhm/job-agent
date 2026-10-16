import { randomUUID } from "node:crypto";
import {
  answer_bank,
  posting_questions,
  postings,
  unknown_questions,
  type Db,
} from "@job-agent/core";
import { eq, inArray, isNull } from "drizzle-orm";
import { approvedMappingIds, choiceOptions, mappingId } from "./choice-coverage.ts";
import { buildAnswerIndex, matchedKeyOf, matchQuestion, normalizeQuestion } from "./match.ts";

export interface MatchSummary {
  questions: number;
  /** Standard fields, approved answers, and choice questions whose answer also has an approved mapping. */
  covered: number;
  /** Matched to an approved answer, but a choice question without an approved mapping for its option set. */
  needsMapping: number;
  salary: number;
  unknown: number;
  /** Distinct unknown wordings. */
  unknownWordings: number;
  /** Questions whose matched key changed in this run. */
  changed: number;
}

export interface QuestionCounts {
  total: number;
  covered: number;
  /** Matched to an approved answer, waiting for the owner's choice mapping. */
  needsMapping: number;
  /** No match: waiting in the inbox. */
  unknown: number;
  salary: number;
}

interface Wording {
  label: string;
  postings: Set<string>;
  first: string;
  last: string;
}

function parseList(text: string): string[] {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

interface ChoiceRow {
  type: string;
  options: string | null;
  normalized_label: string;
}

/** A choice question matched to answer `key` is covered only with an approved mapping for its option set. */
function needsMapping(q: ChoiceRow, key: string, approved: ReadonlySet<string>): boolean {
  const options = choiceOptions(q.type, q.options);
  return options !== null && !approved.has(mappingId(key, q.normalized_label, options));
}

/**
 * Sets `posting_questions.matched_key` for every stored question (only approved answers count; salary questions get
 * `salary`, never an answer key) and rebuilds `unknown_questions` for the rest. Everything is recomputed from the
 * current tables, so an answer that was unapproved since the last run un-covers its questions, and a re-run changes
 * nothing. Seen times come from `fetched_at`, not the clock.
 */
export function matchQuestions(db: Db): MatchSummary {
  return db.transaction((tx) => {
    const index = buildAnswerIndex(
      tx
        .select({
          key: answer_bank.key,
          question: answer_bank.question,
          alternatives: answer_bank.alternatives,
          approved: answer_bank.approved,
        })
        .from(answer_bank)
        .all()
        .map((r) => ({
          ...r,
          alternatives: r.alternatives === null ? null : parseList(r.alternatives),
        })),
    );
    // Questions of a non-canonical variant are ignored: the canonical posting stands for the whole job.
    const rows = tx
      .select({ q: posting_questions })
      .from(posting_questions)
      .innerJoin(postings, eq(postings.id, posting_questions.posting_id))
      .where(isNull(postings.canonical_posting_id))
      .all()
      .map((r) => r.q)
      .sort((a, b) => a.fetched_at.localeCompare(b.fetched_at) || a.id.localeCompare(b.id));
    const summary: MatchSummary = {
      questions: rows.length,
      covered: 0,
      needsMapping: 0,
      salary: 0,
      unknown: 0,
      unknownWordings: 0,
      changed: 0,
    };
    const approvedMappings = approvedMappingIds(tx);
    const unknown = new Map<string, Wording>();
    for (const r of rows) {
      const normalized = normalizeQuestion(r.normalized_label);
      const match = matchQuestion(normalized, index);
      const key = matchedKeyOf(match);
      if (key !== r.matched_key) {
        tx.update(posting_questions)
          .set({ matched_key: key })
          .where(eq(posting_questions.id, r.id))
          .run();
        summary.changed++;
      }
      if (match === null) {
        summary.unknown++;
        const w = unknown.get(normalized);
        if (w === undefined) {
          unknown.set(normalized, {
            label: r.label,
            postings: new Set([r.posting_id]),
            first: r.fetched_at,
            last: r.fetched_at,
          });
        } else {
          w.postings.add(r.posting_id);
          if (r.fetched_at > w.last) w.last = r.fetched_at;
        }
      } else if (match.kind === "salary") {
        summary.salary++;
      } else if (match.kind === "answer" && needsMapping(r, match.key, approvedMappings)) {
        summary.needsMapping++;
      } else {
        summary.covered++;
      }
    }
    summary.unknownWordings = unknown.size;

    const existing = new Map(
      tx
        .select()
        .from(unknown_questions)
        .all()
        .map((r) => [r.normalized_label, r]),
    );
    for (const [normalized, w] of unknown) {
      const old = existing.get(normalized);
      if (old === undefined) {
        tx.insert(unknown_questions)
          .values({
            id: randomUUID(),
            normalized_label: normalized,
            label: w.label,
            posting_count: w.postings.size,
            first_seen_at: w.first,
            last_seen_at: w.last,
          })
          .run();
        continue;
      }
      const first = old.first_seen_at < w.first ? old.first_seen_at : w.first;
      const last = old.last_seen_at > w.last ? old.last_seen_at : w.last;
      if (
        old.posting_count !== w.postings.size ||
        old.first_seen_at !== first ||
        old.last_seen_at !== last
      ) {
        tx.update(unknown_questions)
          .set({ posting_count: w.postings.size, first_seen_at: first, last_seen_at: last })
          .where(eq(unknown_questions.id, old.id))
          .run();
      }
    }
    // A wording nobody asks unmatched any more: an open row is gone, a decided one (answered, linked, dismissed) stays.
    for (const [normalized, old] of existing) {
      if (unknown.has(normalized)) continue;
      if (old.status === "open") {
        tx.delete(unknown_questions).where(eq(unknown_questions.id, old.id)).run();
      } else if (old.posting_count !== 0) {
        tx.update(unknown_questions)
          .set({ posting_count: 0 })
          .where(eq(unknown_questions.id, old.id))
          .run();
      }
    }
    return summary;
  });
}

/** Per posting: how many of its stored questions are covered, unknown, salary. Postings without questions get zeros. */
export function questionCounts(db: Db, postingIds: readonly string[]): Map<string, QuestionCounts> {
  const out = new Map<string, QuestionCounts>(
    postingIds.map((id) => [id, { total: 0, covered: 0, needsMapping: 0, unknown: 0, salary: 0 }]),
  );
  if (postingIds.length === 0) return out;
  const rows = db
    .select({
      id: posting_questions.posting_id,
      key: posting_questions.matched_key,
      type: posting_questions.type,
      options: posting_questions.options,
      normalized_label: posting_questions.normalized_label,
    })
    .from(posting_questions)
    .where(inArray(posting_questions.posting_id, [...postingIds]))
    .all();
  const approved = approvedMappingIds(db);
  for (const r of rows) {
    const c = out.get(r.id);
    if (c === undefined) continue;
    c.total++;
    if (r.key === null) c.unknown++;
    else if (r.key === "salary") c.salary++;
    else if (!r.key.startsWith("standard.") && needsMapping(r, r.key, approved)) c.needsMapping++;
    else c.covered++;
  }
  return out;
}
