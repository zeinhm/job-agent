import { httpGetJson, httpGetText } from "@job-agent/core";
import { z } from "zod";

// docs/research/t_c500164f-yc.md section 3: YC's directory page hands a short-lived, public, search-only
// (secured) Algolia key to every browser in `window.AlgoliaOpts`. It is read at run time and never stored or logged.
const DIRECTORY_PAGE = "https://www.ycombinator.com/companies";
const ALGOLIA_INDEX = "YCCompany_production";
/** Research section 5: at most 1 request per 3 s to YC hosts. */
const MIN_INTERVAL_MS = 3000;
/** One directory query per run: 2 pages of 100 cover the 194 hiring + fully-remote companies. */
export const YC_HITS_PER_PAGE = 100;
export const YC_PAGE_CAP = 2;

const optsSchema = z.object({ app: z.string().regex(/^[A-Za-z0-9]+$/), key: z.string().min(1) });
const hitSchema = z.object({ name: z.string().min(1), website: z.string().nullish() });
const pageSchema = z.object({
  hits: z.array(z.unknown()),
  nbPages: z.number().int().nonnegative(),
});

export interface YcCompany {
  name: string;
  website: string | null;
}

/** Reads `window.AlgoliaOpts = {...}` from the public directory page. Throws without including the key in the message. */
export async function fetchYcAlgoliaOpts(): Promise<{ app: string; key: string }> {
  const html = await httpGetText(DIRECTORY_PAGE, { minIntervalMs: MIN_INTERVAL_MS });
  const m = /window\.AlgoliaOpts\s*=\s*(\{[^;]*?\})\s*;?/.exec(html);
  if (!m?.[1]) throw new Error("YC directory page has no AlgoliaOpts");
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]);
  } catch {
    throw new Error("YC directory AlgoliaOpts is not JSON");
  }
  const parsed = optsSchema.safeParse(raw);
  if (!parsed.success) throw new Error("YC directory AlgoliaOpts has an unexpected shape");
  return parsed.data;
}

/**
 * Hiring, fully remote YC companies (research: `isHiring:true` + `regions:Fully Remote`), at most `YC_PAGE_CAP` pages.
 * Uses Algolia's GET search so the shared GET helper (rate limit, retries) applies.
 */
export async function fetchYcCompanies(): Promise<{ companies: YcCompany[]; requests: number }> {
  const opts = await fetchYcAlgoliaOpts();
  let requests = 1;
  const out: YcCompany[] = [];
  for (let page = 0; page < YC_PAGE_CAP; page++) {
    const params = new URLSearchParams({
      query: "",
      hitsPerPage: String(YC_HITS_PER_PAGE),
      page: String(page),
      attributesToRetrieve: JSON.stringify(["name", "website"]),
      attributesToHighlight: "[]",
      facetFilters: JSON.stringify([["isHiring:true"], ["regions:Fully Remote"]]),
    });
    const body = await httpGetJson(
      `https://${opts.app}-dsn.algolia.net/1/indexes/${ALGOLIA_INDEX}?${params.toString()}`,
      {
        minIntervalMs: MIN_INTERVAL_MS,
        headers: {
          "x-algolia-application-id": opts.app,
          "x-algolia-api-key": opts.key,
          Accept: "application/json",
        },
      },
    );
    requests++;
    const parsed = pageSchema.safeParse(body);
    if (!parsed.success) throw new Error("invalid YC directory response envelope");
    for (const h of parsed.data.hits) {
      const hit = hitSchema.safeParse(h);
      if (hit.success) out.push({ name: hit.data.name, website: hit.data.website ?? null });
    }
    if (page + 1 >= parsed.data.nbPages) break;
  }
  return { companies: out, requests };
}
