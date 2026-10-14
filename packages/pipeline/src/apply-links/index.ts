import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  analysis,
  apply_links,
  companies,
  intel,
  log,
  postings,
  type Company,
  type Db,
  type Posting,
} from "@job-agent/core";
import { normalizeTitle } from "../dedupe/index.ts";
import { ATS_SOURCE_NAMES } from "../filters/keywords.ts";
import { normalizeCompanyName } from "../normalize/index.ts";
import {
  ApplyHttp,
  ATS_HOSTS,
  isSameCompany,
  lookupBoard,
  type AtsType,
  type Board,
} from "./boards.ts";
import { saveFoundAts } from "./save-ats.ts";
import { slugCandidates } from "./slugs.ts";

export { MAX_SLUG_CANDIDATES } from "./slugs.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** An `unknown` apply link is looked up again after this long. */
export const UNKNOWN_RECHECK_MS = 7 * DAY_MS;
/** A company whose board lookup found nothing is not searched again for this long. */
export const ATS_NEGATIVE_CACHE_MS = 30 * DAY_MS;

export interface ResolveApplyOptions {
  db: Db;
  limit?: number | undefined;
  /** Where to append found ATS boards (`companies.yaml` dir + backup dir). Omitted = nothing is written. */
  saveAts?: { configDir: string; backupDir: string };
  now?: () => Date;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

interface Resolution {
  apply_url: string;
  apply_type: "ats" | "unknown";
  method: "ats_db" | "ats_board" | "source";
  ats_type?: AtsType;
  ats_slug?: string;
  reason?: string;
}

const titleKey = (title: string): string => normalizeTitle(title);

/** `normalized company | normalized title` -> job link, for canonical postings of ATS sources. */
function loadAtsIndex(db: Db): Map<string, string> {
  const rows = db
    .select({
      company_name: postings.company_name,
      company_key: companies.normalized_name,
      title: postings.title,
      url: postings.url,
      apply_url: postings.apply_url,
    })
    .from(postings)
    .leftJoin(companies, eq(postings.company_id, companies.id))
    .where(
      and(isNull(postings.canonical_posting_id), inArray(postings.source, [...ATS_SOURCE_NAMES])),
    )
    .orderBy(postings.first_seen_at, postings.id)
    .all();
  const index = new Map<string, string>();
  for (const r of rows) {
    const key = `${r.company_key ?? normalizeCompanyName(r.company_name)}|${titleKey(r.title)}`;
    if (!index.has(key)) index.set(key, r.apply_url ?? r.url);
  }
  return index;
}

function selectPostings(db: Db, now: Date, limit: number | undefined): Posting[] {
  const recheckBefore = new Date(now.getTime() - UNKNOWN_RECHECK_MS).toISOString();
  const query = db
    .select({ posting: postings })
    .from(postings)
    .innerJoin(analysis, eq(analysis.posting_id, postings.id))
    .leftJoin(intel, eq(intel.posting_id, postings.id))
    .leftJoin(apply_links, eq(apply_links.posting_id, postings.id))
    .where(
      and(
        isNull(postings.canonical_posting_id),
        sql`${postings.normalized_at} IS NOT NULL`,
        eq(analysis.decision, "keep"),
        // No intel row, or one not decided yet (no API key: scam rules create pending rows), or kept.
        or(isNull(intel.final_decision), eq(intel.final_decision, "keep")),
        sql`${postings.source} NOT IN (${sql.join(
          ATS_SOURCE_NAMES.map((s) => sql`${s}`),
          sql`, `,
        )})`,
        or(
          isNull(apply_links.id),
          and(eq(apply_links.apply_type, "unknown"), lt(apply_links.checked_at, recheckBefore)),
        ),
      ),
    )
    .orderBy(desc(postings.first_seen_at), desc(postings.id));
  const rows = limit !== undefined ? query.limit(limit).all() : query.all();
  return rows.map((r) => r.posting);
}

/** The first job on the board whose normalized title equals the posting's. */
function findJob(board: Board, title: string): string | undefined {
  const key = titleKey(title);
  if (key === "") return undefined;
  return board.jobs.find((j) => titleKey(j.title) === key)?.url;
}

export async function runResolveApply(opts: ResolveApplyOptions): Promise<number> {
  const { db } = opts;
  const out = opts.out ?? (() => undefined);
  const err = opts.err ?? (() => undefined);
  const now = opts.now ?? (() => new Date());
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
    err(`resolve-apply: --limit must be a positive integer\n`);
    return 1;
  }

  const http = new ApplyHttp();
  const selected = selectPostings(db, now(), opts.limit);
  const atsIndex = loadAtsIndex(db);
  /** Companies whose slug search already ran in this run: result is the board found (or null). */
  const searched = new Map<string, Board | null>();

  let dbHits = 0;
  let boardHits = 0;
  let unknown = 0;
  let failed = 0;

  const source = (p: Posting, reason: string): Resolution => ({
    apply_url: p.apply_url ?? p.url,
    apply_type: "unknown",
    method: "source",
    reason,
  });

  /** Step 1c: slug guesses for a company with no usable stored board. Sets ats_checked_at. */
  async function guessBoard(company: Company, p: Posting): Promise<Board | null> {
    if (searched.has(company.id)) return searched.get(company.id) ?? null;
    const checkedAt = company.ats_checked_at ? Date.parse(company.ats_checked_at) : NaN;
    if (!Number.isNaN(checkedAt) && now().getTime() - checkedAt < ATS_NEGATIVE_CACHE_MS) {
      searched.set(company.id, null);
      return null;
    }

    const titleMatches = (t: string) => titleKey(t) === titleKey(p.title) && titleKey(t) !== "";
    const names = slugCandidates(company.name);
    const srNames = slugCandidates(company.name, true);
    let incomplete = false;
    let found: Board | null = null;
    for (let i = 0; i < names.length && !found; i++) {
      for (const ats of ATS_HOSTS) {
        if (company.ats_type === ats && company.ats_slug === names[i]) continue;
        const slug = ats === "smartrecruiters" ? (srNames[i] ?? names[i] ?? "") : (names[i] ?? "");
        const lookup = await lookupBoard(http, ats, slug, (boardName) =>
          boardName === null
            ? true
            : isSameCompany({ ats, slug, name: boardName, jobs: [] }, company, () => true),
        );
        if (lookup.kind === "error" || lookup.kind === "blocked") incomplete = true;
        if (lookup.kind !== "ok") continue;
        if (isSameCompany(lookup.board, company, titleMatches)) {
          found = lookup.board;
          break;
        }
      }
    }

    const stamp = now().toISOString();
    if (found) {
      db.update(companies)
        .set({
          ats_type: found.ats,
          ats_slug: found.slug,
          ...(company.discovered_via === "config"
            ? {}
            : { discovered_via: "apply_resolve" as const }),
          discovered_at: company.discovered_at ?? stamp,
          verified: true,
          ats_checked_at: stamp,
        })
        .where(eq(companies.id, company.id))
        .run();
    } else if (!incomplete) {
      // A lookup cut short by a 429 or a network error is retried next run instead of cached for 30 days.
      db.update(companies).set({ ats_checked_at: stamp }).where(eq(companies.id, company.id)).run();
    }
    searched.set(company.id, found);
    return found;
  }

  async function resolve(p: Posting): Promise<Resolution> {
    // 1a: an ATS posting already in the DB with the same company and title.
    const company =
      p.company_id !== null
        ? db.select().from(companies).where(eq(companies.id, p.company_id)).get()
        : undefined;
    const key = `${company?.normalized_name ?? normalizeCompanyName(p.company_name)}|${titleKey(p.title)}`;
    const dbUrl = atsIndex.get(key);
    if (dbUrl !== undefined) return { apply_url: dbUrl, apply_type: "ats", method: "ats_db" };
    if (!company) return source(p, "no company row");

    // 1b: the company's stored board.
    let board: Board | null = null;
    if (company.ats_type && company.ats_slug) {
      const lookup = await lookupBoard(http, company.ats_type, company.ats_slug);
      if (lookup.kind === "ok") {
        board = lookup.board;
      }
    }
    // 1c: slug guesses.
    if (!board) board = await guessBoard(company, p);
    if (!board) return source(p, "no ATS board found");

    const url = findJob(board, p.title);
    if (url === undefined) {
      return source(p, "board found, no matching title");
    }
    return {
      apply_url: url,
      apply_type: "ats",
      method: "ats_board",
      ats_type: board.ats,
      ats_slug: board.slug,
    };
  }

  for (const p of selected) {
    let r: Resolution;
    try {
      r = await resolve(p);
    } catch (e) {
      failed++;
      log.error("resolve-apply failed for a posting", { posting_id: p.id, error: String(e) });
      err(`resolve-apply: posting ${p.id} failed: ${e instanceof Error ? e.message : String(e)}\n`);
      continue;
    }
    const row = {
      posting_id: p.id,
      apply_url: r.apply_url,
      apply_type: r.apply_type,
      method: r.method,
      ats_type: r.ats_type ?? null,
      ats_slug: r.ats_slug ?? null,
      found_on: p.source,
      reason: r.reason ?? null,
      checked_at: now().toISOString(),
    };
    db.insert(apply_links)
      .values({ id: randomUUID(), ...row })
      .onConflictDoUpdate({ target: apply_links.posting_id, set: row })
      .run();
    if (r.method === "ats_db") dbHits++;
    else if (r.method === "ats_board") boardHits++;
    else unknown++;
  }

  out(
    `resolve-apply: checked ${selected.length}, ats ${dbHits + boardHits} (db ${dbHits}, board ${boardHits}), unknown ${unknown}, requests ${http.requests}${failed > 0 ? `, failed ${failed}` : ""}\n`,
  );
  let saveCode = 0;
  if (opts.saveAts) {
    saveCode = saveFoundAts({ db, ...opts.saveAts, now, out, err });
  }
  return failed > 0 || saveCode !== 0 ? 1 : 0;
}
