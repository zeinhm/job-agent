import {
  SourceError,
  httpGetJson,
  log,
  type RawPosting,
  type RawSalary,
  type SourceAdapter,
} from "@job-agent/core";
import { z } from "zod";

const SOURCE = "remoteok";
const API_URL = "https://remoteok.com/api";
const MIN_INTERVAL_MINUTES = 240;

const envelopeSchema = z.array(z.unknown());

const remoteOkJobSchema = z.object({
  id: z.union([z.string().min(1), z.number().int()]).transform(String),
  url: z.string().min(1),
  apply_url: z.string().min(1).nullish(),
  position: z.string().min(1),
  company: z.string().min(1),
  description: z.string().nullish(),
  location: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  date: z.string().datetime({ offset: true }).nullish(),
  epoch: z.number().int().nonnegative().nullish(),
  salary_min: z.number().nonnegative().nullish(),
  salary_max: z.number().nonnegative().nullish(),
});
type RemoteOkJob = z.infer<typeof remoteOkJobSchema>;

/** The feed's first element is an API terms notice (`{ last_updated, legal }`), not a job. */
function isLegalNotice(item: unknown): boolean {
  return typeof item === "object" && item !== null && "legal" in item && !("id" in item);
}

/** The feed carries no currency or period; research says assume USD per year. 0 means unset. */
function mapSalary(job: RemoteOkJob): RawSalary | undefined {
  const min = job.salary_min || undefined;
  const max = job.salary_max || undefined;
  if (min === undefined && max === undefined) return undefined;
  return {
    ...(min !== undefined && { min }),
    ...(max !== undefined && { max }),
    currency: "USD",
    period: "year",
  };
}

function postedAt(job: RemoteOkJob): string | undefined {
  if (job.date) return new Date(job.date).toISOString();
  if (job.epoch != null) return new Date(job.epoch * 1000).toISOString();
  return undefined;
}

function mapJob(job: RemoteOkJob): RawPosting {
  const salary = mapSalary(job);
  const posted = postedAt(job);
  const tags = (job.tags ?? []).filter((t) => t.length > 0);
  return {
    source: SOURCE,
    externalId: job.id,
    url: job.url,
    ...(job.apply_url && { applyUrl: job.apply_url }),
    title: job.position,
    company: job.company,
    ...(job.description && { descriptionHtml: job.description }),
    ...(job.location && { locationText: job.location }),
    ...(salary && { salary }),
    ...(posted && { postedAt: posted }),
    ...(tags.length > 0 && { tags }),
  };
}

function parseJobs(items: unknown[]): RawPosting[] {
  const postings: RawPosting[] = [];
  let invalid = 0;
  for (const item of items) {
    const parsed = remoteOkJobSchema.safeParse(item);
    if (!parsed.success) {
      invalid++;
      const externalId =
        typeof item === "object" && item !== null && "id" in item ? String(item.id) : undefined;
      log.warn("remoteok: skipping invalid job", {
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

export function createRemoteOkAdapter(): SourceAdapter {
  return {
    name: SOURCE,
    minIntervalMinutes: MIN_INTERVAL_MINUTES,
    async fetch(since: Date): Promise<RawPosting[]> {
      let body: unknown;
      try {
        body = await httpGetJson(API_URL);
      } catch (err) {
        throw new SourceError(SOURCE, "request failed", { cause: err });
      }
      const envelope = envelopeSchema.safeParse(body);
      if (!envelope.success) {
        throw new SourceError(SOURCE, "invalid response envelope", { cause: envelope.error });
      }
      const jobs = envelope.data.filter((item) => !isLegalNotice(item));
      return parseJobs(jobs).filter(
        (p) => p.postedAt === undefined || new Date(p.postedAt) >= since,
      );
    },
  };
}
