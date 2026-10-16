import { createHash, randomUUID } from "node:crypto";
import {
  answer_bank,
  choice_mappings,
  DRY_RUN_ATS_TYPES,
  DRY_RUN_FIELD_SOURCES,
  DRY_RUN_REVIEW_REASONS,
  DRY_RUN_REVIEWS,
  DRY_RUN_STATUSES,
  DRY_RUN_STOP_REASONS,
  dry_run_fields,
  dry_runs,
  type ChoiceMapping,
  type Db,
  type DryRun,
  type DryRunField,
} from "@job-agent/core";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { AnswerKeySchema } from "./answers-store.ts";
import { normalizeQuestion } from "./match.ts";
import { isSalaryWording } from "./salary.ts";

/** Thrown for a state the request cannot produce. Field names only, never values (filled values are personal data). */
export class DryRunStoreError extends Error {
  readonly kind: "not_found" | "invalid";
  readonly paths: string[];
  constructor(kind: DryRunStoreError["kind"], paths: string[] = []) {
    super(kind);
    this.name = "DryRunStoreError";
    this.kind = kind;
    this.paths = paths;
  }
}

const isoUtc = z.iso.datetime();
const label = z.string().min(1).max(1_000);
const nullableText = (max: number) => z.string().min(1).max(max).nullish();

/** A path under the data dir: relative, no `..` segment, no backslash. */
const relativePath = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (p) => !p.startsWith("/") && !p.includes("\\") && !p.split("/").includes(".."),
    "path must be relative to the data dir",
  );

export const DryRunFieldInputSchema = z.strictObject({
  label,
  field_type: z.string().min(1).max(100),
  required: z.boolean(),
  source: z.enum(DRY_RUN_FIELD_SOURCES),
  answer_key: AnswerKeySchema.nullish(),
  value: z.string().max(10_000).nullish(),
  filled: z.boolean(),
  note: nullableText(500),
});
export type DryRunFieldInput = z.infer<typeof DryRunFieldInputSchema>;

export const NewDryRunSchema = z
  .strictObject({
    posting_id: z.string().min(1),
    ats_type: z.enum(DRY_RUN_ATS_TYPES),
    started_at: isoUtc,
    finished_at: isoUtc,
    status: z.enum(DRY_RUN_STATUSES),
    stop_reason: z.enum(DRY_RUN_STOP_REASONS).nullish(),
    /** Short, never answer text. */
    stop_detail: nullableText(200),
    screenshot_path: relativePath.nullish(),
    fixture: z.boolean(),
    fields: z.array(DryRunFieldInputSchema).max(500),
  })
  .superRefine((run, ctx) => {
    const bad = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (run.status === "filled" && run.stop_reason != null)
      bad("stop_reason", "a filled run has no stop reason");
    if (run.status !== "filled" && run.stop_reason == null)
      bad("stop_reason", "a run that is not filled needs a stop reason");
    if (
      run.status === "needs_input" &&
      run.stop_reason != null &&
      run.stop_reason !== "uncovered_question" &&
      run.stop_reason !== "choice_unmapped"
    )
      bad("stop_reason", "needs_input is uncovered_question or choice_unmapped");
    if (run.finished_at < run.started_at) bad("finished_at", "finished before it started");
  });
export type NewDryRunInput = z.infer<typeof NewDryRunSchema>;

export const DryRunReviewSchema = z
  .strictObject({
    review: z.enum(DRY_RUN_REVIEWS),
    reason: z.enum(DRY_RUN_REVIEW_REASONS).nullish(),
    note: nullableText(2_000),
  })
  .superRefine((r, ctx) => {
    if (r.review === "wrong" && r.reason == null)
      ctx.addIssue({ code: "custom", path: ["reason"], message: "a wrong run needs a reason" });
    if (r.review === "correct" && r.reason != null)
      ctx.addIssue({ code: "custom", path: ["reason"], message: "a correct run has no reason" });
  });
export type DryRunReviewInput = z.infer<typeof DryRunReviewSchema>;

export interface DryRunWithFields {
  run: DryRun;
  fields: DryRunField[];
}

/** Inserts the run and all its fields in one transaction; returns the run id. */
export function recordDryRun(db: Db, input: NewDryRunInput): string {
  const run = NewDryRunSchema.parse(input);
  const id = randomUUID();
  db.transaction((tx) => {
    tx.insert(dry_runs)
      .values({
        id,
        posting_id: run.posting_id,
        ats_type: run.ats_type,
        started_at: run.started_at,
        finished_at: run.finished_at,
        status: run.status,
        stop_reason: run.stop_reason ?? null,
        stop_detail: run.stop_detail ?? null,
        screenshot_path: run.screenshot_path ?? null,
        fixture: run.fixture,
      })
      .run();
    for (const f of run.fields) {
      tx.insert(dry_run_fields)
        .values({
          id: randomUUID(),
          dry_run_id: id,
          label: f.label,
          field_type: f.field_type,
          required: f.required,
          source: f.source,
          answer_key: f.answer_key ?? null,
          value: f.value ?? null,
          filled: f.filled,
          note: f.note ?? null,
        })
        .run();
    }
  });
  return id;
}

/** Sets or replaces the owner's review. Returns null for an unknown run id. */
export function setDryRunReview(
  db: Db,
  runId: string,
  input: DryRunReviewInput,
  now: Date = new Date(),
): DryRun | null {
  const r = DryRunReviewSchema.parse(input);
  return (
    db
      .update(dry_runs)
      .set({
        review: r.review,
        review_reason: r.reason ?? null,
        review_note: r.note ?? null,
        reviewed_at: now.toISOString(),
      })
      .where(eq(dry_runs.id, runId))
      .returning()
      .get() ?? null
  );
}

export interface ListDryRunsOptions {
  /** Default 100. */
  limit?: number;
  /** Only runs for this posting. */
  postingId?: string;
}

/** Newest first, without fields. */
export function listDryRuns(db: Db, opts: ListDryRunsOptions = {}): DryRun[] {
  const limit = z
    .number()
    .int()
    .min(1)
    .max(1_000)
    .parse(opts.limit ?? 100);
  const where =
    opts.postingId === undefined ? undefined : and(eq(dry_runs.posting_id, opts.postingId));
  return db
    .select()
    .from(dry_runs)
    .where(where)
    .orderBy(desc(dry_runs.started_at), desc(dry_runs.id))
    .limit(limit)
    .all();
}

export function getDryRun(db: Db, runId: string): DryRunWithFields | null {
  const run = db.select().from(dry_runs).where(eq(dry_runs.id, runId)).get();
  if (run === undefined) return null;
  const fields = db.select().from(dry_run_fields).where(eq(dry_run_fields.dry_run_id, runId)).all();
  return { run, fields };
}

// --- choice mappings -------------------------------------------------------------------------------------------

const optionTexts = z.array(z.string().min(1).max(1_000)).min(1).max(200);

/** Hash of the sorted, normalized option texts: the same option set in any order or casing gives the same hash. */
export function optionsHash(options: string[]): string {
  const sorted = options.map(normalizeQuestion).sort();
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

export const ChoiceMappingRefSchema = z.strictObject({
  answer_key: AnswerKeySchema,
  label,
  options: optionTexts,
});
export type ChoiceMappingRef = z.infer<typeof ChoiceMappingRefSchema>;

export const ChoiceMappingInputSchema = ChoiceMappingRefSchema.extend({
  chosen: optionTexts,
});
export type ChoiceMappingInput = z.infer<typeof ChoiceMappingInputSchema>;

export interface ChoiceMappingView {
  answerKey: string;
  normalizedLabel: string;
  optionsHash: string;
  options: string[];
  chosen: string[];
  approved: boolean;
  approvedAt: string | null;
  updatedAt: string;
}

function mappingView(r: ChoiceMapping): ChoiceMappingView {
  return {
    answerKey: r.answer_key,
    normalizedLabel: r.normalized_label,
    optionsHash: r.options_hash,
    options: JSON.parse(r.options) as string[],
    chosen: JSON.parse(r.chosen) as string[],
    approved: r.approved,
    approvedAt: r.approved_at,
    updatedAt: r.updated_at,
  };
}

const keyOf = (ref: ChoiceMappingRef) => {
  const normalized = normalizeQuestion(ref.label);
  return and(
    eq(choice_mappings.answer_key, ref.answer_key),
    eq(choice_mappings.normalized_label, normalized),
    eq(choice_mappings.options_hash, optionsHash(ref.options)),
  );
};

/** The mapping for exactly this answer, question wording and option set, or null. A new option set has no mapping. */
export function getChoiceMapping(db: Db, ref: ChoiceMappingRef): ChoiceMappingView | null {
  const r = ChoiceMappingRefSchema.parse(ref);
  const row = db.select().from(choice_mappings).where(keyOf(r)).get();
  return row === undefined ? null : mappingView(row);
}

/**
 * Creates or updates the owner's pick, never approved by this call. An unchanged pick keeps its approval; a
 * changed pick clears it. Throws `invalid` for a salary wording (no mapping, ever) or a pick that is not one of
 * the options, and `not_found` for an answer key that is not in the bank.
 */
export function setChoiceMapping(
  db: Db,
  input: ChoiceMappingInput,
  now: Date = new Date(),
): ChoiceMappingView {
  const m = ChoiceMappingInputSchema.parse(input);
  const normalized = normalizeQuestion(m.label);
  if (normalized === "" || isSalaryWording(normalized))
    throw new DryRunStoreError("invalid", ["label"]);
  if (!m.chosen.every((c) => m.options.includes(c)))
    throw new DryRunStoreError("invalid", ["chosen"]);
  const stamp = now.toISOString();
  const chosen = JSON.stringify(m.chosen);
  return db.transaction((tx) => {
    if (tx.select().from(answer_bank).where(eq(answer_bank.key, m.answer_key)).get() === undefined)
      throw new DryRunStoreError("not_found", ["answer_key"]);
    const existing = tx.select().from(choice_mappings).where(keyOf(m)).get();
    if (existing === undefined) {
      return mappingView(
        tx
          .insert(choice_mappings)
          .values({
            id: randomUUID(),
            answer_key: m.answer_key,
            normalized_label: normalized,
            options_hash: optionsHash(m.options),
            options: JSON.stringify(m.options),
            chosen,
            approved: false,
            approved_at: null,
            updated_at: stamp,
          })
          .returning()
          .get(),
      );
    }
    if (existing.chosen === chosen) return mappingView(existing);
    return mappingView(
      tx
        .update(choice_mappings)
        .set({ chosen, approved: false, approved_at: null, updated_at: stamp })
        .where(eq(choice_mappings.id, existing.id))
        .returning()
        .get(),
    );
  });
}

/** Approves (or with `approved: false` withdraws) one mapping. Returns null when it does not exist. */
export function approveChoiceMapping(
  db: Db,
  ref: ChoiceMappingRef,
  approved: boolean = true,
  now: Date = new Date(),
): ChoiceMappingView | null {
  const r = ChoiceMappingRefSchema.parse(ref);
  const stamp = now.toISOString();
  const row = db
    .update(choice_mappings)
    .set({ approved, approved_at: approved ? stamp : null, updated_at: stamp })
    .where(keyOf(r))
    .returning()
    .get();
  return row === undefined ? null : mappingView(row);
}

/** Every mapping of every answer, ordered by answer key, label, then option hash. */
export function listAllChoiceMappings(db: Db): ChoiceMappingView[] {
  return db
    .select()
    .from(choice_mappings)
    .all()
    .sort(
      (a, b) =>
        a.answer_key.localeCompare(b.answer_key) ||
        a.normalized_label.localeCompare(b.normalized_label) ||
        a.options_hash.localeCompare(b.options_hash),
    )
    .map(mappingView);
}

/** Deletes one mapping. Returns false when it does not exist. */
export function removeChoiceMapping(db: Db, ref: ChoiceMappingRef): boolean {
  const r = ChoiceMappingRefSchema.parse(ref);
  return db.delete(choice_mappings).where(keyOf(r)).returning().all().length > 0;
}

/** Every mapping for one answer key (approved or not), ordered by label then option hash. */
export function listChoiceMappings(db: Db, answerKey: string): ChoiceMappingView[] {
  const key = AnswerKeySchema.parse(answerKey);
  return db
    .select()
    .from(choice_mappings)
    .where(eq(choice_mappings.answer_key, key))
    .all()
    .sort(
      (a, b) =>
        a.normalized_label.localeCompare(b.normalized_label) ||
        a.options_hash.localeCompare(b.options_hash),
    )
    .map(mappingView);
}
