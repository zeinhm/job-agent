import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  analysis,
  APPLY_METHODS,
  APPLY_TYPES,
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
  hostMatchesDomain,
  isSameCompany,
  lookupBoard,
  type Board,
} from "./boards.ts";
import { isPollable } from "./ats-links.ts";
import {
  domainResemblesCompany,
  scanCareers,
  type CareersScan,
  type FetchPage,
} from "./careers.ts";
import {
  hostIsOn,
  PAID_ONLY_HOSTS,
  routeFromText,
  SIGNUP_WALL_HOSTS,
  textLinks,
} from "./posting-text.ts";
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
  /** Careers page fetcher; default is the company-research fetcher (tests inject nothing, msw stands in). */
  fetchPage?: FetchPage;
}

type ApplyType = (typeof apply_links.$inferSelect)["apply_type"];
type ApplyMethod = (typeof apply_links.$inferSelect)["method"];

interface Resolution {
  apply_url: string;
  apply_type: ApplyType;
  method: ApplyMethod;
  ats_type?: string;
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

/** Companies whose domain is vouched for by the owner's config or by a non-HN posting link (see `domainTrusted`). */
const TRUSTED_VIA = new Set(["config", "manual", "search"]);

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
  /** One careers scan per company and run. */
  const careers = new Map<string, CareersScan>();

  const methods = new Map<ApplyMethod, number>();
  const types = new Map<ApplyType, number>();
  let failed = 0;

  const source = (p: Posting, reason: string): Resolution => ({
    apply_url: p.apply_url ?? p.url,
    apply_type: "unknown",
    method: "source",
    reason,
  });

  /**
   * M3 (batch audit t_c9a36eac): a company domain may come from an anonymous HN comment. It is fetched only when the
   * config vouches for it, a posting from another source links to it, or its name resembles the company name.
   */
  function domainTrusted(company: Company, domain: string): boolean {
    if (company.discovered_via !== null && TRUSTED_VIA.has(company.discovered_via)) return true;
    if (domainResemblesCompany(domain, company.name)) return true;
    const others = db
      .select({ url: postings.url, apply_url: postings.apply_url })
      .from(postings)
      .where(and(eq(postings.company_id, company.id), sql`${postings.source} <> 'hn'`))
      .all();
    return others.some(
      (o) =>
        (o.apply_url !== null && hostMatchesDomain(o.apply_url, domain)) ||
        hostMatchesDomain(o.url, domain),
    );
  }

  function saveBoard(company: Company, board: Board): void {
    const stamp = now().toISOString();
    db.update(companies)
      .set({
        ats_type: board.ats,
        ats_slug: board.slug,
        ...(company.discovered_via === "config"
          ? {}
          : { discovered_via: "apply_resolve" as const }),
        discovered_at: company.discovered_at ?? stamp,
        verified: true,
        ats_checked_at: stamp,
      })
      .where(eq(companies.id, company.id))
      .run();
  }

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
    let incomplete = careers.get(company.id)?.incomplete ?? false;
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

    if (found) {
      saveBoard(company, found);
    } else if (!incomplete) {
      // A lookup cut short by a 429 or a network error is retried next run instead of cached for 30 days.
      db.update(companies)
        .set({ ats_checked_at: now().toISOString() })
        .where(eq(companies.id, company.id))
        .run();
    }
    searched.set(company.id, found);
    return found;
  }

  type CareersResult = { hit: Resolution } | { board: Board } | { note: string } | null;

  /** Step 2: the company's careers pages (only when the domain is trusted and no board lookup is cached). */
  async function careersStep(company: Company, p: Posting): Promise<CareersResult> {
    const domain = company.domain;
    if (!domain) return null;
    const checkedAt = company.ats_checked_at ? Date.parse(company.ats_checked_at) : NaN;
    if (!Number.isNaN(checkedAt) && now().getTime() - checkedAt < ATS_NEGATIVE_CACHE_MS)
      return null;
    if (!domainTrusted(company, domain)) {
      return {
        note: `careers page skipped: domain ${domain} has no source besides HN comments and does not resemble the company name`,
      };
    }
    let scan = careers.get(company.id);
    if (scan === undefined) {
      scan = await scanCareers(domain, opts.fetchPage);
      http.requests += scan.requests;
      careers.set(company.id, scan);
    }

    const key = titleKey(p.title);
    // A job link on the page whose visible text is the posting's title.
    if (key !== "") {
      const hit = scan.anchors.find((a) => a.link.kind === "job" && titleKey(a.text) === key);
      if (hit) {
        return {
          hit: {
            apply_url: hit.link.url,
            apply_type: "ats",
            method: "careers_page",
            ats_type: hit.link.vendor,
            ...(hit.link.slug !== "" ? { ats_slug: hit.link.slug } : {}),
          },
        };
      }
    }
    // A pollable board named on the page: fetch it and match the title as in step 1.
    let firstBoard: Board | null = null;
    for (const b of scan.boards.filter((l) => isPollable(l.vendor)).slice(0, 3)) {
      if (!isPollable(b.vendor)) continue;
      const lookup = await lookupBoard(http, b.vendor, b.slug);
      if (lookup.kind !== "ok") continue;
      firstBoard ??= lookup.board;
      const url = findJob(lookup.board, p.title);
      if (url !== undefined) {
        saveBoard(company, lookup.board);
        return {
          hit: {
            apply_url: url,
            apply_type: "ats",
            method: "careers_page",
            ats_type: lookup.board.ats,
            ats_slug: lookup.board.slug,
          },
        };
      }
    }
    if (firstBoard) {
      saveBoard(company, firstBoard);
      return { board: firstBoard };
    }
    // A board of a vendor we do not poll: the board link is the route.
    const other = scan.boards.find((l) => !isPollable(l.vendor));
    if (other?.boardUrl) {
      return {
        hit: {
          apply_url: other.boardUrl,
          apply_type: "company_form",
          method: "careers_page",
          ats_type: other.vendor,
          ...(other.slug !== "" ? { ats_slug: other.slug } : {}),
          reason: `${other.vendor} board linked on the careers page, no job matched the title`,
        },
      };
    }
    return { note: scan.note === "" ? "careers page: no ATS link" : `careers page: ${scan.note}` };
  }

  /** Step 3 and the paid / sign-up labels: what the posting itself says. */
  function textStep(p: Posting, company: Company | undefined, notes: string[]): Resolution {
    const links = textLinks(p.description_text, [p.apply_url]);
    const domain = company?.domain ?? null;
    const route = routeFromText(links, domain);
    if (route) {
      const untrusted =
        route.type === "company_form" && company && domain && !domainTrusted(company, domain);
      const skipped = notes.filter((n) => n.startsWith("careers page skipped"));
      const reason = [
        untrusted ? `${route.reason} (domain only seen in HN comments)` : route.reason,
        ...skipped,
      ].join("; ");
      return route.type === "ats"
        ? {
            apply_url: route.url,
            apply_type: "ats",
            method: "posting_text",
            ats_type: route.link.vendor,
            ...(route.link.slug !== "" ? { ats_slug: route.link.slug } : {}),
            reason,
          }
        : { apply_url: route.url, apply_type: "company_form", method: "posting_text", reason };
    }
    const own = p.apply_url ?? p.url;
    const paid = [own, ...links.urls].find((u) => hostIsOn(u, PAID_ONLY_HOSTS));
    if (paid !== undefined) {
      return {
        apply_url: paid,
        apply_type: "paid_aggregator",
        method: "source",
        reason: [...notes, "the only route found is on a paid-only site"].join("; "),
      };
    }
    if (hostIsOn(own, SIGNUP_WALL_HOSTS)) {
      return {
        apply_url: own,
        apply_type: "signup_required",
        method: "source",
        reason: [...notes, "free sign-up wall, never signed up"].join("; "),
      };
    }
    return source(p, notes.join("; ") || "no apply route found");
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
    const notes: string[] = [];
    if (!company) return textStep(p, undefined, ["no company row"]);

    // 1b: the company's stored board.
    let board: Board | null = null;
    if (company.ats_type && company.ats_slug) {
      const lookup = await lookupBoard(http, company.ats_type, company.ats_slug);
      if (lookup.kind === "ok") {
        board = lookup.board;
      }
    }
    // 2: the careers page, before blind slug guesses (owner decision 2026-10-14).
    if (!board) {
      const c = await careersStep(company, p);
      if (c && "hit" in c) return c.hit;
      if (c && "board" in c) board = c.board;
      else if (c) notes.push(c.note);
    }
    // 1c: slug guesses.
    if (!board) board = await guessBoard(company, p);
    if (!board) {
      return textStep(p, company, ["no ATS board found", ...notes]);
    }

    const url = findJob(board, p.title);
    if (url === undefined) {
      return textStep(p, company, ["board found, no matching title", ...notes]);
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
    methods.set(r.method, (methods.get(r.method) ?? 0) + 1);
    types.set(r.apply_type, (types.get(r.apply_type) ?? 0) + 1);
  }

  const count = <T extends string>(m: Map<T, number>, keys: readonly T[]): string =>
    keys.map((k) => `${k} ${m.get(k) ?? 0}`).join(", ");
  out(
    `resolve-apply: checked ${selected.length}, methods: ${count(
      methods,
      APPLY_METHODS.filter((m) => m !== "llm"),
    )}; types: ${count(types, APPLY_TYPES)}; requests ${http.requests}${failed > 0 ? `, failed ${failed}` : ""}\n`,
  );
  let saveCode = 0;
  if (opts.saveAts) {
    saveCode = saveFoundAts({ db, ...opts.saveAts, now, out, err });
  }
  return failed > 0 || saveCode !== 0 ? 1 : 0;
}
