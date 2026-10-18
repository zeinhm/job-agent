import { existsSync } from "node:fs";
import {
  analysis,
  apply_links,
  DRY_RUN_STATUSES,
  dry_runs,
  openDbReadonly,
  postings,
  type Db,
} from "@job-agent/core";
import {
  errorLine,
  isDryRunCandidate,
  loadFillContext,
  loadStoredQuestions,
  planFill,
  refusalLine,
  sanitizeText,
} from "@job-agent/apply";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { atsLinkOf, effectiveApplyUrl } from "./apply-links/ats-links.ts";
import { ashbyFormUrl, formUrl, leverFormUrl, storedGreenhouseSlug } from "./dry-run.ts";

const COMMAND = "dry-run-candidates";

export const DRY_RUN_CANDIDATES_USAGE = "Usage: job-agent dry-run-candidates [--limit <n>]\n";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 200;

export type CandidateAts = "greenhouse" | "lever" | "ashby";

export interface OperatorCandidate {
  postingId: string;
  ats: CandidateAts;
  /** Sanitised for one output line. */
  title: string;
  /** Stored questions; null before a first run of a Lever / Ashby posting (the run stores what its page shows). */
  questions: number | null;
  /** Questions the fill plan cannot cover (no approved answer, no approved choice mapping, no tier ask); null with `questions`. */
  missing: number | null;
  /** Status of the newest real (non-fixture) dry run; null when there is none. */
  lastRun: (typeof DRY_RUN_STATUSES)[number] | null;
  /** Tie-break for the order, not printed. */
  firstSeenAt: string;
}

// Only these columns are read; a row that does not fit its schema throws before anything is printed.
const PostingRow = z.object({
  id: z.string().min(1),
  title: z.string(),
  company_id: z.string().nullable(),
  url: z.string(),
  apply_url: z.string().nullable(),
  first_seen_at: z.string().min(1),
  link_url: z.string().nullable(),
  link_ats_type: z.string().nullable(),
  link_ats_slug: z.string().nullable(),
});
const RunStatus = z.enum(DRY_RUN_STATUSES);

/** Canonical postings the pipeline kept, one row each, with the columns the rule needs. */
function keptPostings(db: Db, postingId: string | undefined): PostingRowT[] {
  return db
    .select({
      id: postings.id,
      title: postings.title,
      company_id: postings.company_id,
      url: postings.url,
      apply_url: postings.apply_url,
      first_seen_at: postings.first_seen_at,
      link_url: apply_links.apply_url,
      link_ats_type: apply_links.ats_type,
      link_ats_slug: apply_links.ats_slug,
    })
    .from(postings)
    .innerJoin(analysis, eq(analysis.posting_id, postings.id))
    .leftJoin(apply_links, eq(apply_links.posting_id, postings.id))
    .where(
      and(
        isNull(postings.canonical_posting_id),
        eq(analysis.decision, "keep"),
        ...(postingId === undefined ? [] : [eq(postings.id, postingId)]),
      ),
    )
    .orderBy(asc(postings.id))
    .all()
    .map((r) => PostingRow.parse(r));
}
type PostingRowT = z.infer<typeof PostingRow>;

/** The candidate for one kept posting, or null when any exclusion applies. */
function evaluate(db: Db, p: PostingRowT): OperatorCandidate | null {
  // Decision 4 (kept by intel, not scam-flagged, not not_interested / applied_manually): the one rule O1 uses.
  if (!isDryRunCandidate(db, p.id)) return null;

  // The link `dry-run <posting-id>` would open (same order, same checks).
  const link = atsLinkOf(effectiveApplyUrl(p.link_url, p.apply_url, p.url));
  if (
    link === null ||
    (link.vendor !== "greenhouse" && link.vendor !== "lever" && link.vendor !== "ashby") ||
    link.kind !== "job"
  )
    return null;
  const ats = link.vendor;
  const url =
    ats === "ashby"
      ? ashbyFormUrl(link)
      : ats === "lever"
        ? leverFormUrl(link)
        : formUrl(
            link,
            storedGreenhouseSlug(
              db,
              { ats_type: p.link_ats_type, ats_slug: p.link_ats_slug },
              p.company_id,
            ),
          );
  if (url === null) return null;

  const ctx = loadFillContext(db, p.id);

  const fields = loadStoredQuestions(db, p.id, ats);
  // `dry-run` refuses a Greenhouse posting without stored questions (fetch-questions has not run).
  if (ats === "greenhouse" && fields.length === 0) return null;

  let questions: number | null = null;
  let missing: number | null = null;
  if (fields.length > 0) {
    questions = fields.length;
    const plan = planFill({ fields, ...ctx });
    // A stop (unsupported field, ambiguous wording) means no field would be filled.
    missing = plan.kind === "fill" ? plan.fields.filter((f) => !f.filled).length : fields.length;
  }

  const last = db
    .select({ status: dry_runs.status })
    .from(dry_runs)
    .where(and(eq(dry_runs.posting_id, p.id), eq(dry_runs.fixture, false)))
    .orderBy(desc(dry_runs.started_at), desc(dry_runs.id))
    .limit(1)
    .get();

  return {
    postingId: p.id,
    ats,
    title: sanitizeText(p.title),
    questions,
    missing,
    lastRun: last === undefined ? null : RunStatus.parse(last.status),
    firstSeenAt: p.first_seen_at,
  };
}

/** Decision 4 (`isDryRunCandidate`, shared with `operator-dry-run`; no intel row fails it) plus the list's own checks. */
export function isOperatorCandidate(db: Db, postingId: string): boolean {
  return keptPostings(db, postingId).some((p) => evaluate(db, p) !== null);
}

const atsRank = (c: OperatorCandidate): number => (c.ats === "ashby" ? 1 : 0);

/**
 * Greenhouse and Lever before Ashby (never a full fill), then postings with a known question count before those with
 * none stored, fewest missing, newest first, id as the last tie-break.
 */
export function compareCandidates(a: OperatorCandidate, b: OperatorCandidate): number {
  return (
    atsRank(a) - atsRank(b) ||
    Number(a.missing === null) - Number(b.missing === null) ||
    (a.missing ?? 0) - (b.missing ?? 0) ||
    (a.firstSeenAt < b.firstSeenAt ? 1 : a.firstSeenAt > b.firstSeenAt ? -1 : 0) ||
    (a.postingId < b.postingId ? -1 : a.postingId > b.postingId ? 1 : 0)
  );
}

/** Every posting the operator may dry-run, in the owner's order. Read-only. */
export function listOperatorCandidates(db: Db): OperatorCandidate[] {
  return keptPostings(db, undefined)
    .map((p) => evaluate(db, p))
    .filter((c): c is OperatorCandidate => c !== null)
    .sort(compareCandidates);
}

const limitArg = z
  .string()
  .regex(/^\d{1,3}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(MAX_LIMIT));

/** What `util.parseArgs` returned in cli.ts, or null when it threw (its message quotes what was typed). */
export interface CandidatesArgs {
  values: { limit?: string | undefined };
  positionals: string[];
}

function parseLimit(raw: CandidatesArgs | null): number | null {
  if (raw === null || raw.positionals.length > 0) return null;
  if (raw.values.limit === undefined) return DEFAULT_LIMIT;
  const r = limitArg.safeParse(raw.values.limit);
  return r.success ? r.data : null;
}

const q = (text: string): string => JSON.stringify(sanitizeText(text));

export interface DryRunCandidatesOptions {
  args: CandidatesArgs | null;
  dbPath: string;
  out: (text: string) => void;
  err: (text: string) => void;
}

/** Read-only list of the postings the operator may dry-run. Prints ids, ATS, title and counts, never a value. */
export function runDryRunCandidates(o: DryRunCandidatesOptions): number {
  const limit = parseLimit(o.args);
  if (limit === null) {
    o.err(refusalLine(COMMAND, "invalid arguments") + DRY_RUN_CANDIDATES_USAGE);
    return 1;
  }
  if (!existsSync(o.dbPath)) {
    o.err(refusalLine(COMMAND, "database not found"));
    return 1;
  }
  let db: Db | undefined;
  try {
    db = openDbReadonly(o.dbPath);
    // Everything is built before anything is printed: a corrupt row prints no partial list.
    const lines = listOperatorCandidates(db)
      .slice(0, limit)
      .map(
        (c) =>
          `posting=${q(c.postingId)} ats=${c.ats} title=${JSON.stringify(c.title)} ` +
          `questions=${c.questions ?? "?"} missing=${c.missing ?? "?"} last=${c.lastRun ?? "-"}`,
      );
    o.out(lines.length === 0 ? `${COMMAND}: no candidates\n` : `${lines.join("\n")}\n`);
    return 0;
  } catch (e) {
    o.err(errorLine(COMMAND, e));
    return 1;
  } finally {
    db?.$client.close();
  }
}
