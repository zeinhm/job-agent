import {
  SourceError,
  httpGetJson,
  log,
  type RawPosting,
  type SourceAdapter,
} from "@job-agent/core";
import { z } from "zod";

const SOURCE = "arbeitnow";
const BASE_URL = "https://www.arbeitnow.com/api/job-board-api";
// Research t_bb8a60de: 100 jobs per page, newest first, hourly refresh, rate limit header 50.
// At most 5 pages per run; the shared HTTP client spaces requests to the same host.
const MAX_PAGES = 5;
const MIN_INTERVAL_MINUTES = 360;

const envelopeSchema = z.object({
  data: z.array(z.unknown()),
  links: z.object({ next: z.string().min(1).nullish() }).nullish(),
});

const jobSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  company_name: z.string().min(1),
  url: z.url(),
  description: z.string().nullish(),
  location: z.string().nullish(),
  remote: z.boolean().nullish(),
  tags: z.array(z.string()).nullish(),
  job_types: z.array(z.string()).nullish(),
  created_at: z.number().int().nonnegative().nullish(),
});
type ArbeitnowJob = z.infer<typeof jobSchema>;

/** `remote` is a separate boolean on Arbeitnow, so it is folded into the location text. */
function buildLocationText(job: ArbeitnowJob): string | undefined {
  const parts: string[] = [];
  if (job.remote) parts.push("Remote");
  if (job.location) parts.push(job.location);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function mapJob(job: ArbeitnowJob): RawPosting {
  const location = buildLocationText(job);
  const tags = [...(job.tags ?? []), ...(job.job_types ?? [])];
  return {
    source: SOURCE,
    externalId: job.slug,
    url: job.url,
    title: job.title,
    company: job.company_name,
    ...(job.description && { descriptionHtml: job.description }),
    ...(location && { locationText: location }),
    ...(job.created_at != null && { postedAt: new Date(job.created_at * 1000).toISOString() }),
    ...(tags.length > 0 && { tags }),
  };
}

async function fetchPage(page: number) {
  let body: unknown;
  try {
    body = await httpGetJson(`${BASE_URL}?page=${page}`);
  } catch (err) {
    throw new SourceError(SOURCE, "request failed", { cause: err });
  }
  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) {
    throw new SourceError(SOURCE, "invalid response envelope", { cause: envelope.error });
  }
  return envelope.data;
}

export function createArbeitnowAdapter(): SourceAdapter {
  return {
    name: SOURCE,
    minIntervalMinutes: MIN_INTERVAL_MINUTES,
    async fetch(since: Date): Promise<RawPosting[]> {
      const results: RawPosting[] = [];
      let seen = 0;
      let invalid = 0;

      // Newest first: once a page reaches items older than `since`, later pages are older still.
      for (let page = 1; page <= MAX_PAGES; page++) {
        const { data, links } = await fetchPage(page);
        let reachedOlder = false;
        for (const item of data) {
          seen++;
          const parsed = jobSchema.safeParse(item);
          if (!parsed.success) {
            invalid++;
            const slug =
              typeof item === "object" && item !== null && "slug" in item
                ? String(item.slug)
                : undefined;
            log.warn("arbeitnow: skipping invalid job", {
              source: SOURCE,
              externalId: slug,
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
        if (reachedOlder || !links?.next || data.length === 0) break;
      }

      if (invalid * 2 > seen) {
        throw new SourceError(SOURCE, `${invalid} of ${seen} jobs invalid`);
      }
      return results;
    },
  };
}
