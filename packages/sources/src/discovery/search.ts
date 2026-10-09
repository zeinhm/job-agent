import { httpGetJson } from "@job-agent/core";
import { z } from "zod";

export const BRAVE_KEY_ENV = "BRAVE_API_KEY";
/** Hard cap on search requests per run (docs/research/t_250e744a-search-api.md section 6). */
export const DAILY_QUERY_BUDGET = 20;

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const COUNT = 20;
const FRESHNESS = "pw";
/** Research: at most 1 request per 2 s. */
const MIN_INTERVAL_MS = 2000;

/** The R2 query list (12 queries). Page 0 only. */
export const DISCOVERY_QUERIES: readonly string[] = [
  'site:boards.greenhouse.io ("frontend" OR "front-end") remote',
  'site:job-boards.greenhouse.io ("frontend" OR "full stack" OR "react") remote',
  'site:jobs.lever.co ("frontend" OR "front-end") remote',
  'site:jobs.lever.co ("full stack" OR "fullstack" OR "react") remote',
  'site:jobs.ashbyhq.com ("frontend" OR "front-end") remote',
  'site:jobs.ashbyhq.com ("full stack" OR "react" OR "typescript") remote',
  'site:jobs.smartrecruiters.com ("frontend" OR "react") remote',
  'site:apply.workable.com ("frontend" OR "front-end" OR "react") remote',
  'site:apply.workable.com ("full stack" OR "fullstack") remote',
  'site:recruitee.com/o ("frontend" OR "react") remote',
  'site:job-boards.eu.greenhouse.io ("frontend" OR "react")',
  'site:boards.greenhouse.io ("senior" OR "staff") "react" "typescript" remote',
];

// Only the URL is read: Brave's terms forbid storing results, so titles and snippets are never parsed.
const responseSchema = z.object({
  web: z.object({ results: z.array(z.unknown()) }).optional(),
});
const resultSchema = z.object({ url: z.string().min(1) });

/** Runs one search and returns the result URLs (transient, never stored). Throws on HTTP or envelope failure. */
export async function searchUrls(query: string, apiKey: string): Promise<string[]> {
  const params = new URLSearchParams({ q: query, count: String(COUNT), freshness: FRESHNESS });
  const body = await httpGetJson(`${ENDPOINT}?${params.toString()}`, {
    minIntervalMs: MIN_INTERVAL_MS,
    headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
  });
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) throw new Error("invalid search response envelope");
  const urls: string[] = [];
  for (const item of parsed.data.web?.results ?? []) {
    const r = resultSchema.safeParse(item);
    if (r.success) urls.push(r.data.url);
  }
  return urls;
}
