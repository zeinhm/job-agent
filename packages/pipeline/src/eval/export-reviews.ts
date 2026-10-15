import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { intel, postings, reviews, type Db } from "@job-agent/core";
import { isDigestDate, jakartaDate } from "../digest/selection.ts";
import { ExtractionSchema } from "../intel/extract.ts";
import { reviewHistory } from "../review/record.ts";
import { reviewState } from "../review/state.ts";
import type { FitBand, FitCase, FitSet } from "./fit.ts";

/** `not_interested` reasons that say the role itself did not fit the CV; other reasons say nothing about fit. */
export const FIT_REASONS = ["role", "stack", "seniority"] as const;

export interface ExportReviewsOptions {
  args: string[];
  db: Db;
  /** The repository root: output may never land inside it outside `data/`. */
  repoRoot: string;
  now?: () => Date;
  out: (text: string) => void;
  err: (text: string) => void;
}

/** Real path of the nearest existing ancestor plus the rest, so a symlink cannot hide the real target. */
function realTarget(path: string): string {
  let existing = resolve(path);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    rest.unshift(existing.slice(dirname(existing).length + 1));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...rest);
}

const isInside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** True when `dir` is inside the repo but not inside its `data/` folder. */
export function isForbiddenOutDir(repoRoot: string, dir: string): boolean {
  const root = realTarget(repoRoot);
  const target = realTarget(dir);
  return isInside(root, target) && !isInside(join(root, "data"), target);
}

/** What the owner's decision says about fit: interested / applied -> high, role/stack/seniority skips -> low. */
function bandOfState(status: string, reason: string | null): FitBand | null {
  if (status === "interested" || status === "applied_manually") return "high";
  if (
    status === "not_interested" &&
    reason !== null &&
    (FIT_REASONS as readonly string[]).includes(reason)
  ) {
    return "low";
  }
  return null;
}

export interface ExportCounts {
  high: number;
  low: number;
  skippedReason: number;
  skippedNoText: number;
}

/** Builds the eval set from each posting's current review state. Pure over the DB; writes nothing. */
export function buildReviewSet(db: Db, since?: string): { set: FitSet; counts: ExportCounts } {
  const ids = db
    .selectDistinct({ id: reviews.posting_id })
    .from(reviews)
    .all()
    .map((r) => r.id);
  const history = reviewHistory(db, ids);
  const cases: FitCase[] = [];
  const counts: ExportCounts = { high: 0, low: 0, skippedReason: 0, skippedNoText: 0 };
  for (const id of [...ids].sort()) {
    const rows = history.get(id) ?? [];
    const state = reviewState(rows);
    if (state.status === "open" || state.status === "later") continue;
    const lastStatus = rows.findLast((r) => r.reviewed_at === state.reviewedAt);
    if (since !== undefined && (lastStatus?.review_day ?? "") < since) continue;
    const band = bandOfState(state.status, state.reason);
    if (band === null) {
      counts.skippedReason += 1;
      continue;
    }
    const row = db
      .select({ p: postings, extraction: intel.extraction })
      .from(postings)
      .leftJoin(intel, eq(intel.posting_id, postings.id))
      .where(eq(postings.id, id))
      .get();
    if (row === undefined || !row.p.description_text) {
      counts.skippedNoText += 1;
      continue;
    }
    // A posting without a (valid) stored extraction still has a review: its facts stay unknown for the run.
    const parsed = ExtractionSchema.safeParse(JSON.parse(row.extraction ?? "null"));
    cases.push({
      id,
      title: row.p.title,
      company: row.p.company_name,
      location: row.p.location_text,
      description: row.p.description_text,
      extraction: parsed.success ? parsed.data : {},
      expectedBand: band,
    });
    counts[band] += 1;
  }
  return { set: { version: 1, cases }, counts };
}

export const EXPORT_REVIEWS_HELP = `eval:export-reviews: writes your own fit eval set from your reviews.

usage: pnpm --filter @job-agent/pipeline eval:export-reviews [--since <YYYY-MM-DD>]

  interested, applied_manually            -> expected high
  not_interested (role/stack/seniority)   -> expected low
  every other reason or action            -> skipped

Writes data/eval/reviews-<date>.json (contains posting text: never commit it) and prints only the path and counts.
Then: pnpm --filter @job-agent/pipeline eval:fit --set data/eval/reviews-<date>.json --live
`;

/** Prints only the output path and counts, never posting text. */
export function runExportReviews(opts: ExportReviewsOptions): number {
  const { out, err } = opts;
  let values: { since?: string | undefined; "out-dir"?: string | undefined; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: opts.args,
      options: {
        since: { type: "string" },
        "out-dir": { type: "string" },
        help: { type: "boolean", default: false },
      },
    }));
  } catch (e) {
    err(`eval:export-reviews: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  if (values.help === true) {
    out(EXPORT_REVIEWS_HELP);
    return 0;
  }
  if (values.since !== undefined && !isDigestDate(values.since)) {
    err("eval:export-reviews: --since must be a date, YYYY-MM-DD\n");
    return 1;
  }
  const outDir = resolve(values["out-dir"] ?? join(opts.repoRoot, "data/eval"));
  if (isForbiddenOutDir(opts.repoRoot, outDir)) {
    err("eval:export-reviews: refusing to write inside the repository outside data/\n");
    return 1;
  }

  const { set, counts } = buildReviewSet(opts.db, values.since);
  if (set.cases.length === 0) {
    err(
      `eval:export-reviews: no usable reviews (skipped ${counts.skippedReason} by reason, ${counts.skippedNoText} without posting text); nothing written\n`,
    );
    return 1;
  }
  const path = join(outDir, `reviews-${jakartaDate((opts.now ?? (() => new Date()))())}.json`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(set, null, 2)}\n`, { mode: 0o600 });
  out(`eval:export-reviews: wrote ${path}\n`);
  out(
    `  cases ${set.cases.length} (high ${counts.high}, low ${counts.low}), skipped ${counts.skippedReason} by reason, ${counts.skippedNoText} without posting text\n`,
  );
  return 0;
}
