import { randomUUID } from "node:crypto";
import { companies, log, type Db } from "@job-agent/core";
import {
  BRAVE_KEY_ENV,
  DAILY_QUERY_BUDGET,
  DISCOVERY_QUERIES,
  extractAtsSlug,
  fetchYcCompanies,
  searchUrls,
  verifyBoard,
  type AtsSlug,
} from "@job-agent/sources";
import { scanCareers, type FetchPage } from "./apply-links/careers.ts";
import { isPollable } from "./apply-links/ats-links.ts";
import { cleanLine, normalizeCompanyName } from "./normalize/index.ts";

/** At most this many new YC directory companies are checked (careers scan + board GET) per run. */
export const MAX_YC_COMPANIES_PER_RUN = 30;

export interface DiscoverCompaniesOptions {
  db: Db;
  /** Defaults to process.env[BRAVE_KEY_ENV]. */
  apiKey?: string | undefined;
  /** Override the query list (tests). Always capped at DAILY_QUERY_BUDGET. */
  queries?: readonly string[];
  now?: () => Date;
  /** Careers page fetcher for the YC part; default is the company-research fetcher (msw stands in for tests). */
  fetchPage?: FetchPage;
  out: (text: string) => void;
  err: (text: string) => void;
}

const keyOf = (ats: string, slug: string): string => `${ats}:${slug.toLowerCase()}`;

/**
 * Searches for ATS board URLs, verifies each new slug with one request to its board and stores it.
 * `verified = true` only when the board answered 200. Company names are the slug (the DB is the
 * only place they live); search URLs, titles and snippets are never stored or logged.
 * Also adds hiring YC companies from the public directory (no Brave key needed): ATS from the website URL, else the
 * careers-page scan, then the same one-GET verification. A company without a findable ATS is stored with no board
 * (`ats_checked_at` set) so later runs do not scan it again.
 * Exit code: 0 on success or skip, 1 when every search query failed or the YC directory could not be read.
 */
export async function runDiscoverCompanies(opts: DiscoverCompaniesOptions): Promise<number> {
  const apiKey = opts.apiKey ?? process.env[BRAVE_KEY_ENV];
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

  const store = (
    name: string,
    normalized: string,
    c: AtsSlug | null,
    via: "search" | "yc_directory",
    ok: boolean,
    domain: string | null,
  ): void => {
    const nowIso = now().toISOString();
    opts.db
      .insert(companies)
      .values({
        id: randomUUID(),
        name,
        normalized_name: normalized,
        domain,
        ats_type: c?.ats ?? null,
        ats_slug: c?.slug ?? null,
        discovered_via: via,
        discovered_at: nowIso,
        ...(c === null ? { ats_checked_at: nowIso } : {}),
        verified: ok,
        created_at: nowIso,
      })
      .run();
    if (c) known.add(keyOf(c.ats, c.slug));
    knownNames.add(normalized);
  };

  let code = 0;
  if (!apiKey) {
    opts.out(`${BRAVE_KEY_ENV} not set, search discovery skipped\n`);
  } else {
    code = await searchDiscovery(apiKey);
  }
  const yc = await ycDiscovery();
  return code !== 0 || yc.failed ? 1 : 0;

  async function searchDiscovery(apiKey: string): Promise<number> {
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
      store(name, normalized, c, "search", ok, null);
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

  async function ycDiscovery(): Promise<{ failed: boolean }> {
    const s = {
      seen: 0,
      checked: 0,
      verified: 0,
      notFound: 0,
      noAts: 0,
      known: 0,
      errors: 0,
      requests: 0,
    };
    let dir;
    try {
      dir = await fetchYcCompanies();
    } catch (e) {
      log.warn("YC directory failed", { error: e instanceof Error ? e.message : String(e) });
      opts.err("discover-companies: YC directory failed, YC companies skipped\n");
      return { failed: true };
    }
    s.requests = dir.requests;
    s.seen = dir.companies.length;
    for (const yc of dir.companies) {
      const name = cleanLine(yc.name);
      const normalized = normalizeCompanyName(name);
      if (normalized === "" || knownNames.has(normalized)) {
        s.known++;
        continue;
      }
      if (s.checked >= MAX_YC_COMPANIES_PER_RUN) break;
      s.checked++;
      const host = websiteHost(yc.website);
      let found: AtsSlug | null = yc.website ? extractAtsSlug(yc.website) : null;
      let incomplete = false;
      if (!found && host) {
        const scan = await scanCareers(host, opts.fetchPage);
        s.requests += scan.requests;
        incomplete = scan.incomplete;
        const board = scan.boards.find((l) => isPollable(l.vendor) && l.slug !== "");
        if (board && isPollable(board.vendor)) found = { ats: board.vendor, slug: board.slug };
      }
      if (!found) {
        if (incomplete) {
          s.errors++; // not stored: scanned again on a later run
        } else {
          s.noAts++;
          store(name, normalized, null, "yc_directory", false, host);
        }
        continue;
      }
      if (known.has(keyOf(found.ats, found.slug))) {
        s.known++;
        continue;
      }
      let ok: boolean;
      try {
        s.requests++;
        ok = await verifyBoard(found);
      } catch (e) {
        s.errors++;
        log.warn("Board verification failed", {
          ats: found.ats,
          error: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      store(name, normalized, found, "yc_directory", ok, host);
      if (ok) s.verified++;
      else s.notFound++;
    }
    log.info("YC company discovery done", s);
    opts.out(
      `discover-companies yc: ${s.seen} in directory, ${s.checked} checked (cap ${MAX_YC_COMPANIES_PER_RUN}), ` +
        `${s.verified} new verified, ${s.notFound} not found, ${s.noAts} no ATS, ${s.known} known, ` +
        `${s.errors} errors, ${s.requests} requests\n`,
    );
    return { failed: false };
  }
}

/** `https://www.acme.io/careers` -> `acme.io`; null for anything that is not a plain http(s) host. */
function websiteHost(website: string | null): string | null {
  if (!website) return null;
  try {
    const u = new URL(website);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}
