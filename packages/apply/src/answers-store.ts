import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ANSWER_TYPES, answer_bank, type AnswerBankRow, type Db } from "@job-agent/core";
import { eq } from "drizzle-orm";
import { stringify } from "yaml";
import { z } from "zod";

// Same naming rule as the YAML loader: a dot in a part would make `group.key` ambiguous.
const part = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const AnswerKeySchema = z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

const text = z.string().min(1).max(10_000);
const phrasings = z.array(z.string().min(1).max(1_000)).max(50);

export const NewAnswerSchema = z.strictObject({
  group: part,
  key: part,
  answer: text,
  question: z.string().min(1).max(1_000).nullish(),
  alternatives: phrasings.nullish(),
  type: z.enum(ANSWER_TYPES).nullish(),
  choices: z.array(z.string().min(1).max(1_000)).min(1).max(50).nullish(),
  approved: z.boolean().optional(),
});
export type NewAnswer = z.infer<typeof NewAnswerSchema>;

export const AnswerPatchSchema = z.strictObject({
  answer: text.optional(),
  question: z.string().min(1).max(1_000).nullable().optional(),
  alternatives: phrasings.nullable().optional(),
  type: z.enum(ANSWER_TYPES).nullable().optional(),
  choices: z.array(z.string().min(1).max(1_000)).min(1).max(50).nullable().optional(),
  approved: z.boolean().optional(),
});
export type AnswerPatch = z.infer<typeof AnswerPatchSchema>;

export interface AnswerView {
  key: string;
  group: string;
  question: string | null;
  answer: string;
  type: (typeof ANSWER_TYPES)[number] | null;
  choices: string[] | null;
  alternatives: string[] | null;
  approved: boolean;
  approvedAt: string | null;
  source: "config" | "dashboard";
  updatedAt: string;
}

/** Thrown for a state the request cannot produce (unknown key, duplicate key, type/choices mismatch). */
export class AnswerStoreError extends Error {
  readonly kind: "not_found" | "exists" | "invalid";
  /** Field names only, never values. */
  readonly paths: string[];
  constructor(kind: AnswerStoreError["kind"], paths: string[] = []) {
    super(kind);
    this.name = "AnswerStoreError";
    this.kind = kind;
    this.paths = paths;
  }
}

const parseList = (v: string | null): string[] | null =>
  v === null ? null : (JSON.parse(v) as string[]);
const json = (v: string[] | null): string | null => (v === null ? null : JSON.stringify(v));

function view(r: AnswerBankRow): AnswerView {
  return {
    key: r.key,
    group: r.group,
    question: r.question,
    answer: r.answer,
    type: r.type,
    choices: parseList(r.choices),
    alternatives: parseList(r.alternatives),
    approved: r.approved,
    approvedAt: r.approved_at,
    source: r.source,
    updatedAt: r.updated_at,
  };
}

function checkTypeChoices(type: string | null, choices: string[] | null): void {
  if (type === "choice" && choices === null) throw new AnswerStoreError("invalid", ["choices"]);
  if (type !== "choice" && choices !== null) throw new AnswerStoreError("invalid", ["choices"]);
}

export function listAnswers(db: Db): AnswerView[] {
  return db
    .select()
    .from(answer_bank)
    .all()
    .map(view)
    .sort((a, b) => a.group.localeCompare(b.group) || a.key.localeCompare(b.key));
}

/** Adds a dashboard answer. Approved only when the request says so. */
export function createAnswer(db: Db, input: NewAnswer, now: Date = new Date()): AnswerView {
  const key = `${input.group}.${input.key}`;
  const type = input.type ?? null;
  const choices = input.choices ?? null;
  checkTypeChoices(type, choices);
  const stamp = now.toISOString();
  const approved = input.approved === true;
  return db.transaction((tx) => {
    if (tx.select().from(answer_bank).where(eq(answer_bank.key, key)).get() !== undefined)
      throw new AnswerStoreError("exists");
    const row = tx
      .insert(answer_bank)
      .values({
        id: randomUUID(),
        key,
        group: input.group,
        question: input.question ?? null,
        answer: input.answer,
        type,
        choices: json(choices),
        alternatives: json(input.alternatives ?? null),
        approved,
        approved_at: approved ? stamp : null,
        source: "dashboard",
        updated_at: stamp,
      })
      .returning()
      .get();
    return view(row);
  });
}

/**
 * Edits one entry; any edit marks it `source = dashboard`. Changing the answer text clears `approved` unless the
 * same request approves it. Returns null for an unknown key.
 */
export function updateAnswer(
  db: Db,
  key: string,
  patch: AnswerPatch,
  now: Date = new Date(),
): AnswerView | null {
  const stamp = now.toISOString();
  return db.transaction((tx) => {
    const row = tx.select().from(answer_bank).where(eq(answer_bank.key, key)).get();
    if (row === undefined) return null;
    const type = patch.type === undefined ? row.type : patch.type;
    const choices = patch.choices === undefined ? parseList(row.choices) : patch.choices;
    checkTypeChoices(type, choices);

    const answer = patch.answer ?? row.answer;
    const textChanged = answer !== row.answer;
    const approved = patch.approved ?? (textChanged ? false : row.approved);
    const approvedAt = !approved ? null : row.approved ? row.approved_at : stamp;
    const updated = tx
      .update(answer_bank)
      .set({
        answer,
        question: patch.question === undefined ? row.question : patch.question,
        type,
        choices: json(choices),
        alternatives:
          patch.alternatives === undefined ? row.alternatives : json(patch.alternatives),
        approved,
        approved_at: approvedAt,
        source: "dashboard",
        updated_at: stamp,
      })
      .where(eq(answer_bank.id, row.id))
      .returning()
      .get();
    return view(updated);
  });
}

/** Builds the `answers.yaml` document (`<group>: <key>: { answer, approved, ...optional }`). */
export function answersToYaml(answers: AnswerView[]): string {
  const doc: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const a of answers) {
    const name = a.key.slice(a.group.length + 1);
    (doc[a.group] ??= {})[name] = {
      answer: a.answer,
      approved: a.approved,
      ...(a.question !== null ? { question: a.question } : {}),
      ...(a.alternatives !== null && a.alternatives.length > 0
        ? { alternatives: a.alternatives }
        : {}),
      ...(a.type !== null ? { type: a.type } : {}),
      ...(a.choices !== null ? { choices: a.choices } : {}),
    };
  }
  return stringify(doc);
}

/** Writes `answers-<date>.yaml` into `dir` (created if missing). Returns the path and entry count. */
export function exportAnswers(db: Db, dir: string, date: string): { path: string; count: number } {
  const answers = listAnswers(db);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `answers-${date}.yaml`);
  writeFileSync(path, answersToYaml(answers), "utf8");
  return { path, count: answers.length };
}
