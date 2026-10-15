import {
  PartialSourceError,
  SourceBlockedError,
  SourceError,
  SourceSkippedError,
  log,
  type RawPosting,
  type SourceAdapter,
} from "@job-agent/core";
import { z } from "zod";
import { createSpawnRunner, type WorkerRunner, type WorkerSearch } from "./worker.ts";

type Site = "linkedin" | "indeed";

/**
 * Every search looks back from the last ok run of its source (`hours_old` is set in `fetch`, see `lookbackHours`).
 * Conventions section 8: at most 25 results, at least 10 s between the two searches.
 */
export const LINKEDIN_RESULTS_WANTED = 25;
export const SEARCH_GAP_MS = 10_000;
/** A full search is paged (offset += results_wanted) until a page is not full or the search holds this many results. */
export const MAX_RESULTS_PER_SEARCH = 100;
/** Assumption (decisions.md): one plain term; LinkedIn's guest endpoint has no remote filter, so "remote" is in the term. */
export const LINKEDIN_SEARCH_TERM = "senior frontend engineer react typescript remote";
export const LINKEDIN_SEARCHES: readonly WorkerSearch[] = [
  {
    site: "linkedin",
    search_term: LINKEDIN_SEARCH_TERM,
    location: "Worldwide",
    results_wanted: LINKEDIN_RESULTS_WANTED,
  },
  {
    site: "linkedin",
    search_term: LINKEDIN_SEARCH_TERM,
    location: "Indonesia",
    results_wanted: LINKEDIN_RESULTS_WANTED,
  },
];

/**
 * Indeed (research t_a46f63f1 Q2/Q4, conventions section 8): 2 searches per run, min poll interval 2 h.
 * The lookback window (`lookbackHours`) already overlaps the previous run (dedupe makes repeats free). Indeed has no global site:
 * the "global remote" search is country_indeed "usa" + is_remote (decisions.md). Indeed dates are whole UTC days, so
 * postings dated more than 48 h before the run are dropped in TS.
 */
export const INDEED_RESULTS_WANTED = 50;
export const INDEED_MIN_INTERVAL_MINUTES = 110;
export const INDEED_MAX_AGE_HOURS = 48;
export const INDEED_SEARCH_TERM = 'senior frontend OR "full stack" OR react OR typescript';
export const INDEED_SEARCHES: readonly WorkerSearch[] = [
  {
    site: "indeed",
    search_term: INDEED_SEARCH_TERM,
    is_remote: true,
    results_wanted: INDEED_RESULTS_WANTED,
    country: "usa",
  },
  {
    site: "indeed",
    search_term: INDEED_SEARCH_TERM,
    location: "Indonesia",
    is_remote: true,
    results_wanted: INDEED_RESULTS_WANTED,
    country: "indonesia",
  },
];

export const LOOKBACK_OVERLAP_MINUTES = 10;
export const MIN_LOOKBACK_HOURS = 1;
export const MAX_LOOKBACK_HOURS = 24;

/**
 * `hours_old` for a search: the time since `since` (the start of the last ok run, or the 7-day fallback) plus a
 * 10 min overlap, rounded up to whole hours, clamped to 1..24 h. A `since` in the future (clock skew) gives 1.
 */
export function lookbackHours(since: Date, now: Date): number {
  const minutes = (now.getTime() - since.getTime()) / 60_000 + LOOKBACK_OVERLAP_MINUTES;
  return Math.min(MAX_LOOKBACK_HOURS, Math.max(MIN_LOOKBACK_HOURS, Math.ceil(minutes / 60)));
}

const errorLineSchema = z.object({
  error: z.string(),
  kind: z.enum(["blocked", "error"]).default("error"),
});

const jobSchema = z.object({
  id: z.string().min(1).nullish(),
  site: z.enum(["linkedin", "indeed"]),
  job_url: z.url(),
  job_url_direct: z.url().nullish(),
  title: z.string().min(1),
  company: z.string().min(1),
  location: z.string().nullish(),
  date_posted: z
    .string()
    .nullish()
    .refine((s) => s == null || !Number.isNaN(Date.parse(s)), "invalid date"),
  is_remote: z.boolean().nullish(),
  min_amount: z.number().nullish(),
  max_amount: z.number().nullish(),
  currency: z.string().min(1).nullish(),
  interval: z.string().nullish(),
  description: z.string().nullish(),
});
type Job = z.infer<typeof jobSchema>;

/** weekly / daily intervals have no RawSalary period: the amount stays in salaryText only. */
const PERIODS: Record<string, "year" | "month" | "hour"> = {
  yearly: "year",
  monthly: "month",
  hourly: "hour",
};

/** JobSpy dates carry no zone ("2026-10-14T00:00:00.000" = the UTC date). */
function toIso(date: string): string {
  return new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(date) ? date : `${date}Z`).toISOString();
}

function externalIdOf(job: Job): string | null {
  if (job.id) return job.id.replace(/^(?:li|in)-/, "");
  if (job.site === "indeed") return new URL(job.job_url).searchParams.get("jk");
  return /\/jobs\/view\/(?:[^/?]*-)?(\d+)/.exec(job.job_url)?.[1] ?? null;
}

function toRawPosting(job: Job, externalId: string): RawPosting {
  const period = job.interval ? PERIODS[job.interval.toLowerCase()] : undefined;
  const hasAmount = job.min_amount != null || job.max_amount != null;
  const salary =
    hasAmount && job.currency && period
      ? {
          ...(job.min_amount != null ? { min: job.min_amount } : {}),
          ...(job.max_amount != null ? { max: job.max_amount } : {}),
          currency: job.currency,
          period,
        }
      : undefined;
  const salaryText = hasAmount
    ? `${job.currency ?? ""} ${[job.min_amount, job.max_amount].filter((n) => n != null).join("-")}${job.interval ? ` / ${job.interval}` : ""}`.trim()
    : undefined;
  return {
    source: job.site,
    externalId,
    url: job.job_url,
    ...(job.job_url_direct ? { applyUrl: job.job_url_direct } : {}),
    title: job.title,
    company: job.company,
    ...(job.description ? { descriptionText: job.description } : {}),
    ...(job.location ? { locationText: job.location } : {}),
    // LinkedIn's flag is a text heuristic ("remote" in title or location): true is a statement, false is not.
    // Indeed's remote searches also filter server side (fully remote, not hybrid).
    ...(job.is_remote === true ? { remote: true } : {}),
    ...(salaryText ? { salaryText } : {}),
    ...(salary ? { salary } : {}),
    ...(job.date_posted ? { postedAt: toIso(job.date_posted) } : {}),
  };
}

/** `bin/smoke --with-jobspy`: one search, at most 10 results. */
export const SMOKE_RESULTS_WANTED = 10;
export const JOBSPY_SMOKE_ENV = "JOB_AGENT_JOBSPY_SMOKE";

export interface JobspyAdapterOptions {
  /** The first search only, with results_wanted <= 10 (bin/smoke --with-jobspy). */
  smoke?: boolean;
  /** Defaults to spawning workers/jobspy/.venv/bin/python run.py. */
  runWorker?: WorkerRunner;
  python?: string;
  script?: string;
  timeoutMs?: number;
  /** Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock for the lookback window (both sites) and the Indeed age filter. */
  now?: () => Date;
}
export type LinkedInAdapterOptions = JobspyAdapterOptions;
export type IndeedAdapterOptions = JobspyAdapterOptions;

interface SiteConfig {
  source: Site;
  searches: readonly WorkerSearch[];
  minIntervalMinutes: number;
  /** Drops postings dated before now minus this many hours (postings without a date are kept). */
  maxAgeHours?: number;
}

export const createLinkedInAdapter = (opts: JobspyAdapterOptions = {}): SourceAdapter =>
  createJobspyAdapter(
    { source: "linkedin", searches: LINKEDIN_SEARCHES, minIntervalMinutes: 50 },
    opts,
  );

export const createIndeedAdapter = (opts: JobspyAdapterOptions = {}): SourceAdapter =>
  createJobspyAdapter(
    {
      source: "indeed",
      searches: INDEED_SEARCHES,
      minIntervalMinutes: INDEED_MIN_INTERVAL_MINUTES,
      maxAgeHours: INDEED_MAX_AGE_HOURS,
    },
    opts,
  );

function createJobspyAdapter(config: SiteConfig, opts: JobspyAdapterOptions): SourceAdapter {
  const SOURCE = config.source;
  const now = opts.now ?? (() => new Date());
  const runWorker =
    opts.runWorker ??
    createSpawnRunner({
      source: SOURCE,
      ...(opts.python ? { python: opts.python } : {}),
      ...(opts.script ? { script: opts.script } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const searches: readonly WorkerSearch[] = opts.smoke
    ? config.searches.slice(0, 1).map((x) => ({ ...x, results_wanted: SMOKE_RESULTS_WANTED }))
    : config.searches;
  let warnings: string[] = [];
  let saturated = 0;

  /** One search; returns its postings, or throws (block -> SourceBlockedError). */
  async function search(
    s: WorkerSearch,
  ): Promise<{ postings: RawPosting[]; malformed: number; lineCount: number }> {
    const { exitCode, stdout } = await runWorker(s);
    const lines = stdout.split("\n").filter((l) => l.trim() !== "");
    if (exitCode !== 0) {
      let errorLine: z.infer<typeof errorLineSchema> | undefined;
      for (const line of lines) {
        try {
          const r = errorLineSchema.safeParse(JSON.parse(line));
          if (r.success) errorLine = r.data;
        } catch {
          // not JSON: ignored, the exit code is reported below
        }
      }
      if (errorLine?.kind === "blocked") {
        throw new SourceBlockedError(SOURCE, errorLine.error);
      }
      throw new SourceError(
        SOURCE,
        errorLine ? `jobspy worker failed: ${errorLine.error}` : `jobspy worker exited ${exitCode}`,
      );
    }
    const postings: RawPosting[] = [];
    let malformed = 0;
    for (const line of lines) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        malformed++;
        log.warn("Skipping malformed JobSpy line", { source: SOURCE, issue: "not json" });
        continue;
      }
      const parsed = jobSchema.safeParse(value);
      const externalId = parsed.success ? externalIdOf(parsed.data) : null;
      if (!parsed.success || externalId === null) {
        malformed++;
        log.warn("Skipping invalid JobSpy job", {
          source: SOURCE,
          path: parsed.success ? "id" : parsed.error.issues[0]?.path.join("."),
          issue: parsed.success ? "no id" : parsed.error.issues[0]?.code,
        });
        continue;
      }
      postings.push(toRawPosting(parsed.data, externalId));
    }
    if (malformed * 2 > lines.length) {
      throw new SourceError(SOURCE, `${malformed} of ${lines.length} worker lines invalid`);
    }
    return { postings, malformed, lineCount: lines.length };
  }

  /** Indeed dates are whole days (research Q4), so its server-side window is coarse: filter here too. */
  function fresh(p: RawPosting): boolean {
    if (config.maxAgeHours === undefined || !p.postedAt) return true;
    return Date.parse(p.postedAt) >= now().getTime() - config.maxAgeHours * 3_600_000;
  }

  return {
    name: SOURCE,
    minIntervalMinutes: config.minIntervalMinutes,
    async fetch(since: Date): Promise<RawPosting[]> {
      warnings = [];
      const hoursOld = lookbackHours(since, now());
      const byId = new Map<string, RawPosting>();
      let malformedTotal = 0;
      saturated = 0;
      let calls = 0;
      for (const s of searches) {
        let offset = 0;
        let full = true;
        // Paging: while the last page was full and the 100-result ceiling is not reached.
        for (
          let page = 0;
          full && (opts.smoke ? page === 0 : offset + s.results_wanted <= MAX_RESULTS_PER_SEARCH);
          page++
        ) {
          if (calls++ > 0) await sleep(SEARCH_GAP_MS);
          try {
            const result = await search({
              ...s,
              hours_old: hoursOld,
              ...(offset > 0 ? { offset } : {}),
            });
            malformedTotal += result.malformed;
            for (const p of result.postings) if (!byId.has(p.externalId)) byId.set(p.externalId, p);
            full = result.lineCount >= s.results_wanted;
            if (page === 0 && full) saturated++;
            offset += s.results_wanted;
          } catch (err) {
            // No retry, no further page or search after a failure; keep what was collected.
            if (err instanceof SourceBlockedError) {
              throw new SourceBlockedError(SOURCE, err.message.replace(`[${SOURCE}] `, ""), [
                ...byId.values(),
              ]);
            }
            if (
              err instanceof SourceError &&
              !(err instanceof SourceSkippedError) &&
              byId.size > 0
            ) {
              throw new PartialSourceError(SOURCE, err.message.replace(`[${SOURCE}] `, ""), [
                ...byId.values(),
              ]);
            }
            throw err;
          }
        }
      }
      if (malformedTotal > 0) warnings.push(`${malformedTotal} malformed worker line(s) skipped`);
      return [...byId.values()].filter(fresh);
    },
    takeSaturated() {
      return saturated;
    },
    takeWarnings() {
      const w = warnings;
      warnings = [];
      return w;
    },
  };
}
