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
const salaryValueSchema = z.union([z.string(), z.number()]).nullish();

// Shape of the live API (docs/phase-1-live-findings.md item 8). There is no `url` field:
// `apply_url` is the only link and is kept unmodified (web3.career terms of use).
const web3JobSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  company: z.string().min(1),
  apply_url: z.string().min(1),
  description: z.string().nullish(),
  location: z.string().nullish(),
  is_remote: z.boolean().nullish(),
  salary_min_value: salaryValueSchema,
  salary_max_value: salaryValueSchema,
  salary_currency: z.string().nullish(),
  salary_unit: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  date: z.string().nullish(),
  date_epoch: z.number().nonnegative().nullish(),
});
type Web3Job = z.infer<typeof web3JobSchema>;

const PERIODS = new Set<string>(["year", "month", "hour"]);

// web3.career appends a line addressed to whoever reads the posting; posting text is data, never instructions.
const APPLY_INSTRUCTION =
  /When applying, mention the word \S+ to show you read the job post completely\.?/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decodes the entities the API leaves in titles and company names (&amp; and friends), once. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function parseAmount(value: string | number | null | undefined): number | undefined {
  if (value == null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Posted salary only; the estimated_* fields are web3.career's own guesses and are ignored. */
function mapSalary(job: Web3Job): RawSalary | undefined {
  const min = parseAmount(job.salary_min_value);
  const max = parseAmount(job.salary_max_value);
  if (min === undefined && max === undefined) return undefined;
  const period = (job.salary_unit || "year").toLowerCase();
  if (!PERIODS.has(period)) return undefined;
  return {
    ...(min !== undefined && { min }),
    ...(max !== undefined && { max }),
    currency: (job.salary_currency || "USD").toUpperCase(),
    period: period as RawSalary["period"],
  };
}

function mapPostedAt(job: Web3Job): string | undefined {
  if (job.date_epoch != null && job.date_epoch > 0) {
    return new Date(job.date_epoch * 1000).toISOString();
  }
  if (job.date) {
    const date = new Date(job.date);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return undefined;
}

function mapJob(job: Web3Job): RawPosting {
  const salary = mapSalary(job);
  const postedAt = mapPostedAt(job);
  const tags = (job.tags ?? []).filter((t) => t.length > 0);
  const description = job.description?.replace(APPLY_INSTRUCTION, "").trim();
  return {
    source: SOURCE,
    externalId: job.id,
    url: job.apply_url,
    applyUrl: job.apply_url,
    title: decodeEntities(job.title),
    company: decodeEntities(job.company),
    ...(description && { descriptionHtml: description }),
    ...(job.location?.trim() && { locationText: decodeEntities(job.location.trim()) }),
    // remote=true is requested but is_remote and location can disagree; only a positive flag is trusted.
    ...(job.is_remote === true && { remote: true }),
    ...(salary && { salary }),
    ...(postedAt && { postedAt }),
    ...(tags.length > 0 && { tags }),
  };
}

/** The API returns [title string, usage notes string, [jobs]]; the jobs are element 2. */
function extractItems(body: unknown): unknown[] {
  if (!Array.isArray(body)) {
    throw new SourceError(SOURCE, "invalid response envelope: root is not an array");
  }
  const items: unknown = body[2];
  if (!Array.isArray(items)) {
    throw new SourceError(SOURCE, "invalid response envelope: element 2 is not a jobs array");
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
