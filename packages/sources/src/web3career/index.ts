import {
  SourceError,
  httpGetJson,
  log,
  type RawPosting,
  type RawSalary,
  type SourceAdapter,
} from "@job-agent/core";
import { z } from "zod";

const SOURCE = "web3career";
const BASE_URL = "https://web3.career/api/v1";
const TOKEN_ENV = "WEB3_CAREER_TOKEN";
const LIMIT = 100;
const MIN_INTERVAL_MINUTES = 5;

const idSchema = z.union([z.string().min(1), z.number().int()]).transform(String);

const web3JobSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  company: z.string().min(1),
  url: z.string().min(1),
  apply_url: z.string().min(1).nullish(),
  description: z.string().nullish(),
  location: z.string().nullish(),
  remote: z.boolean().nullish(),
  salary: z.string().nullish(),
  salary_min: z.number().nullish(),
  salary_max: z.number().nullish(),
  salary_currency: z.string().nullish(),
  salary_period: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  posted_at: z.string().nullish(),
  date_epoch: z.number().nonnegative().nullish(),
});
type Web3Job = z.infer<typeof web3JobSchema>;

const PERIODS = new Set<string>(["year", "month", "hour"]);

function mapSalary(job: Web3Job): RawSalary | undefined {
  if (job.salary_min == null && job.salary_max == null) return undefined;
  const period = job.salary_period || "year";
  if (!PERIODS.has(period)) return undefined;
  return {
    ...(job.salary_min != null && { min: job.salary_min }),
    ...(job.salary_max != null && { max: job.salary_max }),
    currency: job.salary_currency || "USD",
    period: period as RawSalary["period"],
  };
}

function mapPostedAt(job: Web3Job): string | undefined {
  if (job.date_epoch != null && job.date_epoch > 0) {
    return new Date(job.date_epoch * 1000).toISOString();
  }
  if (job.posted_at) {
    const date = new Date(job.posted_at);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return undefined;
}

function mapJob(job: Web3Job): RawPosting {
  const salary = mapSalary(job);
  const postedAt = mapPostedAt(job);
  const tags = (job.tags ?? []).filter((t) => t.length > 0);
  return {
    source: SOURCE,
    externalId: job.id,
    url: job.url,
    ...(job.apply_url && { applyUrl: job.apply_url }),
    title: job.title,
    company: job.company,
    ...(job.description && { descriptionHtml: job.description }),
    ...(job.location && { locationText: job.location }),
    ...(job.remote != null && { remote: job.remote }),
    ...(job.salary && { salaryText: job.salary }),
    ...(salary && { salary }),
    ...(postedAt && { postedAt }),
    ...(tags.length > 0 && { tags }),
  };
}

/** The API returns a mixed root array (strings, then the jobs array); find the nested array. */
function extractItems(body: unknown): unknown[] {
  if (!Array.isArray(body)) {
    throw new SourceError(SOURCE, "invalid response envelope: root is not an array");
  }
  const items = body.find((entry): entry is unknown[] => Array.isArray(entry));
  if (!items) {
    throw new SourceError(SOURCE, "invalid response envelope: no nested jobs array");
  }
  return items;
}

function parseJobs(items: unknown[]): RawPosting[] {
  const postings: RawPosting[] = [];
  let invalid = 0;
  for (const item of items) {
    const parsed = web3JobSchema.safeParse(item);
    if (!parsed.success) {
      invalid++;
      const externalId =
        typeof item === "object" && item !== null && "id" in item ? String(item.id) : undefined;
      log.warn("web3career: skipping invalid job", {
        source: SOURCE,
        externalId,
        path: parsed.error.issues[0]?.path.join("."),
      });
      continue;
    }
    postings.push(mapJob(parsed.data));
  }
  if (invalid * 2 > items.length) {
    throw new SourceError(SOURCE, `${invalid} of ${items.length} jobs invalid`);
  }
  return postings;
}

export function buildRequestUrl(token: string): string {
  const params = new URLSearchParams({
    token,
    remote: "true",
    limit: String(LIMIT),
    show_description: "true",
  });
  return `${BASE_URL}?${params.toString()}`;
}

export function createWeb3CareerAdapter(): SourceAdapter {
  return {
    name: SOURCE,
    minIntervalMinutes: MIN_INTERVAL_MINUTES,
    async fetch(since: Date): Promise<RawPosting[]> {
      const token = process.env[TOKEN_ENV];
      if (!token) throw new SourceError(SOURCE, `${TOKEN_ENV} not set`);

      let body: unknown;
      try {
        body = await httpGetJson(buildRequestUrl(token));
      } catch (err) {
        // No cause: HttpError keeps the raw URL (with the token) in its fields.
        const status = (err as { status?: number | null }).status;
        throw new SourceError(SOURCE, `request failed (HTTP ${status ?? "network error"})`);
      }

      return parseJobs(extractItems(body)).filter(
        (p) => p.postedAt === undefined || new Date(p.postedAt) >= since,
      );
    },
  };
}
