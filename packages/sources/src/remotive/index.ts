import {
  SourceError,
  httpGetJson,
  log,
  type RawPosting,
  type SourceAdapter,
} from "@job-agent/core";
import { z } from "zod";

const SOURCE = "remotive";
const API_URL = "https://remotive.com/api/remote-jobs?category=software-dev";

const envelopeSchema = z.object({ jobs: z.array(z.unknown()) });

// Remotive dates carry no zone suffix ("2026-10-05T05:15:43"); the research doc states they are UTC.
const publicationDate = z
  .string()
  .transform((s) => (/(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`))
  .refine((s) => !Number.isNaN(Date.parse(s)), "invalid date");

const jobSchema = z.object({
  id: z.number().int(),
  url: z.url(),
  title: z.string().min(1),
  company_name: z.string().min(1),
  description: z.string().nullish(),
  candidate_required_location: z.string().nullish(),
  salary: z.string().nullish(),
  publication_date: publicationDate.nullish(),
  tags: z.array(z.string()).nullish(),
});

type RemotiveJob = z.infer<typeof jobSchema>;

function toRawPosting(job: RemotiveJob): RawPosting {
  return {
    source: SOURCE,
    externalId: String(job.id),
    url: job.url,
    title: job.title,
    company: job.company_name,
    ...(job.description ? { descriptionHtml: job.description } : {}),
    ...(job.candidate_required_location ? { locationText: job.candidate_required_location } : {}),
    ...(job.salary ? { salaryText: job.salary } : {}),
    ...(job.publication_date ? { postedAt: new Date(job.publication_date).toISOString() } : {}),
    ...(job.tags && job.tags.length > 0 ? { tags: job.tags } : {}),
  };
}

export function createRemotiveAdapter(): SourceAdapter {
  return {
    name: SOURCE,
    // Remotive asks for at most 4 requests per day (research t_92e11b3f): 360 min is 4 per day.
    minIntervalMinutes: 360,
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

      const postings: RawPosting[] = [];
      let invalid = 0;
      for (const raw of envelope.data.jobs) {
        const parsed = jobSchema.safeParse(raw);
        if (!parsed.success) {
          invalid++;
          const issue = parsed.error.issues[0];
          const externalId = (raw as { id?: unknown } | null)?.id;
          log.warn("Skipping invalid Remotive job", {
            source: SOURCE,
            externalId: externalId === undefined ? undefined : String(externalId),
            path: issue?.path.join("."),
            issue: issue?.code,
          });
          continue;
        }
        postings.push(toRawPosting(parsed.data));
      }

      if (invalid * 2 > envelope.data.jobs.length) {
        throw new SourceError(SOURCE, `${invalid} of ${envelope.data.jobs.length} jobs invalid`);
      }
      return postings.filter((p) => p.postedAt === undefined || new Date(p.postedAt) >= since);
    },
  };
}
