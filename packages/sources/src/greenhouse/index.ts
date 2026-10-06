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

const SOURCE = "greenhouse";
const BOARD_URL = "https://boards-api.greenhouse.io/v1/boards";

const envelopeSchema = z.object({ jobs: z.array(z.unknown()) });

const jobSchema = z.object({
  id: z.number().int(),
  title: z.string().min(1),
  absolute_url: z.url(),
  location: z.object({ name: z.string() }).nullish(),
  content: z.string().nullish(),
  first_published: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), "invalid date")
    .nullish(),
});

type GreenhouseJob = z.infer<typeof jobSchema>;

function toRawPosting(job: GreenhouseJob, company: string): RawPosting {
  return {
    source: SOURCE,
    externalId: String(job.id),
    url: job.absolute_url,
    applyUrl: job.absolute_url,
    title: job.title,
    company,
    ...(job.content ? { descriptionHtml: job.content } : {}),
    ...(job.location?.name ? { locationText: job.location.name } : {}),
    ...(job.first_published ? { postedAt: new Date(job.first_published).toISOString() } : {}),
  };
}

/** Fetches one board. Returns null when the slug is unknown (404). */
async function fetchBoard(company: CompanyConfig): Promise<RawPosting[] | null> {
  const url = `${BOARD_URL}/${encodeURIComponent(company.slug)}/jobs?content=true`;

  let body: unknown;
  try {
    body = await httpGetJson(url);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      log.warn("Greenhouse board not found, skipping", { source: SOURCE, slug: company.slug });
      return null;
    }
    throw new SourceError(SOURCE, `request failed for board "${company.slug}"`, { cause: err });
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
      const issue = parsed.error.issues[0];
      const externalId = (raw as { id?: unknown } | null)?.id;
      log.warn("Skipping invalid Greenhouse job", {
        source: SOURCE,
        slug: company.slug,
        externalId: externalId === undefined ? undefined : String(externalId),
        path: issue?.path.join("."),
        issue: issue?.code,
      });
      continue;
    }
    postings.push(toRawPosting(parsed.data, company.name));
  }

  if (invalid * 2 > envelope.data.jobs.length) {
    throw new SourceError(
      SOURCE,
      `${invalid} of ${envelope.data.jobs.length} jobs invalid for board "${company.slug}"`,
    );
  }
  return postings;
}

export function createGreenhouseAdapter(companies: CompanyConfig[]): SourceAdapter {
  return {
    name: SOURCE,
    minIntervalMinutes: 60,
    async fetch(since: Date): Promise<RawPosting[]> {
      const result: RawPosting[] = [];
      for (const company of companies) {
        const postings = await fetchBoard(company);
        for (const p of postings ?? []) {
          if (p.postedAt !== undefined && new Date(p.postedAt) < since) continue;
          result.push(p);
        }
      }
      return result;
    },
  };
}
