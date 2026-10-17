import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  apply_links,
  companies,
  HttpError,
  httpGet,
  intel,
  log,
  posting_questions,
  postings,
  type Db,
} from "@job-agent/core";
import { matchQuestions } from "@job-agent/apply";
import { atsLinkOf, effectiveApplyUrl, greenhouseJobIdOf } from "../apply-links/ats-links.ts";
import { ATS_SOURCE_NAMES } from "../filters/keywords.ts";
import {
  BOARD_NOT_FOUND,
  greenhouseSlugCandidates,
  resolveGreenhouseSlug,
} from "./greenhouse-board.ts";
import { normalizeLabel } from "./normalize.ts";
import {
  ParseError,
  parseGreenhouse,
  parseRecruiteeOffers,
  parseWorkable,
  recruiteeQuestions,
  type FetchedQuestion,
  type RecruiteeOffer,
} from "./parse.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Questions fetched less than this long ago are not fetched again (research t_5c4e4567, "Re-fetch"). */
export const REFETCH_WINDOW_MS = 7 * DAY_MS;
/** Question fetches per run when `--limit` is not given (research: about 50 per run). */
export const DEFAULT_LIMIT = 50;
/** One request per host every 2 s (research "Pacing"; the shared client enforces it per host). */
const MIN_INTERVAL_MS = 2000;
export const NO_ENDPOINT = "no public questions endpoint";

/** ATSs with a public, keyless, read-only questions endpoint (research t_5c4e4567). */
const FETCHABLE = ["greenhouse", "workable", "recruitee"] as const;
type Fetchable = (typeof FETCHABLE)[number];
const isFetchable = (v: string): v is Fetchable => (FETCHABLE as readonly string[]).includes(v);

const SAFE_SLUG = /^[A-Za-z0-9]([A-Za-z0-9_-]*[A-Za-z0-9])?$/;
const JOB_CODE = /^[A-Za-z0-9]+$/;

type HttpResult =
  | { kind: "ok"; body: unknown }
  | { kind: "missing" }
  | { kind: "deferred"; status: number }
  | { kind: "error"; reason: string };

/** GET-only JSON client over the shared client. A host that answers 401, 403 or 429 gets no more requests this run. */
export class QuestionsHttp {
  requests = 0;
  /** host -> the status that stopped it */
  readonly blockedHosts = new Map<string, number>();

  async getJson(url: string): Promise<HttpResult> {
    const host = new URL(url).hostname;
    const blocked = this.blockedHosts.get(host);
    if (blocked !== undefined) return { kind: "deferred", status: blocked };
    this.requests++;
    let res: Response;
    try {
      // Redirects are never followed: the questions stay on the ATS API host that was asked (a 3xx is a failed fetch).
      res = await httpGet(url, { minIntervalMs: MIN_INTERVAL_MS, followRedirects: false });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : null;
      if (status !== null && status >= 300 && status < 400) {
        return { kind: "error", reason: `redirect not followed (HTTP ${status})` };
      }
      if (status === 404) return { kind: "missing" };
      if (status === 401 || status === 403 || status === 429) {
        this.blockedHosts.set(host, status);
        log.warn("fetch-questions: host refused, no more requests to it this run", {
          host,
          status,
        });
        return { kind: "deferred", status };
      }
      return { kind: "error", reason: status === null ? "network error" : `HTTP ${status}` };
    }
    try {
      return { kind: "ok", body: (await res.json()) as unknown };
    } catch {
      return { kind: "error", reason: "response is not JSON" };
    }
  }
}

interface Target {
  ats: Fetchable;
  /** Board slug (Greenhouse board token, Recruitee subdomain); "" for Workable, which needs none. */
  slug: string;
  /** Greenhouse job id, Workable shortcode, or Recruitee offer id / slug. */
  jobId: string;
  offerSlug: string;
}

/** A Greenhouse job on a company career page (`?gh_jid=`) whose board slug is not stored: verify these candidates. */
interface SlugLookup {
  jobId: string;
  candidates: string[];
}

type TargetResult =
  { target: Target } | { ats: string; skip: string } | { ats: "greenhouse"; lookup: SlugLookup };

interface Candidate {
  id: string;
  company_name: string | null;
  company_id: string | null;
  link_id: string | null;
  /** `apply_links.apply_url`: the resolved link, or the owner's correction (method `owner`). */
  link_url: string | null;
  source: string;
  external_id: string;
  url: string;
  apply_url: string | null;
  updated_at: string | null;
  link_ats: string | null;
  link_slug: string | null;
  company_ats: string | null;
  company_slug: string | null;
}

/** Which ATS, board and job a posting's questions live at. Skips carry the reason. */
export function resolveTarget(c: Candidate): TargetResult {
  const applyUrl = effectiveApplyUrl(c.link_url, c.apply_url, c.url);
  const link = atsLinkOf(applyUrl) ?? atsLinkOf(c.url);
  const ownSource = (ATS_SOURCE_NAMES as readonly string[]).includes(c.source) ? c.source : null;
  const ats = link?.vendor ?? c.link_ats ?? ownSource ?? "unknown";
  if (ats === "unknown") return { ats, skip: "no ATS link recognised" };
  if (!isFetchable(ats)) return { ats, skip: NO_ENDPOINT };

  const stored =
    (c.link_ats === ats ? c.link_slug : null) ?? (c.company_ats === ats ? c.company_slug : null);
  const slug = link?.vendor === ats && link.slug !== "" ? link.slug : (stored ?? "");
  const own = c.source === ats;
  const url = new URL(applyUrl, "https://invalid.example/");
  const seg = url.pathname.split("/").filter((s) => s !== "");

  switch (ats) {
    case "greenhouse": {
      const jobId = own ? c.external_id : greenhouseJobIdOf(applyUrl);
      if (!/^\d+$/.test(jobId)) return { ats, skip: "no job id in the apply link" };
      if (!SAFE_SLUG.test(slug)) {
        if (own) return { ats, skip: "no board slug" };
        const candidates = greenhouseSlugCandidates(c.company_name, applyUrl);
        return { ats, lookup: { jobId, candidates } };
      }
      return { target: { ats, slug, jobId, offerSlug: "" } };
    }
    case "workable": {
      const at = seg.indexOf("j");
      const jobId = own ? c.external_id : at >= 0 ? (seg[at + 1] ?? "") : "";
      if (!JOB_CODE.test(jobId)) return { ats, skip: "no job code in the apply link" };
      return { target: { ats, slug: "", jobId, offerSlug: "" } };
    }
    case "recruitee": {
      const at = seg.indexOf("o");
      const offerSlug = at >= 0 ? (seg[at + 1] ?? "") : "";
      const jobId = own && /^\d+$/.test(c.external_id) ? c.external_id : "";
      if (jobId === "" && offerSlug === "") return { ats, skip: "no offer in the apply link" };
      if (!SAFE_SLUG.test(slug)) return { ats, skip: "no board slug" };
      return { target: { ats, slug, jobId, offerSlug } };
    }
  }
}

type Outcome =
  | { kind: "questions"; questions: FetchedQuestion[] }
  | { kind: "gone"; reason: string }
  | { kind: "deferred"; status: number }
  | { kind: "error"; reason: string };

/** Per-run cache of Recruitee boards: one request per company, however many postings are asked about. */
type RecruiteeBoard =
  { kind: "ok"; offers: RecruiteeOffer[] } | Exclude<Outcome, { kind: "questions" }>;

async function fetchOne(
  t: Target,
  http: QuestionsHttp,
  boards: Map<string, Promise<RecruiteeBoard>>,
): Promise<Outcome> {
  try {
    switch (t.ats) {
      case "greenhouse": {
        const res = await http.getJson(
          `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t.slug)}/jobs/${t.jobId}?questions=true`,
        );
        if (res.kind === "missing") return { kind: "gone", reason: "job not found (closed)" };
        if (res.kind !== "ok") return res;
        return { kind: "questions", questions: parseGreenhouse(res.body) };
      }
      case "workable": {
        const res = await http.getJson(
          `https://apply.workable.com/api/v1/jobs/${encodeURIComponent(t.jobId)}/form`,
        );
        // Undocumented endpoint (research): 404 means no form for that code.
        if (res.kind === "missing") return { kind: "gone", reason: "no form for this job" };
        if (res.kind !== "ok") return res;
        return { kind: "questions", questions: parseWorkable(res.body) };
      }
      case "recruitee": {
        let board = boards.get(t.slug);
        if (board === undefined) {
          board = (async (): Promise<RecruiteeBoard> => {
            const res = await http.getJson(
              `https://${t.slug.toLowerCase()}.recruitee.com/api/offers/`,
            );
            if (res.kind === "missing") return { kind: "gone", reason: "board not found" };
            if (res.kind !== "ok") return res;
            return { kind: "ok", offers: parseRecruiteeOffers(res.body) };
          })();
          boards.set(t.slug, board);
        }
        const found = await board;
        if (found.kind !== "ok") return found;
        const offer = found.offers.find((o) =>
          t.jobId !== "" ? String(o.id) === t.jobId : o.slug === t.offerSlug,
        );
        if (offer === undefined) return { kind: "gone", reason: "offer not on the board (closed)" };
        return { kind: "questions", questions: recruiteeQuestions(offer) };
      }
    }
  } catch (err) {
    if (err instanceof ParseError) return { kind: "error", reason: err.message };
    return { kind: "error", reason: "unexpected failure" };
  }
}

export interface FetchQuestionsOptions {
  db: Db;
  limit?: number | undefined;
  now?: () => Date;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

/** Newest-first kept ATS postings that are still open and whose questions are missing or due for a refresh. */
function selectCandidates(db: Db, now: Date): Candidate[] {
  const staleBefore = new Date(now.getTime() - REFETCH_WINDOW_MS).toISOString();
  const rows = db
    .select({
      id: postings.id,
      company_name: postings.company_name,
      company_id: postings.company_id,
      link_id: apply_links.id,
      link_url: apply_links.apply_url,
      source: postings.source,
      external_id: postings.external_id,
      url: postings.url,
      apply_url: postings.apply_url,
      updated_at: postings.updated_at,
      link_ats: apply_links.ats_type,
      link_slug: apply_links.ats_slug,
      company_ats: companies.ats_type,
      company_slug: companies.ats_slug,
    })
    .from(postings)
    .innerJoin(intel, eq(intel.posting_id, postings.id))
    .leftJoin(apply_links, eq(apply_links.posting_id, postings.id))
    .leftJoin(companies, eq(postings.company_id, companies.id))
    .where(
      and(
        isNull(postings.canonical_posting_id),
        eq(intel.final_decision, "keep"),
        // An ATS source's own postings have no apply_links row (resolve-apply skips them): they are ATS by source.
        sql`(${apply_links.apply_type} = 'ats' OR (${apply_links.id} IS NULL AND ${postings.source} IN (${sql.join(
          ATS_SOURCE_NAMES.map((s) => sql`${s}`),
          sql`, `,
        )})))`,
        // Never for a posting the owner already decided on (newest status action; "later" keeps it open).
        sql`COALESCE((SELECT r.action FROM reviews r WHERE r.posting_id = ${postings.id} AND r.action IN ('interested', 'applied_manually', 'not_interested', 'later') ORDER BY r.reviewed_at DESC, r.id DESC LIMIT 1), 'later') = 'later'`,
      ),
    )
    .orderBy(sql`${postings.first_seen_at} DESC`, postings.id)
    .all();
  if (rows.length === 0) return [];
  const lastFetched = new Map<string, string>();
  for (const r of db
    .select({
      id: posting_questions.posting_id,
      at: sql<string>`max(${posting_questions.fetched_at})`,
    })
    .from(posting_questions)
    .where(
      inArray(
        posting_questions.posting_id,
        rows.map((r) => r.id),
      ),
    )
    .groupBy(posting_questions.posting_id)
    .all()) {
    lastFetched.set(r.id, r.at);
  }
  return rows.filter((r) => {
    const last = lastFetched.get(r.id);
    if (last === undefined) return true;
    return last < staleBefore || (r.updated_at !== null && r.updated_at > last);
  });
}

/** Replaces a posting's question rows; a matched answer-bank key survives while the question's label is unchanged. */
function storeQuestions(db: Db, postingId: string, ats: string, qs: FetchedQuestion[], at: string) {
  db.transaction((tx) => {
    const existing = new Map(
      tx
        .select()
        .from(posting_questions)
        .where(eq(posting_questions.posting_id, postingId))
        .all()
        .map((r) => [r.question_id, r]),
    );
    const keep = new Set(qs.map((q) => q.question_id));
    for (const row of existing.values()) {
      if (!keep.has(row.question_id)) {
        tx.delete(posting_questions).where(eq(posting_questions.id, row.id)).run();
      }
    }
    for (const q of qs) {
      const normalized = normalizeLabel(q.label);
      const values = {
        ats_type: ats,
        label: q.label,
        required: q.required,
        type: q.type,
        options: q.options === null ? null : JSON.stringify(q.options),
        normalized_label: normalized,
        fetched_at: at,
      };
      const old = existing.get(q.question_id);
      if (old === undefined) {
        tx.insert(posting_questions)
          .values({
            id: randomUUID(),
            posting_id: postingId,
            question_id: q.question_id,
            ...values,
          })
          .run();
      } else {
        tx.update(posting_questions)
          .set({
            ...values,
            matched_key: old.normalized_label === normalized ? old.matched_key : null,
          })
          .where(eq(posting_questions.id, old.id))
          .run();
      }
    }
  });
}

/**
 * Stores a slug the boards-api lookup verified, so it is not looked up again: on the posting's `apply_links` row, and
 * (only when the company has no board yet, config rows included) as the company's board the way resolve-apply's
 * `saveBoard` does, which is what `save-ats` later appends to `companies.yaml`.
 */
function saveVerifiedSlug(db: Db, c: Candidate, slug: string, at: string): void {
  db.transaction((tx) => {
    if (c.link_id !== null) {
      tx.update(apply_links)
        .set({ ats_type: "greenhouse", ats_slug: slug })
        .where(eq(apply_links.id, c.link_id))
        .run();
    }
    if (c.company_id === null) return;
    const company = tx.select().from(companies).where(eq(companies.id, c.company_id)).get();
    if (company === undefined || company.ats_type !== null) return;
    tx.update(companies)
      .set({
        ats_type: "greenhouse",
        ats_slug: slug,
        ...(company.discovered_via === "config"
          ? {}
          : { discovered_via: "apply_resolve" as const }),
        discovered_at: company.discovered_at ?? at,
        verified: true,
        ats_checked_at: at,
      })
      .where(eq(companies.id, company.id))
      .run();
  });
}

interface AtsStats {
  /** Greenhouse career-page links whose board slug the boards-api lookup verified (and stored). */
  boardFound: number;
  /** Greenhouse career-page links for which no candidate slug could be verified. */
  boardNotFound: number;
  fetched: number;
  questions: number;
  gone: number;
  skipped: number;
  deferred: number;
  errors: number;
}

export async function runFetchQuestions(opts: FetchQuestionsOptions): Promise<number> {
  const { db } = opts;
  const out = opts.out ?? (() => undefined);
  const err = opts.err ?? (() => undefined);
  const now = opts.now ?? (() => new Date());
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
    err(`fetch-questions: --limit must be a positive integer\n`);
    return 1;
  }
  const limit = opts.limit ?? DEFAULT_LIMIT;

  const candidates = selectCandidates(db, now());
  const stats = new Map<string, AtsStats>();
  const stat = (ats: string): AtsStats => {
    let s = stats.get(ats);
    if (s === undefined) {
      s = {
        boardFound: 0,
        boardNotFound: 0,
        fetched: 0,
        questions: 0,
        gone: 0,
        skipped: 0,
        deferred: 0,
        errors: 0,
      };
      stats.set(ats, s);
    }
    return s;
  };
  const skipReasons = new Map<string, number>();
  const http = new QuestionsHttp();
  const boards = new Map<string, Promise<RecruiteeBoard>>();
  let attempted = 0;
  let errors = 0;

  for (const c of candidates) {
    const resolved = resolveTarget(c);
    if ("skip" in resolved) {
      stat(resolved.ats).skipped++;
      const key = `${resolved.ats}: ${resolved.skip}`;
      skipReasons.set(key, (skipReasons.get(key) ?? 0) + 1);
      continue;
    }
    if (attempted >= limit) continue; // due, but over this run's cap: the next run picks it up
    attempted++;
    let target: Target;
    if ("lookup" in resolved) {
      const ls = stat(resolved.ats);
      const { jobId, candidates } = resolved.lookup;
      const found = await resolveGreenhouseSlug(http, jobId, candidates);
      if (found.kind === "deferred") {
        ls.deferred++;
        continue;
      }
      if (found.kind === "not_found") {
        ls.boardNotFound++; // counted apart from `skipped`: nothing was wrong with the link, the board is unknown
        const key = `${resolved.ats}: ${BOARD_NOT_FOUND}`;
        skipReasons.set(key, (skipReasons.get(key) ?? 0) + 1);
        continue;
      }
      saveVerifiedSlug(db, c, found.slug, now().toISOString());
      ls.boardFound++;
      target = { ats: "greenhouse", slug: found.slug, jobId, offerSlug: "" };
    } else {
      target = resolved.target;
    }
    const s = stat(target.ats);
    const outcome = await fetchOne(target, http, boards);
    switch (outcome.kind) {
      case "questions":
        storeQuestions(db, c.id, target.ats, outcome.questions, now().toISOString());
        s.fetched++;
        s.questions += outcome.questions.length;
        break;
      case "gone":
        s.gone++; // a closed job keeps its stored questions
        break;
      case "deferred":
        s.deferred++;
        break;
      case "error":
        s.errors++;
        errors++;
        err(`fetch-questions: error ${c.id} ${target.ats}: ${outcome.reason}\n`);
        break;
    }
  }

  out(`fetch-questions: selected ${candidates.length}, attempted ${attempted}\n`);
  for (const [ats, s] of [...stats.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out(
      `fetch-questions: ${ats}: fetched ${s.fetched}, questions ${s.questions}, closed ${s.gone}, skipped ${s.skipped}, deferred ${s.deferred}, errors ${s.errors}\n`,
    );
    if (s.boardFound > 0 || s.boardNotFound > 0) {
      out(
        `fetch-questions: ${ats}: career-page links: board found ${s.boardFound}, board not found ${s.boardNotFound}\n`,
      );
    }
  }
  for (const [reason, n] of [...skipReasons.entries()].sort()) {
    out(`fetch-questions: skipped ${n} (${reason})\n`);
  }
  for (const [host, status] of http.blockedHosts) {
    out(`fetch-questions: ${host} answered HTTP ${status}, no more requests to it this run\n`);
  }
  const m = matchQuestions(db);
  out(
    `fetch-questions: matched ${m.covered} covered, ${m.needsMapping} need a choice mapping, ${m.salary} salary, ${m.unknown} unknown (${m.unknownWordings} wordings)\n`,
  );
  out(`fetch-questions: requests ${http.requests}${errors > 0 ? `, errors ${errors}` : ""}\n`);
  return errors > 0 ? 1 : 0;
}
