import { createHash } from "node:crypto";
import {
  SourceError,
  SourceSkippedError,
  log,
  type RawPosting,
  type SourceAdapter,
} from "@job-agent/core";
import {
  BRAVE_KEY_ENV,
  BraveCapReachedError,
  searchResults,
  type SearchResult,
} from "../discovery/search.ts";
import { extractFacts, isLinkedinPostUrl } from "./parse.ts";

const SOURCE = "linkedin_posts";
/** Company name of a post that names none; the pipeline never probes ATS boards or research for it. */
export const UNKNOWN_COMPANY = "(unknown)";
const FRESHNESS = "pd";
/** Research t_788d14a9 section 1: 4 of the post queries per 3 h slot. */
export const MAX_POST_QUERIES_PER_RUN = 4;
const MIN_INTERVAL_MINUTES = 170;

/** Research queries 1-5 (query 6 targets /in/ profile pages, which this adapter ignores). */
export const POST_QUERIES: readonly string[] = [
  'site:linkedin.com/posts hiring ("senior frontend" OR "senior front-end") remote',
  'site:linkedin.com/posts hiring ("full stack" OR "fullstack") (react OR typescript) remote',
  'site:linkedin.com/posts hiring "react" (senior OR staff OR lead) remote',
  'site:linkedin.com/posts hiring (frontend OR react) (APAC OR "Southeast Asia" OR Indonesia OR Asia)',
  'site:linkedin.com/posts ("we\'re hiring" OR "we are hiring") (frontend OR "full stack") "worldwide"',
];

/** Rotates the start by 3 h slot so all queries get used across the day. */
function pickQueries(now: Date): string[] {
  const start = Math.floor(now.getUTCHours() / 3) % POST_QUERIES.length;
  return Array.from(
    { length: Math.min(MAX_POST_QUERIES_PER_RUN, POST_QUERIES.length) },
    (_, k) => POST_QUERIES[(start + k) % POST_QUERIES.length] as string,
  );
}

/** Stable id from the post URL: host/path only, no query or fragment; the hash keeps the footprint minimal. */
export function postExternalId(url: string): string {
  const u = new URL(url);
  const key = `${u.hostname.toLowerCase().replace(/^[a-z]{2,3}\./, "")}${u.pathname.replace(/\/+$/, "")}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

/**
 * Storage option (a), owner decision t_74a60bf8: only the post URL and facts derived here are kept.
 * The Brave title and snippet are read, reduced to facts by plain code, and dropped; nothing of them reaches RawPosting.
 */
export function mapResult(r: SearchResult): RawPosting | null {
  if (!isLinkedinPostUrl(r.url)) return null;
  const facts = extractFacts(`${r.title ?? ""}\n${r.description ?? ""}`);
  if (facts === null) return null;
  return {
    source: SOURCE,
    externalId: postExternalId(r.url),
    url: r.url,
    title: "(LinkedIn post)",
    company: facts.company ?? UNKNOWN_COMPANY,
    descriptionText: facts.description,
    ...(facts.remote && { remote: true }),
    ...(facts.locationText && { locationText: facts.locationText }),
  };
}

export function createLinkedinPostsAdapter(): SourceAdapter {
  return {
    name: SOURCE,
    minIntervalMinutes: MIN_INTERVAL_MINUTES,
    async fetch(): Promise<RawPosting[]> {
      const apiKey = process.env[BRAVE_KEY_ENV];
      if (!apiKey) throw new SourceSkippedError(SOURCE, `${BRAVE_KEY_ENV} not set`);
      const byId = new Map<string, RawPosting>();
      let failed = 0;
      const queries = pickQueries(new Date());
      for (const query of queries) {
        let results: SearchResult[];
        try {
          results = await searchResults(query, apiKey, FRESHNESS);
        } catch (e) {
          if (e instanceof BraveCapReachedError) {
            log.warn("linkedin_posts: Brave daily cap reached");
            if (byId.size === 0 && failed === 0) throw new SourceSkippedError(SOURCE, e.message);
            break;
          }
          failed++;
          log.warn("linkedin_posts: query failed", {
            error: e instanceof Error ? e.message : String(e),
          });
          continue;
        }
        for (const r of results) {
          const posting = mapResult(r);
          if (posting) byId.set(posting.externalId, posting);
        }
      }
      if (failed === queries.length) throw new SourceError(SOURCE, "every search query failed");
      return [...byId.values()];
    },
  };
}
