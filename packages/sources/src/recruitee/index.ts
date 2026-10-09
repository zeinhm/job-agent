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

const SOURCE = "recruitee";
const MIN_INTERVAL_MS = 2000;
const MAX_INVALID_SHARE = 0.5;
/** The slug becomes a hostname label, so anything else is refused before a request is made. */
const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;

/** Recruitee dates look like "2026-10-05 16:05:18 UTC". */
const DATE_PATTERN = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/;
const dateString = z
  .string()
  .nullish()
  .refine((v) => v == null || DATE_PATTERN.test(v), "invalid date");

const offerSchema = z.object({
  id: z.number().int(),
  title: z.string().trim().min(1),
  status: z.string().nullish(),
  company_name: z.string().nullish(),
  location: z.string().nullish(),
  city: z.string().nullish(),
  country: z.string().nullish(),
  remote: z.boolean().nullish(),
  department: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  description: z.string().nullish(),
  requirements: z.string().nullish(),
  careers_url: z.url(),
  careers_apply_url: z.url().nullish(),
  published_at: dateString,
  created_at: dateString,
  salary: z
    .object({
      min: z.number().nullish(),
      max: z.number().nullish(),
      currency: z.string().nullish(),
      period: z.string().nullish(),
    })
    .nullish(),
});

const envelopeSchema = z.object({ offers: z.array(z.unknown()) });

type RecruiteeOffer = z.infer<typeof offerSchema>;

const PERIODS: Record<string, RawSalary["period"]> = {
  year: "year",
  month: "month",
  hour: "hour",
};

/** Undefined when there is no number, or currency or period is missing or unknown. */
function mapSalary(offer: RecruiteeOffer): RawSalary | undefined {
  const s = offer.salary;
  const period = PERIODS[(s?.period ?? "").toLowerCase()];
  if (!s || !period || !s.currency) return undefined;
  if (s.min == null && s.max == null) return undefined;
  return {
    ...(s.min != null && { min: s.min }),
    ...(s.max != null && { max: s.max }),
    currency: s.currency.toUpperCase(),
    period,
  };
}

const toIso = (value: string): string => {
  const [, day, time] = DATE_PATTERN.exec(value) ?? [];
  return new Date(`${day}T${time}Z`).toISOString();
};

function mapOffer(offer: RecruiteeOffer, companyName: string): RawPosting {
  const salary = mapSalary(offer);
  const description = [offer.description, offer.requirements].filter((p): p is string => !!p);
  const locationText =
    offer.location || [offer.city, offer.country].filter(Boolean).join(", ") || undefined;
  const postedAt = offer.published_at ?? offer.created_at;
  const tags = [offer.department, ...(offer.tags ?? [])].filter((t): t is string => !!t);
  return {
    source: SOURCE,
    externalId: String(offer.id),
    url: offer.careers_url,
    ...(offer.careers_apply_url && { applyUrl: offer.careers_apply_url }),
    title: offer.title,
    company: companyName,
    ...(description.length > 0 && { descriptionHtml: description.join("\n") }),
    ...(locationText && { locationText }),
    ...(offer.remote != null && { remote: offer.remote }),
    ...(salary && { salary }),
    ...(postedAt && { postedAt: toIso(postedAt) }),
    ...(tags.length > 0 && { tags }),
  };
}

async function fetchCompany(
  company: CompanyConfig,
  since: Date,
  log: Logger,
): Promise<RawPosting[] | null> {
  if (!SLUG_PATTERN.test(company.slug)) {
    throw new SourceError(SOURCE, `invalid board slug "${company.slug}"`);
  }
  const url = `https://${company.slug}.recruitee.com/api/offers/`;

  let body: unknown;
  try {
    body = await httpGetJson(url, { minIntervalMs: MIN_INTERVAL_MS });
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      log.warn("Recruitee board not found, skipping", { source: SOURCE, slug: company.slug });
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
  for (const raw of envelope.data.offers) {
    const parsed = offerSchema.safeParse(raw);
    if (!parsed.success) {
      invalid++;
      const id = (raw as { id?: unknown } | null)?.id;
      log.warn("Skipping invalid Recruitee offer", {
        source: SOURCE,
        slug: company.slug,
        externalId: typeof id === "number" ? String(id) : undefined,
        path: parsed.error.issues[0]?.path.join("."),
      });
      continue;
    }
    if (parsed.data.status != null && parsed.data.status !== "published") continue;
    postings.push(mapOffer(parsed.data, company.name));
  }

  if (invalid > envelope.data.offers.length * MAX_INVALID_SHARE) {
    throw new SourceError(
      SOURCE,
      `${invalid} of ${envelope.data.offers.length} offers invalid for board "${company.slug}"`,
    );
  }

  return postings.filter((p) => !p.postedAt || new Date(p.postedAt) >= since);
}

/** Recruitee careers-site adapter: one request per company in the list. */
export function createRecruiteeAdapter(
  companies: CompanyConfig[],
  log: Logger = defaultLog,
): SourceAdapter {
  let warnings: string[] = [];
  return {
    name: SOURCE,
    minIntervalMinutes: 360,
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
