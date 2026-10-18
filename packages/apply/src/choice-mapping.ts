import { answer_bank, posting_questions, postings, type Db } from "@job-agent/core";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { approvedMappingIds, choiceOptions, mappingId } from "./choice-coverage.ts";
import {
  DryRunStoreError,
  approveChoiceMapping,
  getChoiceMapping,
  optionTexts,
  optionsHash,
  setChoiceMapping,
  type ChoiceMappingView,
} from "./dry-runs-store.ts";
import { AnswerKeySchema } from "./answers-store.ts";
import type { InboxExample } from "./inbox.ts";
import { matchQuestions } from "./match-questions.ts";
import { normalizeQuestion } from "./match.ts";
import { isSalaryWording } from "./salary.ts";

/** Body of `POST /api/choice-mappings`: which question (answer, wording, option set) and which options the owner picked. */
export const ChoiceMappingSaveSchema = z.strictObject({
  answer_key: AnswerKeySchema,
  label: z.string().min(1).max(1_000),
  options: optionTexts,
  chosen: optionTexts,
});
export type ChoiceMappingSave = z.infer<typeof ChoiceMappingSaveSchema>;

/** A matched choice question that has no approved mapping yet: shown in the Inbox with a picker. */
export interface MappingNeed {
  answerKey: string;
  /** The wording as the first form that asks it spells it. */
  label: string;
  normalizedLabel: string;
  /** The form's options exactly as it lists them (first form that has this option set). */
  options: string[];
  multi: boolean;
  /** The approved answer's text, for the owner to compare with the options. */
  answerText: string;
  postingCount: number;
  examples: InboxExample[];
  /** A pick stored earlier whose approval was cleared; re-saving it approves it again. */
  picked: string[] | null;
  /** Suggestion only: the option that equals the answer text (case-insensitive). The owner still confirms it. */
  suggested: string[] | null;
  /** Set when this one question could not be read (error name only); the rest of the Inbox still loads. */
  error: string | null;
}

const errorName = (e: unknown) => (e instanceof Error ? e.name : "Error");

function suggestOption(options: string[], answerText: string): string[] | null {
  const wanted = answerText.trim().toLowerCase();
  const exact = options.find((o) => o.trim().toLowerCase() === wanted);
  return exact === undefined ? null : [exact];
}

const EXAMPLES = 3;

/**
 * Choice questions of canonical postings whose matched answer is approved and that have no approved mapping for
 * (answer, wording, option set), grouped by that triple, most-asked first.
 */
export function listMappingNeeds(db: Db): MappingNeed[] {
  const answers = new Map(
    db
      .select({ key: answer_bank.key, answer: answer_bank.answer, approved: answer_bank.approved })
      .from(answer_bank)
      .all()
      .map((a) => [a.key, a]),
  );
  const approved = approvedMappingIds(db);
  const rows = db
    .select({ q: posting_questions, title: postings.title, company: postings.company_name })
    .from(posting_questions)
    .innerJoin(postings, eq(postings.id, posting_questions.posting_id))
    .where(isNull(postings.canonical_posting_id))
    .orderBy(desc(posting_questions.fetched_at), asc(postings.id), asc(posting_questions.id))
    .all();
  const groups = new Map<string, MappingNeed>();
  const askedBy = new Map<string, Set<string>>();
  for (const { q, title, company } of rows) {
    const key = q.matched_key;
    if (key === null || key === "salary" || key.startsWith("standard.")) continue;
    try {
      const options = choiceOptions(q.type, q.options);
      const answer = answers.get(key);
      if (options === null || answer === undefined || !answer.approved) continue;
      const normalized = normalizeQuestion(q.normalized_label);
      const id = mappingId(key, normalized, options);
      if (approved.has(id)) continue;
      let need = groups.get(id);
      if (need === undefined) {
        need = {
          answerKey: key,
          label: q.label,
          normalizedLabel: normalized,
          options,
          multi: q.type === "multi_choice",
          answerText: answer.answer,
          postingCount: 0,
          examples: [],
          picked: null,
          suggested: suggestOption(options, answer.answer),
          error: null,
        };
        try {
          need.picked =
            getChoiceMapping(db, { answer_key: key, label: normalized, options })?.chosen ?? null;
        } catch (e) {
          need.error = `could not read the stored mapping (${errorName(e)})`;
        }
        groups.set(id, need);
        askedBy.set(id, new Set());
      }
      const asked = askedBy.get(id);
      if (asked === undefined || asked.has(q.posting_id)) continue;
      asked.add(q.posting_id);
      need.postingCount++;
      if (need.examples.length < EXAMPLES)
        need.examples.push({ postingId: q.posting_id, title, company });
    } catch (e) {
      // One unreadable question is shown with a note; it never fails the whole list.
      groups.set(`error:${q.id}`, {
        answerKey: key,
        label: q.label,
        normalizedLabel: q.normalized_label,
        options: [],
        multi: false,
        answerText: "",
        postingCount: 1,
        examples: [{ postingId: q.posting_id, title, company }],
        picked: null,
        suggested: null,
        error: `could not read this question (${errorName(e)})`,
      });
    }
  }
  return [...groups.values()].sort(
    (a, b) => b.postingCount - a.postingCount || a.label.localeCompare(b.label),
  );
}

/**
 * Stores the owner's pick for one choice question as an approved mapping and re-matches. The pick is checked against
 * the options the stored form lists (not the ones in the request body); a single-choice question takes exactly one.
 * Throws DryRunStoreError: `invalid` for a salary wording or a pick that is not (only) the form's options, and
 * `not_found` when no stored choice question of an approved answer has this wording and option set. Never saves
 * anything on its own; nothing here maps automatically.
 */
export function saveChoiceMapping(
  db: Db,
  input: ChoiceMappingSave,
  now: Date = new Date(),
): ChoiceMappingView {
  const m = ChoiceMappingSaveSchema.parse(input);
  const normalized = normalizeQuestion(m.label);
  if (normalized === "" || isSalaryWording(normalized))
    throw new DryRunStoreError("invalid", ["label"]);
  const hash = optionsHash(m.options);
  const stored = db
    .select({ type: posting_questions.type, options: posting_questions.options })
    .from(posting_questions)
    .innerJoin(postings, eq(postings.id, posting_questions.posting_id))
    .where(
      and(
        eq(posting_questions.matched_key, m.answer_key),
        eq(posting_questions.normalized_label, normalized),
        isNull(postings.canonical_posting_id),
      ),
    )
    .orderBy(asc(posting_questions.id))
    .all()
    .flatMap((q) => {
      const options = choiceOptions(q.type, q.options);
      return options !== null && optionsHash(options) === hash
        ? [{ options, multi: q.type === "multi_choice" }]
        : [];
    })[0];
  const answer = db.select().from(answer_bank).where(eq(answer_bank.key, m.answer_key)).get();
  if (stored === undefined || answer === undefined || !answer.approved)
    throw new DryRunStoreError("not_found", ["answer_key"]);
  if (
    !m.chosen.every((c) => stored.options.includes(c)) ||
    new Set(m.chosen).size !== m.chosen.length ||
    (!stored.multi && m.chosen.length !== 1)
  )
    throw new DryRunStoreError("invalid", ["chosen"]);
  const ref = { answer_key: m.answer_key, label: normalized, options: stored.options };
  setChoiceMapping(db, { ...ref, chosen: m.chosen }, now);
  const approved = approveChoiceMapping(db, ref, true, now);
  if (approved === null) throw new DryRunStoreError("not_found");
  matchQuestions(db);
  return approved;
}
