import { and, asc, desc, eq, isNull } from "drizzle-orm";
import {
  ANSWER_TYPES,
  posting_questions,
  postings,
  unknown_questions,
  type Db,
} from "@job-agent/core";
import { z } from "zod";
import {
  AnswerStoreError,
  NewAnswerSchema,
  assertTypedAnswer,
  createAnswer,
  listAnswers,
  updateAnswer,
} from "./answers-store.ts";
import { listMappingNeeds, type MappingNeed } from "./choice-mapping.ts";
import { normalizeQuestion } from "./match.ts";
import { isSalaryWording } from "./salary.ts";
import { matchQuestions } from "./match-questions.ts";

/** Body of `POST /api/inbox/:id/answer`: the wording itself becomes the answer's canonical question. */
export const InboxAnswerSchema = NewAnswerSchema.pick({
  group: true,
  key: true,
  answer: true,
  choices: true,
  approved: true,
})
  .extend({ type: z.enum(ANSWER_TYPES) })
  .strict();
export type InboxAnswer = z.infer<typeof InboxAnswerSchema>;

export const InboxLinkSchema = z.strictObject({ key: z.string().min(1).max(200) });

export interface InboxExample {
  postingId: string;
  title: string;
  company: string;
}

export interface InboxItem {
  id: string;
  label: string;
  postingCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Pay question: answered by the per-posting tier ask, never from the bank. No answer form. */
  salary: boolean;
  examples: InboxExample[];
  /** Set when this one wording could not be read (error name only); the rest of the Inbox still loads. */
  error: string | null;
}

export interface InboxList {
  openCount: number;
  items: InboxItem[];
  /** Matched choice questions waiting for the owner's option mapping. */
  mappings: MappingNeed[];
}

/** Field names only, never values. */
export class InboxError extends Error {
  readonly kind: "not_found" | "not_open" | "invalid";
  readonly paths: string[];
  constructor(kind: InboxError["kind"], paths: string[] = []) {
    super(kind);
    this.name = "InboxError";
    this.kind = kind;
    this.paths = paths;
  }
}

const EXAMPLES = 3;

function openCount(db: Db): number {
  return db.select().from(unknown_questions).where(eq(unknown_questions.status, "open")).all()
    .length;
}

/** Open wordings, most-asked first, each with up to three postings that ask it. */
export function listInbox(db: Db): InboxList {
  const rows = db
    .select()
    .from(unknown_questions)
    .where(eq(unknown_questions.status, "open"))
    .orderBy(desc(unknown_questions.posting_count), asc(unknown_questions.label))
    .all();
  const items = rows.map((r): InboxItem => {
    try {
      return inboxItem(db, r);
    } catch (e) {
      return {
        id: r.id,
        label: r.label,
        postingCount: r.posting_count,
        firstSeenAt: r.first_seen_at,
        lastSeenAt: r.last_seen_at,
        salary: false,
        examples: [],
        error: `could not read this question (${e instanceof Error ? e.name : "Error"})`,
      };
    }
  });
  return { openCount: items.length, items, mappings: listMappingNeeds(db) };
}

function inboxItem(db: Db, r: typeof unknown_questions.$inferSelect): InboxItem {
  const examples: InboxExample[] = [];
  const asked = db
    .select({ id: postings.id, title: postings.title, company: postings.company_name })
    .from(posting_questions)
    .innerJoin(postings, eq(postings.id, posting_questions.posting_id))
    .where(
      and(
        eq(posting_questions.normalized_label, r.normalized_label),
        isNull(postings.canonical_posting_id),
      ),
    )
    .orderBy(desc(posting_questions.fetched_at), asc(postings.id))
    .all();
  for (const a of asked) {
    if (examples.some((e) => e.postingId === a.id)) continue;
    examples.push({ postingId: a.id, title: a.title, company: a.company });
    if (examples.length === EXAMPLES) break;
  }
  return {
    id: r.id,
    label: r.label,
    postingCount: r.posting_count,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    salary: isSalaryWording(r.label),
    examples,
    error: null,
  };
}

function openRow(db: Db, id: string) {
  const row = db.select().from(unknown_questions).where(eq(unknown_questions.id, id)).get();
  if (row === undefined) throw new InboxError("not_found");
  if (row.status !== "open") throw new InboxError("not_open");
  return { row, salary: isSalaryWording(row.label) };
}

function decide(
  db: Db,
  id: string,
  status: "answered" | "linked" | "dismissed",
  key: string | null,
) {
  db.update(unknown_questions)
    .set({ status, answer_key: key })
    .where(and(eq(unknown_questions.id, id), eq(unknown_questions.status, "open")))
    .run();
}

/** Result of every action: the number of wordings still open after matching re-ran over all stored questions. */
export interface InboxResult {
  openCount: number;
  /** The answer key that now owns the wording; null for a dismissal. */
  key: string | null;
}

/**
 * Creates a dashboard answer whose canonical question is the wording (approved only when asked), marks the wording
 * answered and re-matches. Throws AnswerStoreError for a bad or duplicate key, InboxError for a missing, decided or
 * pay row.
 */
export function answerInbox(
  db: Db,
  id: string,
  input: InboxAnswer,
  now: Date = new Date(),
): InboxResult {
  const { row, salary } = openRow(db, id);
  if (salary) throw new InboxError("invalid", ["salary"]);
  assertTypedAnswer(input.answer, input.type, input.choices ?? null);
  const created = createAnswer(db, { ...input, question: row.label }, now);
  decide(db, id, "answered", created.key);
  matchQuestions(db);
  return { openCount: openCount(db), key: created.key };
}

/** Adds the wording as an alternative of an existing answer, marks it linked and re-matches. */
export function linkInbox(db: Db, id: string, key: string, now: Date = new Date()): InboxResult {
  const { row, salary } = openRow(db, id);
  if (salary) throw new InboxError("invalid", ["salary"]);
  const target = listAnswers(db).find((a) => a.key === key);
  if (target === undefined) throw new AnswerStoreError("not_found");
  const wording = normalizeQuestion(row.label);
  const known = [target.question, ...(target.alternatives ?? [])].some(
    (w) => w !== null && normalizeQuestion(w) === wording,
  );
  if (!known)
    updateAnswer(db, key, { alternatives: [...(target.alternatives ?? []), row.label] }, now);
  decide(db, id, "linked", key);
  matchQuestions(db);
  return { openCount: openCount(db), key };
}

/** Marks the wording dismissed (it leaves the inbox for good) and re-matches. */
export function dismissInbox(db: Db, id: string): InboxResult {
  openRow(db, id);
  decide(db, id, "dismissed", null);
  matchQuestions(db);
  return { openCount: openCount(db), key: null };
}
