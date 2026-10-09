import {
  HttpError,
  SourceError,
  httpGetJson,
  log,
  type CompanyConfig,
  type RawPosting,
  type SourceAdapter,
} from "@job-agent/core";
import { z } from "zod";
import { fetchAllBoards } from "../boards.ts";

const SOURCE = "workable";
const BASE_URL = "https://apply.workable.com/api/v1/widget/accounts";
/** R3 (t_bb8a60de): no published limits, responses are cached; poll slowly. */
const MIN_INTERVAL_MINUTES = 360;

const envelopeSchema = z.object({ jobs: z.array(z.unknown()) });

const workableJobSchema = z.object({
  shortcode: z.string().min(1),
  title: z.string().min(1),
  url: z.string().min(1).nullish(),
  shortlink: z.string().min(1).nullish(),
  application_url: z.string().min(1).nullish(),
  description: z.string().nullish(),
  published_on: z.string().nullish(),
  created_at: z.string().nullish(),
  telecommuting: z.boolean().nullish(),
  country: z.string().nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
  employment_type: z.string().nullish(),
  department: z.string().nullish(),
  function: z.string().nullish(),
  industry: z.string().nullish(),
  locations: z
    .array(
      z.object({
        country: z.string().nullish(),
        city: z.string().nullish(),
        region: z.string().nullish(),
        hidden: z.boolean().nullish(),
      }),
    )
    .nullish(),
});
type WorkableJob = z.infer<typeof workableJobSchema>;

const nonEmpty = (v: string | null | undefined): v is string => typeof v === "string" && v !== "";

/** Workable dates are date-only (YYYY-MM-DD); returns ISO UTC or undefined. */
function toIso(date: string | null | undefined): string | undefined {
  if (!nonEmpty(date)) return undefined;
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function locationText(job: WorkableJob): string | undefined {
  const visible = (job.locations ?? []).filter((l) => !l.hidden);
  const places =
    visible.length > 0 ? visible : [{ city: job.city, region: job.state, country: job.country }];
  const texts = places
    .map((l) => [l.city, l.region, l.country].filter(nonEmpty).join(", "))
    .filter((t) => t !== "");
  const unique = [...new Set(texts)];
  return unique.length > 0 ? unique.join("; ") : undefined;
}

function mapJob(job: WorkableJob, companyName: string): RawPosting {
  const url = job.url ?? job.shortlink ?? `https://apply.workable.com/j/${job.shortcode}`;
  const tags = [job.department, job.function, job.employment_type, job.industry].filter(nonEmpty);
  const postedAt = toIso(job.published_on) ?? toIso(job.created_at);
  const location = locationText(job);
  return {
    source: SOURCE,
    externalId: job.shortcode,
    url,
    ...(job.application_url && { applyUrl: job.application_url }),
    title: job.title,
    company: companyName,
    ...(job.description && { descriptionHtml: job.description }),
    ...(location && { locationText: location }),
    ...(job.telecommuting != null && { remote: job.telecommuting }),
    ...(postedAt && { postedAt }),
    ...(tags.length > 0 && { tags: [...new Set(tags)] }),
  };
}

/** Returns null for an unknown slug (404). */
async function fetchBoard(slug: string): Promise<unknown[] | null> {
  const url = `${BASE_URL}/${encodeURIComponent(slug)}?details=true`;
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
  return envelope.data.jobs;
}

function parseJobs(slug: string, companyName: string, items: unknown[]): RawPosting[] {
  const postings: RawPosting[] = [];
  let invalid = 0;
  for (const item of items) {
    const parsed = workableJobSchema.safeParse(item);
    if (!parsed.success) {
      invalid++;
      const externalId =
        typeof item === "object" && item !== null && "shortcode" in item
          ? String(item.shortcode)
          : undefined;
      log.warn("workable: skipping invalid job", {
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

export function createWorkableAdapter(companies: readonly CompanyConfig[]): SourceAdapter {
  let warnings: string[] = [];
  return {
    name: SOURCE,
    minIntervalMinutes: MIN_INTERVAL_MINUTES,
    async fetch(since: Date): Promise<RawPosting[]> {
      warnings = [];
      const result = await fetchAllBoards(SOURCE, companies, async (company) => {
        const items = await fetchBoard(company.slug);
        if (items === null) {
          log.warn("workable: unknown slug (404), skipping", {
            source: SOURCE,
            slug: company.slug,
          });
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
