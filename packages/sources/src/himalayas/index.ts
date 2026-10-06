import {
  SourceError,
  httpGetJson,
  log,
  type RawPosting,
  type RawSalary,
  type SourceAdapter,
} from "@job-agent/core";
import { z } from "zod";

const SOURCE = "himalayas";
const BASE_URL = "https://himalayas.app/jobs/api";
const PAGE_SIZE = 20;
const MAX_PAGES = 10;
const MIN_INTERVAL_MINUTES = 60;

const envelopeSchema = z.object({
  jobs: z.array(z.unknown()),
  nextCursor: z.string().min(1).nullish(),
});

const himalayasJobSchema = z.object({
  guid: z.string().min(1),
  title: z.string().min(1),
  companyName: z.string().min(1),
  applicationLink: z.string().min(1),
  description: z.string().nullish(),
  pubDate: z.number().int().nonnegative().nullish(),
  minSalary: z.number().nullish(),
  maxSalary: z.number().nullish(),
  currency: z.string().min(1).nullish(),
  salaryPeriod: z.string().nullish(),
  locationRestrictions: z.array(z.string()).nullish(),
  timezoneRestrictions: z.array(z.number()).nullish(),
  categories: z.array(z.string()).nullish(),
  parentCategories: z.array(z.string()).nullish(),
});
type HimalayasJob = z.infer<typeof himalayasJobSchema>;

const PERIOD_BY_NAME: Record<string, RawSalary["period"]> = {
  annual: "year",
  monthly: "month",
  hourly: "hour",
};

function mapSalary(job: HimalayasJob): RawSalary | undefined {
  const period = job.salaryPeriod ? PERIOD_BY_NAME[job.salaryPeriod] : undefined;
  if (!period || !job.currency) return undefined;
  if (job.minSalary == null && job.maxSalary == null) return undefined;
  return {
    ...(job.minSalary != null && { min: job.minSalary }),
    ...(job.maxSalary != null && { max: job.maxSalary }),
    currency: job.currency,
    period,
  };
}

function formatOffset(hours: number): string {
  return `UTC${hours < 0 ? "-" : "+"}${Math.abs(hours)}`;
}

/** An empty country list means worldwide on Himalayas; timezones are listed only when present. */
function buildLocationText(job: HimalayasJob): string {
  const countries = job.locationRestrictions ?? [];
  const timezones = job.timezoneRestrictions ?? [];
  const parts = [`Countries: ${countries.length > 0 ? countries.join(", ") : "Worldwide"}`];
  if (timezones.length > 0) parts.push(`Timezones: ${timezones.map(formatOffset).join(", ")}`);
  return parts.join("; ");
}

function mapJob(job: HimalayasJob): RawPosting {
  const salary = mapSalary(job);
  const tags = [...(job.categories ?? []), ...(job.parentCategories ?? [])];
  return {
    source: SOURCE,
    externalId: job.guid,
    url: job.applicationLink,
    title: job.title,
    company: job.companyName,
    ...(job.description && { descriptionHtml: job.description }),
    locationText: buildLocationText(job),
    ...(salary && { salary }),
    ...(job.pubDate != null && { postedAt: new Date(job.pubDate * 1000).toISOString() }),
    ...(tags.length > 0 && { tags }),
  };
}

async function fetchPage(cursor: string | undefined) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor) params.set("cursor", cursor);
  let body: unknown;
  try {
    body = await httpGetJson(`${BASE_URL}?${params.toString()}`);
  } catch (err) {
    throw new SourceError(SOURCE, "request failed", { cause: err });
  }
  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) {
    throw new SourceError(SOURCE, "invalid response envelope", { cause: envelope.error });
  }
  return envelope.data;
}

export function createHimalayasAdapter(): SourceAdapter {
  return {
    name: SOURCE,
    minIntervalMinutes: MIN_INTERVAL_MINUTES,
    async fetch(since: Date): Promise<RawPosting[]> {
      const results: RawPosting[] = [];
      let seen = 0;
      let invalid = 0;
      let cursor: string | undefined;

      // The feed is newest-first: once a page reaches items older than `since`, later pages are older still.
      for (let page = 0; page < MAX_PAGES; page++) {
        const { jobs, nextCursor } = await fetchPage(cursor);
        let reachedOlder = false;
        for (const item of jobs) {
          seen++;
          const parsed = himalayasJobSchema.safeParse(item);
          if (!parsed.success) {
            invalid++;
            const guid =
              typeof item === "object" && item !== null && "guid" in item
                ? String(item.guid)
                : undefined;
            log.warn("himalayas: skipping invalid job", {
              source: SOURCE,
              externalId: guid,
              path: parsed.error.issues[0]?.path.join("."),
            });
            continue;
          }
          const posting = mapJob(parsed.data);
          if (posting.postedAt !== undefined && new Date(posting.postedAt) < since) {
            reachedOlder = true;
            continue;
          }
          results.push(posting);
        }
        if (reachedOlder || !nextCursor || jobs.length === 0) break;
        cursor = nextCursor;
      }

      if (invalid * 2 > seen) {
        throw new SourceError(SOURCE, `${invalid} of ${seen} jobs invalid`);
      }
      return results;
    },
  };
}
