import { and, eq, gte, inArray } from "drizzle-orm";
import { companies, postings, type Db, type Posting } from "@job-agent/core";
import { ATS_SOURCE_NAMES } from "../filters/keywords.ts";
import { normalizeCompanyName } from "../normalize/index.ts";
import { normalizeTitle } from "../digest/group.ts";
import { hostOf, isAtsHost, type ScamVerification } from "./scam.ts";

const DAY_MS = 86_400_000;
const SEEN_WITHIN_DAYS = 7;
const TITLE_JACCARD = 0.8;

const tokens = (title: string) =>
  new Set(
    normalizeTitle(title.replace(/\([^)]*\)/g, " "))
      .split(" ")
      .filter(Boolean),
  );

/** Equal after normalisation, or token Jaccard >= 0.8. */
export function titlesMatch(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  const shared = [...ta].filter((t) => tb.has(t)).length;
  return shared / (ta.size + tb.size - shared) >= TITLE_JACCARD;
}

/**
 * Does the role exist on the company's own ATS? Uses only rows already in the DB (R6 section 3), no HTTP.
 * - verified: the posting itself came from an ATS adapter, its apply URL is on the company's configured ATS
 *   board, or an ATS posting of the same company (seen in the last 7 days) has a matching title.
 * - missing: the company has a configured ATS and its board was read in the last 24 h, but no title matches.
 * - unknown: anything else (no company row, no ATS, board not read recently).
 */
export function verifyAgainstAts(db: Db, posting: Posting, now: Date): ScamVerification {
  if (ATS_SOURCE_NAMES.includes(posting.source)) return "verified";

  const company = posting.company_id
    ? db.select().from(companies).where(eq(companies.id, posting.company_id)).get()
    : db
        .select()
        .from(companies)
        .where(eq(companies.normalized_name, normalizeCompanyName(posting.company_name)))
        .get();
  if (!company) return "unknown";

  const applyHost = posting.apply_url ? hostOf(posting.apply_url) : null;
  if (applyHost && isAtsHost(applyHost) && company.ats_slug) {
    const firstSegment = new URL(posting.apply_url ?? "").pathname.split("/")[1]?.toLowerCase();
    if (firstSegment === company.ats_slug.toLowerCase()) return "verified";
  }

  const since = new Date(now.getTime() - SEEN_WITHIN_DAYS * DAY_MS).toISOString();
  const siblings = db
    .select({ title: postings.title, last_seen_at: postings.last_seen_at })
    .from(postings)
    .where(
      and(
        eq(postings.company_id, company.id),
        inArray(postings.source, [...ATS_SOURCE_NAMES]),
        gte(postings.last_seen_at, since),
      ),
    )
    .all();
  if (siblings.some((s) => titlesMatch(s.title, posting.title))) return "verified";

  if (company.ats_type && company.ats_slug) {
    const boardSince = new Date(now.getTime() - DAY_MS).toISOString();
    if (siblings.some((s) => s.last_seen_at >= boardSince)) return "missing";
  }
  return "unknown";
}
