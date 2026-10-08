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

const SOURCE = "smartrecruiters";
const BASE_URL = "https://api.smartrecruiters.com/v1/companies";
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const MIN_INTERVAL_MINUTES = 360;
/** Gap between requests to the API host; the detail call is one request per posting. */
const REQUEST_INTERVAL_MS = 2000;

const listSchema = z.object({
  totalFound: z.number().int().nonnegative(),
  content: z.array(z.unknown()),
});

const listItemSchema = z.object({
  id: z.string().min(1),
  releasedDate: z.string().nullish(),
});

const labelSchema = z.object({ label: z.string().nullish() }).nullish();

const sectionSchema = z.object({
  title: z.string().nullish(),
  text: z.string().nullish(),
});

const detailSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  postingUrl: z.string().min(1),
  applyUrl: z.string().min(1).nullish(),
  releasedDate: z.string().nullish(),
  location: z
    .object({
      fullLocation: z.string().nullish(),
      remote: z.boolean().nullish(),
      hybrid: z.boolean().nullish(),
    })
    .nullish(),
  function: labelSchema,
  typeOfEmployment: labelSchema,
  experienceLevel: labelSchema,
  industry: labelSchema,
  department: labelSchema,
  jobAd: z.object({ sections: z.record(z.string(), sectionSchema.nullish()) }).nullish(),
});
type Detail = z.infer<typeof detailSchema>;

/** Order of the sections in the posting page; unknown sections are appended. */
const SECTION_ORDER = [
  "companyDescription",
  "jobDescription",
  "qualifications",
  "additionalInformation",
];

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function buildDescription(sections: NonNullable<Detail["jobAd"]>["sections"]): string | undefined {
  const keys = [
    ...SECTION_ORDER.filter((k) => k in sections),
    ...Object.keys(sections).filter((k) => !SECTION_ORDER.includes(k)),
  ];
  const parts: string[] = [];
  for (const key of keys) {
    const section = sections[key];
    if (!section?.text) continue;
    parts.push(
      section.title ? `<h2>${escapeHtml(section.title)}</h2>${section.text}` : section.text,
    );
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function mapDetail(job: Detail, companyName: string): RawPosting {
  const labels = [
    job.function?.label,
    job.typeOfEmployment?.label,
    job.experienceLevel?.label,
    job.industry?.label,
    job.department?.label,
    job.location?.hybrid ? "Hybrid" : undefined,
  ].filter((t): t is string => typeof t === "string" && t.length > 0);
  const tags = [...new Set(labels)];
  const descriptionHtml = job.jobAd ? buildDescription(job.jobAd.sections) : undefined;
  const postedAt = job.releasedDate ? new Date(job.releasedDate) : undefined;
  return {
    source: SOURCE,
    externalId: job.id,
    url: job.postingUrl,
    ...(job.applyUrl && { applyUrl: job.applyUrl }),
    title: job.name,
    company: companyName,
    ...(descriptionHtml && { descriptionHtml }),
    ...(job.location?.fullLocation && { locationText: job.location.fullLocation }),
    // `remote: false` is the API default, not a statement that the job is on-site, so only true is mapped.
    ...(job.location?.remote === true && { remote: true }),
    ...(postedAt && !Number.isNaN(postedAt.getTime()) && { postedAt: postedAt.toISOString() }),
    ...(tags.length > 0 && { tags }),
  };
}

/** Lists every posting stub of one board. Returns null for an unknown slug (404). */
async function listBoard(slug: string): Promise<unknown[] | null> {
  const items: unknown[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${BASE_URL}/${encodeURIComponent(slug)}/postings?limit=${PAGE_SIZE}&offset=${items.length}`;
    let body: unknown;
    try {
      body = await httpGetJson(url, { minIntervalMs: REQUEST_INTERVAL_MS });
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw new SourceError(SOURCE, `request failed for slug "${slug}"`, { cause: err });
    }
    const envelope = listSchema.safeParse(body);
    if (!envelope.success) {
      throw new SourceError(SOURCE, `invalid response envelope for slug "${slug}"`, {
        cause: envelope.error,
      });
    }
    items.push(...envelope.data.content);
    if (envelope.data.content.length < PAGE_SIZE || items.length >= envelope.data.totalFound) {
      return items;
    }
  }
  throw new SourceError(SOURCE, `slug "${slug}" exceeded ${MAX_PAGES} pages`);
}

/** Fetches the full posting. Returns null when it was withdrawn between list and detail (404). */
async function fetchDetail(slug: string, id: string): Promise<unknown> {
  const url = `${BASE_URL}/${encodeURIComponent(slug)}/postings/${encodeURIComponent(id)}`;
  try {
    return await httpGetJson(url, { minIntervalMs: REQUEST_INTERVAL_MS });
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw new SourceError(SOURCE, `request failed for posting "${id}" of slug "${slug}"`, {
      cause: err,
    });
  }
}

async function fetchBoard(
  company: CompanyConfig,
  since: Date,
  emptySlugs: string[],
): Promise<RawPosting[] | null> {
  const slug = company.slug;
  const items = await listBoard(slug);
  if (items === null) return null;
  // R3: an unknown slug answers 200 with an empty list, so empty is reported as a warning.
  if (items.length === 0) emptySlugs.push(slug);

  const postings: RawPosting[] = [];
  let invalid = 0;
  for (const item of items) {
    const stub = listItemSchema.safeParse(item);
    if (!stub.success) {
      invalid++;
      log.warn("smartrecruiters: skipping invalid job", {
        source: SOURCE,
        slug,
        path: stub.error.issues[0]?.path.join("."),
      });
      continue;
    }
    // Skip old postings before the per-posting detail request.
    const released = stub.data.releasedDate ? new Date(stub.data.releasedDate) : undefined;
    if (released && !Number.isNaN(released.getTime()) && released < since) continue;

    const raw = await fetchDetail(slug, stub.data.id);
    if (raw === null) {
      log.warn("smartrecruiters: posting gone (404), skipping", {
        source: SOURCE,
        slug,
        externalId: stub.data.id,
      });
      continue;
    }
    const detail = detailSchema.safeParse(raw);
    if (!detail.success) {
      invalid++;
      log.warn("smartrecruiters: skipping invalid job", {
        source: SOURCE,
        slug,
        externalId: stub.data.id,
        path: detail.error.issues[0]?.path.join("."),
      });
      continue;
    }
    postings.push(mapDetail(detail.data, company.name));
  }
  if (invalid * 2 > items.length) {
    throw new SourceError(SOURCE, `${invalid} of ${items.length} jobs invalid for slug "${slug}"`);
  }
  return postings;
}

export function createSmartRecruitersAdapter(companies: readonly CompanyConfig[]): SourceAdapter {
  let warnings: string[] = [];
  return {
    name: SOURCE,
    minIntervalMinutes: MIN_INTERVAL_MINUTES,
    async fetch(since: Date): Promise<RawPosting[]> {
      warnings = [];
      const emptySlugs: string[] = [];
      const result = await fetchAllBoards(SOURCE, companies, async (company) => {
        const postings = await fetchBoard(company, since, emptySlugs);
        if (postings === null) {
          log.warn("smartrecruiters: unknown slug (404), skipping", {
            source: SOURCE,
            slug: company.slug,
          });
        }
        return postings;
      });
      warnings = [...result.warnings];
      if (emptySlugs.length > 0) {
        warnings.push(
          `${emptySlugs.length} ${emptySlugs.length === 1 ? "board" : "boards"} returned no postings: ${emptySlugs.join(", ")}`,
        );
      }
      return result.postings;
    },
    takeWarnings() {
      const taken = warnings;
      warnings = [];
      return taken;
    },
  };
}
