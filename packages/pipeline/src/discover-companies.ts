import { randomUUID } from "node:crypto";
import { companies, log, type Db } from "@job-agent/core";
import {
  BRAVE_KEY_ENV,
  DAILY_QUERY_BUDGET,
  DISCOVERY_QUERIES,
  extractAtsSlug,
  searchUrls,
  verifyBoard,
  type AtsSlug,
} from "@job-agent/sources";
import { cleanLine, normalizeCompanyName } from "./normalize/index.ts";

export interface DiscoverCompaniesOptions {
  db: Db;
  /** Defaults to process.env[BRAVE_KEY_ENV]. */
  apiKey?: string | undefined;
  /** Override the query list (tests). Always capped at DAILY_QUERY_BUDGET. */
  queries?: readonly string[];
  now?: () => Date;
  out: (text: string) => void;
  err: (text: string) => void;
}

const keyOf = (ats: string, slug: string): string => `${ats}:${slug.toLowerCase()}`;

/**
 * Searches for ATS board URLs, verifies each new slug with one request to its board and stores it.
 * `verified = true` only when the board answered 200. Company names are the slug (the DB is the
 * only place they live); search URLs, titles and snippets are never stored or logged.
 * Exit code: 0 on success or skip, 1 when every search query failed.
 */
export async function runDiscoverCompanies(opts: DiscoverCompaniesOptions): Promise<number> {
  const apiKey = opts.apiKey ?? process.env[BRAVE_KEY_ENV];
  if (!apiKey) {
    opts.out(`${BRAVE_KEY_ENV} not set, company discovery skipped\n`);
    return 0;
  }
  const now = opts.now ?? (() => new Date());
  const queries = (opts.queries ?? DISCOVERY_QUERIES).slice(0, DAILY_QUERY_BUDGET);

  const known = new Set<string>();
  const knownNames = new Set<string>();
  for (const row of opts.db
    .select({
      ats_type: companies.ats_type,
      ats_slug: companies.ats_slug,
      normalized_name: companies.normalized_name,
    })
    .from(companies)
    .all()) {
    if (row.ats_type && row.ats_slug) known.add(keyOf(row.ats_type, row.ats_slug));
    knownNames.add(row.normalized_name);
  }

  let queriesRun = 0;
  let queriesFailed = 0;
  let urlsSeen = 0;
  const candidates = new Map<string, AtsSlug>();
  for (const query of queries) {
    queriesRun++;
    let urls: string[];
    try {
      urls = await searchUrls(query, apiKey);
    } catch (e) {
      queriesFailed++;
      log.warn("Search query failed", {
        query: queriesRun,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    urlsSeen += urls.length;
    for (const url of urls) {
      const c = extractAtsSlug(url);
      if (c) candidates.set(keyOf(c.ats, c.slug), c);
    }
  }

  let duplicates = 0;
  let verified = 0;
  let notFound = 0;
  let failed = 0;
  for (const [key, c] of candidates) {
    const name = cleanLine(c.slug);
    const normalized = normalizeCompanyName(name);
    if (known.has(key) || normalized === "" || knownNames.has(normalized)) {
      duplicates++;
      continue;
    }
    let ok: boolean;
    try {
      ok = await verifyBoard(c);
    } catch (e) {
      failed++; // not stored: retried on a later run
      log.warn("Board verification failed", {
        ats: c.ats,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    const nowIso = now().toISOString();
    opts.db
      .insert(companies)
      .values({
        id: randomUUID(),
        name,
        normalized_name: normalized,
        ats_type: c.ats,
        ats_slug: c.slug,
        discovered_via: "search",
        discovered_at: nowIso,
        verified: ok,
        created_at: nowIso,
      })
      .run();
    known.add(key);
    knownNames.add(normalized);
    if (ok) verified++;
    else notFound++;
  }

  const summary = {
    queries: queriesRun,
    queries_failed: queriesFailed,
    urls: urlsSeen,
    candidates: candidates.size,
    duplicates,
    verified,
    not_found: notFound,
    verify_failed: failed,
  };
  log.info("Company discovery done", summary);
  opts.out(
    `discover-companies: ${queriesRun} queries (${queriesFailed} failed), ${candidates.size} candidates, ` +
      `${verified} new verified, ${notFound} not found, ${duplicates} known, ${failed} verify errors\n`,
  );
  if (queriesRun > 0 && queriesFailed === queriesRun) {
    opts.err("discover-companies: every search query failed\n");
    return 1;
  }
  return 0;
}
