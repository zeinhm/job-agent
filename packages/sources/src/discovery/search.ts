import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultDbPath, httpGetJson } from "@job-agent/core";
import { z } from "zod";

export const BRAVE_KEY_ENV = "BRAVE_API_KEY";
/** Hard cap on search requests per run (docs/research/t_250e744a-search-api.md section 6). */
export const DAILY_QUERY_BUDGET = 20;

/** Owner decision (t_74a60bf8): at most 30 Brave requests per UTC day, all callers together. */
export const BRAVE_DAILY_REQUEST_CAP = 30;

export class BraveCapReachedError extends Error {
  constructor() {
    super(`Brave daily request cap (${BRAVE_DAILY_REQUEST_CAP}) reached, skipping`);
    this.name = "BraveCapReachedError";
  }
}

/** Counter file next to the database (gitignored `data/`); holds only a date and a number. */
function usagePath(): string {
  return process.env["JOB_AGENT_BRAVE_USAGE"] ?? join(dirname(defaultDbPath()), "brave-usage.json");
}

const usageSchema = z.object({ day: z.string(), count: z.number().int().nonnegative() });

function readUsage(path: string, day: string): number {
  if (!existsSync(path)) return 0;
  try {
    const parsed = usageSchema.safeParse(JSON.parse(readFileSync(path, "utf-8")));
    // A counter of another UTC day is a fresh day; anything unreadable must not open the cap.
    if (parsed.success) return parsed.data.day === day ? parsed.data.count : 0;
  } catch {
    // not JSON: falls through to spent
  }
  return BRAVE_DAILY_REQUEST_CAP;
}

/** Counts one Brave request against today's cap; throws BraveCapReachedError when it is spent. */
export function reserveBraveRequest(now: Date = new Date()): void {
  const path = usagePath();
  const day = now.toISOString().slice(0, 10);
  const used = readUsage(path, day);
  if (used >= BRAVE_DAILY_REQUEST_CAP) throw new BraveCapReachedError();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ day, count: used + 1 }));
}

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

// Brave's terms forbid storing results: callers get title/snippet for transient processing only and must not persist them.
const responseSchema = z.object({
  web: z.object({ results: z.array(z.unknown()) }).optional(),
});
const resultSchema = z.object({
  url: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
});
export type SearchResult = z.infer<typeof resultSchema>;

/** Runs one search. Counts against the daily cap first. Throws on HTTP or envelope failure. Transient data only. */
export async function searchResults(
  query: string,
  apiKey: string,
  freshness: string = FRESHNESS,
): Promise<SearchResult[]> {
  reserveBraveRequest();
  const params = new URLSearchParams({ q: query, count: String(COUNT), freshness });
  const body = await httpGetJson(`${ENDPOINT}?${params.toString()}`, {
    minIntervalMs: MIN_INTERVAL_MS,
    headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
  });
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) throw new Error("invalid search response envelope");
  const results: SearchResult[] = [];
  for (const item of parsed.data.web?.results ?? []) {
    const r = resultSchema.safeParse(item);
    if (r.success) results.push(r.data);
  }
  return results;
}

/** Runs one search and returns the result URLs (transient, never stored). */
export async function searchUrls(query: string, apiKey: string): Promise<string[]> {
  return (await searchResults(query, apiKey)).map((r) => r.url);
}
