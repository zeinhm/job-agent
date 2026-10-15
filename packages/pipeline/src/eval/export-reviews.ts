import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { asc, inArray } from "drizzle-orm";
import { postings, reviews, type Db } from "@job-agent/core";
import { isDigestDate, jakartaDate } from "../review/index.ts";
import { reviewState } from "../review/state.ts";
import type { FitBand, FitSet } from "./fit.ts";

/** Not-interested reasons that say the posting did not fit the profile; every other reason says nothing about fit. */
export const FIT_LOW_REASONS: readonly string[] = ["role", "stack", "seniority"];

export const EXPORT_HELP = `eval:export-reviews: writes your review decisions as an eval set for eval:fit.

Usage: pnpm --filter @job-agent/pipeline eval:export-reviews [--since YYYY-MM-DD] [--out-dir <dir>]

  interested, applied_manually                -> expected high
  not_interested (role, stack, seniority)     -> expected low
  every other decision is skipped

Writes data/eval/reviews-<date>.json (gitignored, contains posting text) and prints only the path and counts.
Refuses to write inside the repo outside data/. Then run:
  pnpm --filter @job-agent/pipeline eval:fit --set data/eval/reviews-<date>.json --live
`;

export interface ExportReviewsOptions {
  args: string[];
  openDb: () => Db;
  /** Repo root: the only place under which writing is limited to `data/`. */
  repoRoot: string;
  /** Base for a relative `--out-dir`. */
  cwd?: string;
  now?: () => Date;
  out: (text: string) => void;
  err: (text: string) => void;
}

/** Resolves symlinks of the deepest existing ancestor, so a link out of `data/` cannot hide the real target. */
function realTarget(path: string): string {
  const abs = resolve(path);
  let existing = abs;
  while (!existsSync(existing)) existing = dirname(existing);
  return join(realpathSync(existing), relative(existing, abs));
}

const isInside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

export function runExportReviews(opts: ExportReviewsOptions): number {
  const { out, err } = opts;
  const now = opts.now ?? (() => new Date());

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
    out(EXPORT_HELP);
    return 0;
  }
  if (values.since !== undefined && !isDigestDate(values.since)) {
    err(`eval:export-reviews: invalid --since ${values.since}, expected YYYY-MM-DD\n`);
    return 1;
  }

  const repoRoot = realTarget(opts.repoRoot);
  const outDir = realTarget(
    values["out-dir"] === undefined
      ? join(opts.repoRoot, "data", "eval")
      : resolve(opts.cwd ?? process.cwd(), values["out-dir"]),
  );
  if (isInside(outDir, repoRoot) && !isInside(outDir, join(repoRoot, "data"))) {
    err("eval:export-reviews: refusing to write inside the repo outside data/\n");
    return 1;
  }

  const db = opts.openDb();
  const history = db
    .select({
      posting_id: reviews.posting_id,
      action: reviews.action,
      reason: reviews.reason,
      reviewed_at: reviews.reviewed_at,
    })
    .from(reviews)
    .orderBy(asc(reviews.reviewed_at), asc(reviews.id))
    .all();
  const byPosting = new Map<string, typeof history>();
  for (const h of history) byPosting.set(h.posting_id, [...(byPosting.get(h.posting_id) ?? []), h]);

  const expectedBy = new Map<string, FitBand>();
  let skipped = 0;
  for (const [id, rows] of byPosting) {
    const state = reviewState(rows);
    if (!state.processed || state.reviewedAt === null) continue;
    if (values.since !== undefined && jakartaDate(new Date(state.reviewedAt)) < values.since)
      continue;
    if (state.status === "interested" || state.status === "applied_manually") {
      expectedBy.set(id, "high");
    } else if (
      state.status === "not_interested" &&
      state.reason !== null &&
      FIT_LOW_REASONS.includes(state.reason)
    ) {
      expectedBy.set(id, "low");
    } else {
      skipped += 1;
    }
  }

  const rows =
    expectedBy.size === 0
      ? []
      : db
          .select()
          .from(postings)
          .where(inArray(postings.id, [...expectedBy.keys()]))
          .orderBy(asc(postings.id))
          .all();
  const cases: FitSet["cases"] = [];
  let noText = 0;
  for (const p of rows) {
    const expected = expectedBy.get(p.id);
    if (expected === undefined) continue;
    if (p.description_text === null || p.description_text.trim() === "") {
      noText += 1;
      continue;
    }
    cases.push({
      id: p.id,
      title: p.title,
      company: p.company_name,
      location: p.location_text,
      salaryText: p.salary_text,
      description: p.description_text,
      expected,
    });
  }
  if (cases.length === 0) {
    err(
      `eval:export-reviews: no usable reviews (skipped ${skipped}, without posting text ${noText})\n`,
    );
    return 1;
  }

  const set: FitSet = { version: 1, persona: "owner", cases };
  const path = join(outDir, `reviews-${jakartaDate(now())}.json`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(set, null, 2)}\n`);

  const high = cases.filter((c) => c.expected === "high").length;
  out(`${path}\n`);
  out(
    `eval:export-reviews: ${cases.length} cases (high ${high}, low ${cases.length - high}), skipped ${skipped}, without posting text ${noText}\n`,
  );
  return 0;
}
