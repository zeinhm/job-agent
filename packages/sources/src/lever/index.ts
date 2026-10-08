import {
  HttpError,
  SourceError,
  httpGetJson,
  log,
  type CompanyConfig,
  type RawPosting,
  type RawSalary,
  type SourceAdapter,
} from "@job-agent/core";
import { z } from "zod";
import { fetchAllBoards } from "../boards.ts";

const SOURCE = "lever";
const BASE_URL = "https://api.lever.co/v0/postings";
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const MIN_INTERVAL_MINUTES = 60;

const envelopeSchema = z.array(z.unknown());

const leverJobSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  hostedUrl: z.string().min(1),
  applyUrl: z.string().min(1).nullish(),
  description: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  createdAt: z.number().int().nonnegative().nullish(),
  workplaceType: z.string().nullish(),
  categories: z
    .object({
      location: z.string().nullish(),
      department: z.string().nullish(),
      team: z.string().nullish(),
      commitment: z.string().nullish(),
    })
    .nullish(),
  salaryRange: z
    .object({
      min: z.number().nullish(),
      max: z.number().nullish(),
      currency: z.string().min(1),
      interval: z.string(),
    })
    .nullish(),
});
type LeverJob = z.infer<typeof leverJobSchema>;

const PERIOD_BY_INTERVAL: Record<string, RawSalary["period"]> = {
  "per-year-salary": "year",
  "per-month-salary": "month",
  "per-hour-salary": "hour",
};

function mapSalary(range: LeverJob["salaryRange"]): RawSalary | undefined {
  if (!range) return undefined;
  const period = PERIOD_BY_INTERVAL[range.interval];
  if (!period || (range.min == null && range.max == null)) return undefined;
  return {
    ...(range.min != null && { min: range.min }),
    ...(range.max != null && { max: range.max }),
    currency: range.currency,
    period,
  };
}

function mapJob(job: LeverJob, companyName: string): RawPosting {
  const cats = job.categories;
  const tags = [cats?.department, cats?.team, cats?.commitment].filter(
    (t): t is string => typeof t === "string" && t.length > 0,
  );
  const salary = mapSalary(job.salaryRange);
  return {
    source: SOURCE,
    externalId: job.id,
    url: job.hostedUrl,
    ...(job.applyUrl && { applyUrl: job.applyUrl }),
    title: job.text,
    company: companyName,
    ...(job.description && { descriptionHtml: job.description }),
    ...(job.descriptionPlain && { descriptionText: job.descriptionPlain }),
    ...(cats?.location && { locationText: cats.location }),
    ...(job.workplaceType === "remote" && { remote: true }),
    ...(job.workplaceType === "onsite" && { remote: false }),
    ...(salary && { salary }),
    ...(job.createdAt != null && { postedAt: new Date(job.createdAt).toISOString() }),
    ...(tags.length > 0 && { tags }),
  };
}

/** Fetches every page of one board. Returns null for an unknown slug (404). */
async function fetchBoard(slug: string): Promise<unknown[] | null> {
  const items: unknown[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${BASE_URL}/${encodeURIComponent(slug)}?mode=json&limit=${PAGE_SIZE}&skip=${items.length}`;
    let body: unknown;
    try {
      body = await httpGetJson(url);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw new SourceError(SOURCE, `request failed for slug "${slug}"`, { cause: err });
    }
    const envelope = envelopeSchema.safeParse(body);
    if (!envelope.success) {
      throw new SourceError(SOURCE, `invalid response envelope for slug "${slug}"`, {
        cause: envelope.error,
      });
    }
    items.push(...envelope.data);
    if (envelope.data.length < PAGE_SIZE) return items;
  }
  throw new SourceError(SOURCE, `slug "${slug}" exceeded ${MAX_PAGES} pages`);
}

function parseJobs(slug: string, companyName: string, items: unknown[]): RawPosting[] {
  const postings: RawPosting[] = [];
  let invalid = 0;
  for (const item of items) {
    const parsed = leverJobSchema.safeParse(item);
    if (!parsed.success) {
      invalid++;
      const externalId =
        typeof item === "object" && item !== null && "id" in item ? String(item.id) : undefined;
      log.warn("lever: skipping invalid job", {
        source: SOURCE,
        slug,
        externalId,
        path: parsed.error.issues[0]?.path.join("."),
      });
      continue;
    }
    postings.push(mapJob(parsed.data, companyName));
  }
  if (invalid * 2 > items.length) {
    throw new SourceError(SOURCE, `${invalid} of ${items.length} jobs invalid for slug "${slug}"`);
  }
  return postings;
}

export function createLeverAdapter(companies: readonly CompanyConfig[]): SourceAdapter {
  let warnings: string[] = [];
  return {
    name: SOURCE,
    minIntervalMinutes: MIN_INTERVAL_MINUTES,
    async fetch(since: Date): Promise<RawPosting[]> {
      warnings = [];
      const result = await fetchAllBoards(SOURCE, companies, async (company) => {
        const items = await fetchBoard(company.slug);
        if (items === null) {
          log.warn("lever: unknown slug (404), skipping", { source: SOURCE, slug: company.slug });
          return null;
        }
        return parseJobs(company.slug, company.name, items).filter(
          (p) => p.postedAt === undefined || new Date(p.postedAt) >= since,
        );
      });
      warnings = result.warnings;
      return result.postings;
    },
    takeWarnings() {
      const taken = warnings;
      warnings = [];
      return taken;
    },
  };
}
