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

const SOURCE = "linkedin";

/** Conventions section 8: past hour, at most 25 results, at least 10 s between the two searches. */
export const LINKEDIN_HOURS_OLD = 1;
export const LINKEDIN_RESULTS_WANTED = 25;
export const SEARCH_GAP_MS = 10_000;
/** Assumption (decisions.md): one plain term; LinkedIn's guest endpoint has no remote filter, so "remote" is in the term. */
export const LINKEDIN_SEARCH_TERM = "senior frontend engineer react typescript remote";
export const LINKEDIN_SEARCHES: readonly WorkerSearch[] = [
  {
    site: "linkedin",
    search_term: LINKEDIN_SEARCH_TERM,
    location: "Worldwide",
    hours_old: LINKEDIN_HOURS_OLD,
    results_wanted: LINKEDIN_RESULTS_WANTED,
  },
  {
    site: "linkedin",
    search_term: LINKEDIN_SEARCH_TERM,
    location: "Indonesia",
    hours_old: LINKEDIN_HOURS_OLD,
    results_wanted: LINKEDIN_RESULTS_WANTED,
  },
];

const errorLineSchema = z.object({
  error: z.string(),
  kind: z.enum(["blocked", "error"]).default("error"),
});

const jobSchema = z.object({
  id: z.string().min(1).nullish(),
  site: z.literal("linkedin"),
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
  if (job.id) return job.id.replace(/^li-/, "");
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
    source: SOURCE,
    externalId,
    url: job.job_url,
    ...(job.job_url_direct ? { applyUrl: job.job_url_direct } : {}),
    title: job.title,
    company: job.company,
    ...(job.description ? { descriptionText: job.description } : {}),
    ...(job.location ? { locationText: job.location } : {}),
    // LinkedIn's flag is a text heuristic ("remote" in title or location): true is a statement, false is not.
    ...(job.is_remote === true ? { remote: true } : {}),
    ...(salaryText ? { salaryText } : {}),
    ...(salary ? { salary } : {}),
    ...(job.date_posted ? { postedAt: toIso(job.date_posted) } : {}),
  };
}

/** `bin/smoke --with-jobspy`: one search, at most 10 results. */
export const SMOKE_RESULTS_WANTED = 10;
export const JOBSPY_SMOKE_ENV = "JOB_AGENT_JOBSPY_SMOKE";

export interface LinkedInAdapterOptions {
  /** One Worldwide search with results_wanted <= 10 (bin/smoke --with-jobspy). */
  smoke?: boolean;
  /** Defaults to spawning workers/jobspy/.venv/bin/python run.py. */
  runWorker?: WorkerRunner;
  python?: string;
  script?: string;
  timeoutMs?: number;
  /** Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export function createLinkedInAdapter(opts: LinkedInAdapterOptions = {}): SourceAdapter {
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
    ? LINKEDIN_SEARCHES.slice(0, 1).map((x) => ({ ...x, results_wanted: SMOKE_RESULTS_WANTED }))
    : LINKEDIN_SEARCHES;
  let warnings: string[] = [];

  /** One search; returns its postings, or throws (block -> SourceBlockedError). */
  async function search(s: WorkerSearch): Promise<{ postings: RawPosting[]; malformed: number }> {
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
    return { postings, malformed };
  }

  return {
    name: SOURCE,
    minIntervalMinutes: 50,
    async fetch(): Promise<RawPosting[]> {
      warnings = [];
      const byId = new Map<string, RawPosting>();
      let malformedTotal = 0;
      for (const [i, s] of searches.entries()) {
        if (i > 0) await sleep(SEARCH_GAP_MS);
        try {
          const result = await search(s);
          malformedTotal += result.malformed;
          for (const p of result.postings) if (!byId.has(p.externalId)) byId.set(p.externalId, p);
        } catch (err) {
          // No retry, no second search after a failure; keep what the first search returned.
          if (err instanceof SourceBlockedError) {
            throw new SourceBlockedError(SOURCE, err.message.replace(`[${SOURCE}] `, ""), [
              ...byId.values(),
            ]);
          }
          if (err instanceof SourceError && !(err instanceof SourceSkippedError) && byId.size > 0) {
            throw new PartialSourceError(SOURCE, err.message.replace(`[${SOURCE}] `, ""), [
              ...byId.values(),
            ]);
          }
          throw err;
        }
      }
      if (malformedTotal > 0) warnings.push(`${malformedTotal} malformed worker line(s) skipped`);
      return [...byId.values()];
    },
    takeWarnings() {
      const w = warnings;
      warnings = [];
      return w;
    },
  };
}
