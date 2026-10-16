import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import {
  DRY_RUN_REVIEW_REASONS,
  DRY_RUN_REVIEWS,
  dry_run_fields,
  dry_runs,
  posting_questions,
  postings,
  unknown_questions,
  type Db,
  type DryRun,
  type DryRunField,
} from "@job-agent/core";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { DRYRUNS_DIR } from "./dryrun/output.ts";
import { getDryRun, setDryRunReview } from "./dry-runs-store.ts";
import { matchQuestions } from "./match-questions.ts";
import { normalizeQuestion } from "./match.ts";

/** Owner rule (phase-5 backlog "Decisions" 9): at least this many correct reviews, at least FULL_TARGET of them full fills. */
export const CORRECT_TARGET = 20;
export const FULL_FILL_TARGET = 10;

export interface DryRunDoneWhen {
  correct: number;
  reviewed: number;
  fullFills: number;
  met: boolean;
  line: string;
}

/** Owner-run dry runs only: fixture runs never count. A full fill is a correct run with status `filled`. */
export function dryRunDoneWhen(db: Db): DryRunDoneWhen {
  const rows = db
    .select({ status: dry_runs.status, review: dry_runs.review })
    .from(dry_runs)
    .where(eq(dry_runs.fixture, false))
    .all();
  const reviewed = rows.filter((r) => r.review !== null).length;
  const correct = rows.filter((r) => r.review === "correct");
  const fullFills = correct.filter((r) => r.status === "filled").length;
  const met = correct.length >= CORRECT_TARGET && fullFills >= FULL_FILL_TARGET;
  return {
    correct: correct.length,
    reviewed,
    fullFills,
    met,
    line: `dry runs: ${correct.length} correct of ${reviewed} reviewed (${fullFills} full fills); done when ${CORRECT_TARGET} correct, at least ${FULL_FILL_TARGET} full fills: ${met ? "met" : "not met"}`,
  };
}

export interface DryRunListRow {
  id: string;
  postingId: string;
  title: string;
  company: string;
  atsType: string;
  status: string;
  stopReason: string | null;
  fieldsFilled: number;
  fieldsTotal: number;
  startedAt: string;
  fixture: boolean;
  review: "correct" | "wrong" | null;
  reviewReason: string | null;
}

/** Newest first. Counts only: no filled values leave this function. */
export function listDryRunRows(db: Db, limit = 200): DryRunListRow[] {
  const runs = db
    .select({ run: dry_runs, title: postings.title, company: postings.company_name })
    .from(dry_runs)
    .innerJoin(postings, eq(postings.id, dry_runs.posting_id))
    .orderBy(desc(dry_runs.started_at), desc(dry_runs.id))
    .limit(limit)
    .all();
  const counts = new Map<string, { filled: number; total: number }>();
  for (const f of db
    .select({ run: dry_run_fields.dry_run_id, filled: dry_run_fields.filled })
    .from(dry_run_fields)
    .all()) {
    const c = counts.get(f.run) ?? { filled: 0, total: 0 };
    c.total++;
    if (f.filled) c.filled++;
    counts.set(f.run, c);
  }
  return runs.map(({ run, title, company }) => ({
    id: run.id,
    postingId: run.posting_id,
    title,
    company,
    atsType: run.ats_type,
    status: run.status,
    stopReason: run.stop_reason,
    fieldsFilled: counts.get(run.id)?.filled ?? 0,
    fieldsTotal: counts.get(run.id)?.total ?? 0,
    startedAt: run.started_at,
    fixture: run.fixture,
    review: run.review,
    reviewReason: run.review_reason,
  }));
}

export interface DryRunDetail extends DryRunListRow {
  finishedAt: string;
  stopDetail: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  hasScreenshot: boolean;
  /**
   * The harness stores no per-request list (a blocked request is method, host and path in memory only). Recorded is 1
   * when the run was stopped as `blocked_request`, else 0.
   */
  blockedRequestsRecorded: number;
  fields: {
    label: string;
    fieldType: string;
    required: boolean;
    source: string;
    answerKey: string | null;
    value: string | null;
    filled: boolean;
    note: string | null;
  }[];
}

export function getDryRunDetail(db: Db, runId: string): DryRunDetail | null {
  const found = getDryRun(db, runId);
  if (found === null) return null;
  const { run, fields } = found;
  const posting = db.select().from(postings).where(eq(postings.id, run.posting_id)).get();
  return {
    id: run.id,
    postingId: run.posting_id,
    title: posting?.title ?? "",
    company: posting?.company_name ?? "",
    atsType: run.ats_type,
    status: run.status,
    stopReason: run.stop_reason,
    fieldsFilled: fields.filter((f) => f.filled).length,
    fieldsTotal: fields.length,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    fixture: run.fixture,
    review: run.review,
    reviewReason: run.review_reason,
    reviewNote: run.review_note,
    reviewedAt: run.reviewed_at,
    stopDetail: run.stop_detail,
    hasScreenshot: run.screenshot_path !== null,
    blockedRequestsRecorded: run.stop_reason === "blocked_request" ? 1 : 0,
    fields: fields.map((f: DryRunField) => ({
      label: f.label,
      fieldType: f.field_type,
      required: f.required,
      source: f.source,
      answerKey: f.answer_key,
      value: f.value,
      filled: f.filled,
      note: f.note,
    })),
  };
}

// Review body of the dashboard: the stored review plus the label typed for `missing_field`.
export const DryRunReviewBodySchema = z
  .strictObject({
    review: z.enum(DRY_RUN_REVIEWS),
    reason: z.enum(DRY_RUN_REVIEW_REASONS).nullish(),
    note: z.string().min(1).max(2_000).nullish(),
    missing_label: z.string().min(1).max(1_000).nullish(),
  })
  .superRefine((b, ctx) => {
    if (b.review === "wrong" && b.reason == null)
      ctx.addIssue({ code: "custom", path: ["reason"], message: "a wrong run needs a reason" });
    if (b.review === "correct" && b.reason != null)
      ctx.addIssue({ code: "custom", path: ["reason"], message: "a correct run has no reason" });
    if (b.missing_label != null && b.reason !== "missing_field")
      ctx.addIssue({
        code: "custom",
        path: ["missing_label"],
        message: "only with reason missing_field",
      });
  });
export type DryRunReviewBody = z.infer<typeof DryRunReviewBodySchema>;

export interface DryRunReviewResult {
  run: DryRun;
  /** The typed missing label is now (or already was) an open Inbox wording. */
  inboxOpen: boolean;
}

/**
 * Sets or replaces the review (no history is kept). A `missing_field` label becomes a posting question of the run's
 * posting so that matching lists it in the Inbox and keeps it there. Returns null for an unknown run.
 */
export function reviewDryRun(
  db: Db,
  runId: string,
  body: DryRunReviewBody,
  now: Date = new Date(),
): DryRunReviewResult | null {
  const { missing_label: missing, ...input } = DryRunReviewBodySchema.parse(body);
  const run = db.select().from(dry_runs).where(eq(dry_runs.id, runId)).get();
  if (run === undefined) return null;
  const updated = setDryRunReview(db, runId, input, now);
  if (updated === null) return null;
  let inboxOpen = false;
  if (missing != null) {
    const normalized = normalizeQuestion(missing);
    if (normalized !== "") {
      const questionId = `owner-missing-${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
      db.insert(posting_questions)
        .values({
          id: `${run.posting_id}:${questionId}`,
          posting_id: run.posting_id,
          ats_type: run.ats_type,
          question_id: questionId,
          label: missing,
          required: false,
          type: "text",
          options: null,
          normalized_label: normalized,
          fetched_at: now.toISOString(),
        })
        .onConflictDoNothing()
        .run();
      matchQuestions(db);
      inboxOpen =
        db
          .select({ id: unknown_questions.id })
          .from(unknown_questions)
          .where(
            and(
              eq(unknown_questions.normalized_label, normalized),
              eq(unknown_questions.status, "open"),
            ),
          )
          .get() !== undefined;
    }
  }
  return { run: updated, inboxOpen };
}

/**
 * The screenshot file stored on a run, or null. The stored path must be relative, start with `dryruns/` and end in
 * `.png`; its realpath must be a regular file inside the realpath of `<data dir>/dryruns`. A `..`, an absolute path or
 * a symlink out of the dir gives null.
 */
export function resolveScreenshot(dataDir: string, stored: string | null): string | null {
  if (stored === null || stored === "" || stored.includes("\0") || stored.includes("\\"))
    return null;
  if (isAbsolute(stored) || stored.split("/").includes("..")) return null;
  if (!stored.startsWith(`${DRYRUNS_DIR}/`) || !stored.endsWith(".png")) return null;
  try {
    const root = realpathSync(join(dataDir, DRYRUNS_DIR));
    const file = realpathSync(join(dataDir, stored));
    if (!file.startsWith(root + sep)) return null;
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}
