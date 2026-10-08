import {
  HttpError,
  httpGetJson,
  log as defaultLog,
  SourceError,
  type CompanyConfig,
  type Logger,
  type RawPosting,
  type RawSalary,
  type SourceAdapter,
} from "@job-agent/core";
import { z } from "zod";
import { fetchAllBoards } from "../boards.ts";

const SOURCE = "ashby";
const BASE_URL = "https://api.ashbyhq.com/posting-api/job-board";
const MIN_INTERVAL_MS = 2000;
const MAX_INVALID_SHARE = 0.5;

const componentSchema = z.object({
  compensationType: z.string(),
  interval: z.string().nullish(),
  currencyCode: z.string().nullish(),
  minValue: z.number().nullish(),
  maxValue: z.number().nullish(),
});

const jobSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1),
  department: z.string().nullish(),
  team: z.string().nullish(),
  location: z.string().nullish(),
  publishedAt: z
    .string()
    .nullish()
    .refine((v) => v == null || !Number.isNaN(Date.parse(v)), "invalid date"),
  isListed: z.boolean().nullish(),
  isRemote: z.boolean().nullish(),
  descriptionHtml: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  jobUrl: z.url(),
  applyUrl: z.url().nullish(),
  compensation: z
    .object({
      compensationTierSummary: z.string().nullish(),
      compensationTiers: z.array(z.object({ components: z.array(componentSchema) })).nullish(),
    })
    .nullish(),
});

const envelopeSchema = z.object({ jobs: z.array(z.unknown()) });

type AshbyJob = z.infer<typeof jobSchema>;

const PERIODS: Record<string, RawSalary["period"]> = {
  "1 YEAR": "year",
  "1 MONTH": "month",
  "1 HOUR": "hour",
};

/**
 * Structured salary from the Salary components of all tiers (the min/max envelope matches the summary text).
 * Undefined when there is no numeric Salary component, or currency or period is unknown or mixed.
 */
function mapSalary(job: AshbyJob): RawSalary | undefined {
  const components = (job.compensation?.compensationTiers ?? [])
    .flatMap((tier) => tier.components)
    .filter((c) => c.compensationType === "Salary");
  if (components.length === 0) return undefined;

  const periods = new Set(components.map((c) => PERIODS[c.interval ?? ""]));
  const currencies = new Set(components.map((c) => c.currencyCode || undefined));
  const [period] = periods;
  const [currency] = currencies;
  if (periods.size !== 1 || currencies.size !== 1 || !period || !currency) return undefined;

  const mins = components.flatMap((c) => (c.minValue != null ? [c.minValue] : []));
  const maxs = components.flatMap((c) => (c.maxValue != null ? [c.maxValue] : []));
  if (mins.length === 0 && maxs.length === 0) return undefined;

  return {
    ...(mins.length > 0 && { min: Math.min(...mins) }),
    ...(maxs.length > 0 && { max: Math.max(...maxs) }),
    currency,
    period,
  };
}

function mapJob(job: AshbyJob, companyName: string): RawPosting {
  const salary = mapSalary(job);
  const salaryText = job.compensation?.compensationTierSummary || undefined;
  const tags = [job.department, job.team].filter((t): t is string => !!t);
  return {
    source: SOURCE,
    externalId: job.id,
    url: job.jobUrl,
    ...(job.applyUrl && { applyUrl: job.applyUrl }),
    title: job.title,
    company: companyName,
    ...(job.descriptionHtml && { descriptionHtml: job.descriptionHtml }),
    ...(job.descriptionPlain && { descriptionText: job.descriptionPlain }),
    ...(job.location && { locationText: job.location }),
    ...(job.isRemote != null && { remote: job.isRemote }),
    ...(salaryText && { salaryText }),
    ...(salary && { salary }),
    ...(job.publishedAt && { postedAt: new Date(job.publishedAt).toISOString() }),
    ...(tags.length > 0 && { tags }),
  };
}

async function fetchCompany(
  company: CompanyConfig,
  since: Date,
  log: Logger,
): Promise<RawPosting[] | null> {
  const url = `${BASE_URL}/${encodeURIComponent(company.slug)}?includeCompensation=true`;

  let body: unknown;
  try {
    body = await httpGetJson(url, { minIntervalMs: MIN_INTERVAL_MS });
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      log.warn("Ashby board not found, skipping", { source: SOURCE, slug: company.slug });
      return null;
    }
    throw new SourceError(SOURCE, `fetching board "${company.slug}" failed: ${String(err)}`, {
      cause: err,
    });
  }

  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) {
    throw new SourceError(SOURCE, `invalid response envelope for board "${company.slug}"`, {
      cause: envelope.error,
    });
  }

  const postings: RawPosting[] = [];
  let invalid = 0;
  for (const raw of envelope.data.jobs) {
    const parsed = jobSchema.safeParse(raw);
    if (!parsed.success) {
      invalid++;
      const externalId = (raw as { id?: unknown } | null)?.id;
      log.warn("Skipping invalid Ashby job", {
        source: SOURCE,
        slug: company.slug,
        externalId: typeof externalId === "string" ? externalId : undefined,
        path: parsed.error.issues[0]?.path.join("."),
      });
      continue;
    }
    if (parsed.data.isListed === false) continue;
    postings.push(mapJob(parsed.data, company.name));
  }

  if (invalid > envelope.data.jobs.length * MAX_INVALID_SHARE) {
    throw new SourceError(
      SOURCE,
      `${invalid} of ${envelope.data.jobs.length} jobs invalid for board "${company.slug}"`,
    );
  }

  return postings.filter((p) => !p.postedAt || new Date(p.postedAt) >= since);
}

/** Ashby public job board adapter: one request per company in the list. */
export function createAshbyAdapter(
  companies: CompanyConfig[],
  log: Logger = defaultLog,
): SourceAdapter {
  let warnings: string[] = [];
  return {
    name: SOURCE,
    minIntervalMinutes: 60,
    async fetch(since: Date): Promise<RawPosting[]> {
      warnings = [];
      const result = await fetchAllBoards(SOURCE, companies, (company) =>
        fetchCompany(company, since, log),
      );
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
