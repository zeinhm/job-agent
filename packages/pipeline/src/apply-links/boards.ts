import { HttpError, httpGet, log } from "@job-agent/core";
import { z } from "zod";
import { normalizeCompanyName } from "../normalize/index.ts";

export const ATS_HOSTS = [
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "workable",
  "recruitee",
] as const;
export type AtsType = (typeof ATS_HOSTS)[number];

export interface BoardJob {
  title: string;
  url: string;
  /** Plain description; only kept for boards that carry no company name (Lever, Ashby). */
  text?: string;
}

export interface Board {
  ats: AtsType;
  slug: string;
  /** The company name the board states about itself; null for Lever and Ashby. */
  name: string | null;
  jobs: BoardJob[];
}

export type BoardLookup =
  | { kind: "ok"; board: Board }
  | { kind: "missing" }
  | { kind: "rejected" }
  | { kind: "error" }
  | { kind: "blocked" };

const MIN_INTERVAL_MS = 2000;
const SR_PAGE_SIZE = 100;
/** SmartRecruiters lists 100 per page; a huge board is matched on its first pages only. */
const SR_MAX_PAGES = 5;

/** Counts requests and remembers hosts that answered 429 (no further lookups on them in this run). */
export class ApplyHttp {
  requests = 0;
  readonly blockedHosts = new Set<string>();
  /** Per-run cache, key `${ats}:${slug}`; a board is fetched once per run. */
  readonly boards = new Map<string, BoardLookup>();
  /** Greenhouse name probes, key slug. */
  readonly probes = new Map<string, { name: string | null } | "missing" | "error" | "blocked">();

  async getJson(
    url: string,
  ): Promise<{ kind: "ok"; body: unknown } | Exclude<BoardLookup, { kind: "ok" | "rejected" }>> {
    const host = new URL(url).hostname;
    if (this.blockedHosts.has(host)) return { kind: "blocked" };
    this.requests++;
    try {
      const res = await httpGet(url, { minIntervalMs: MIN_INTERVAL_MS });
      return { kind: "ok", body: (await res.json()) as unknown };
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return { kind: "missing" };
      if (err instanceof HttpError && err.status === 429) {
        this.blockedHosts.add(host);
        log.warn("apply-resolve: 429, no more lookups on this host this run", { host });
        return { kind: "blocked" };
      }
      log.warn("apply-resolve: board request failed", {
        host,
        error: err instanceof HttpError ? `HTTP ${err.status ?? "network error"}` : String(err),
      });
      return { kind: "error" };
    }
  }
}

const str = z.string().min(1);

const greenhouseProbe = z.object({ name: z.string().nullish() });
const greenhouseJobs = z.object({
  jobs: z.array(z.object({ title: str, absolute_url: str })),
});
const leverJobs = z.array(
  z.object({ text: str, hostedUrl: str, descriptionPlain: z.string().nullish() }),
);
const ashbyJobs = z.object({
  jobs: z.array(
    z.object({
      title: str,
      jobUrl: str,
      isListed: z.boolean().nullish(),
      descriptionPlain: z.string().nullish(),
    }),
  ),
});
const smartRecruitersPage = z.object({
  totalFound: z.number().int().nonnegative(),
  content: z.array(
    z.object({ id: str, name: str, company: z.object({ name: z.string().nullish() }).nullish() }),
  ),
});
const workableBoard = z.object({
  name: z.string().nullish(),
  jobs: z.array(
    z.object({
      title: str,
      shortcode: str,
      url: z.string().nullish(),
      shortlink: z.string().nullish(),
    }),
  ),
});
const recruiteeBoard = z.object({
  offers: z.array(z.object({ title: str, careers_url: str, company_name: z.string().nullish() })),
});

/** Slugs end up in a URL path or a hostname label: anything else is never requested. */
const SAFE_SLUG = /^[A-Za-z0-9]([A-Za-z0-9_-]*[A-Za-z0-9])?$/;

const invalid = (ats: AtsType, slug: string): BoardLookup => {
  log.warn("apply-resolve: board response did not match the expected shape", { ats, slug });
  return { kind: "error" };
};

async function greenhouseName(http: ApplyHttp, slug: string) {
  const cached = http.probes.get(slug);
  if (cached) return cached;
  const res = await http.getJson(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}`,
  );
  let out: { name: string | null } | "missing" | "error" | "blocked";
  if (res.kind !== "ok") out = res.kind;
  else {
    const parsed = greenhouseProbe.safeParse(res.body);
    out = parsed.success ? { name: parsed.data.name ?? null } : "error";
  }
  http.probes.set(slug, out);
  return out;
}

/**
 * One board lookup. `nameOk` (optional) is asked as soon as a board name is known; when it says no, the
 * heavy job download is skipped (Greenhouse: 30-byte name probe first) and the result is "rejected".
 * Results are cached per run.
 */
export async function lookupBoard(
  http: ApplyHttp,
  ats: AtsType,
  slug: string,
  nameOk?: (name: string | null) => boolean,
): Promise<BoardLookup> {
  if (!SAFE_SLUG.test(slug)) return { kind: "missing" };
  const key = `${ats}:${slug}`;
  const cached = http.boards.get(key);
  if (cached) return cached;
  const s = encodeURIComponent(slug);

  let result: BoardLookup;
  switch (ats) {
    case "greenhouse": {
      if (nameOk) {
        const probe = await greenhouseName(http, slug);
        if (typeof probe === "string") return { kind: probe };
        if (!nameOk(probe.name)) return { kind: "rejected" };
      }
      const res = await http.getJson(`https://boards-api.greenhouse.io/v1/boards/${s}/jobs`);
      if (res.kind !== "ok") {
        result = res;
        break;
      }
      const parsed = greenhouseJobs.safeParse(res.body);
      const probe = http.probes.get(slug);
      result = parsed.success
        ? {
            kind: "ok",
            board: {
              ats,
              slug,
              name: typeof probe === "object" ? probe.name : null,
              jobs: parsed.data.jobs.map((j) => ({ title: j.title, url: j.absolute_url })),
            },
          }
        : invalid(ats, slug);
      break;
    }
    case "lever": {
      const res = await http.getJson(`https://api.lever.co/v0/postings/${s}?mode=json`);
      if (res.kind !== "ok") {
        result = res;
        break;
      }
      const parsed = leverJobs.safeParse(res.body);
      result = parsed.success
        ? {
            kind: "ok",
            board: {
              ats,
              slug,
              name: null,
              jobs: parsed.data.map((j) => ({
                title: j.text,
                url: j.hostedUrl,
                ...(j.descriptionPlain ? { text: j.descriptionPlain } : {}),
              })),
            },
          }
        : invalid(ats, slug);
      break;
    }
    case "ashby": {
      const res = await http.getJson(`https://api.ashbyhq.com/posting-api/job-board/${s}`);
      if (res.kind !== "ok") {
        result = res;
        break;
      }
      const parsed = ashbyJobs.safeParse(res.body);
      result = parsed.success
        ? {
            kind: "ok",
            board: {
              ats,
              slug,
              name: null,
              jobs: parsed.data.jobs
                .filter((j) => j.isListed !== false)
                .map((j) => ({
                  title: j.title,
                  url: j.jobUrl,
                  ...(j.descriptionPlain ? { text: j.descriptionPlain } : {}),
                })),
            },
          }
        : invalid(ats, slug);
      break;
    }
    case "smartrecruiters": {
      // An unknown id answers 200 with an empty list: existence = totalFound > 0.
      const jobs: BoardJob[] = [];
      let name: string | null = null;
      result = { kind: "missing" };
      for (let page = 0; page < SR_MAX_PAGES; page++) {
        const res = await http.getJson(
          `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=${SR_PAGE_SIZE}&offset=${page * SR_PAGE_SIZE}`,
        );
        if (res.kind !== "ok") {
          result = res;
          break;
        }
        const parsed = smartRecruitersPage.safeParse(res.body);
        if (!parsed.success) {
          result = invalid(ats, slug);
          break;
        }
        if (parsed.data.totalFound === 0) break;
        name ??= parsed.data.content[0]?.company?.name ?? null;
        for (const j of parsed.data.content) {
          jobs.push({ title: j.name, url: `https://jobs.smartrecruiters.com/${slug}/${j.id}` });
        }
        result = { kind: "ok", board: { ats, slug, name, jobs } };
        if (jobs.length >= parsed.data.totalFound || parsed.data.content.length === 0) break;
        if (nameOk && !nameOk(name)) {
          result = { kind: "rejected" };
          break;
        }
      }
      if (result.kind === "ok" && nameOk && !nameOk(result.board.name))
        result = { kind: "rejected" };
      break;
    }
    case "workable": {
      const res = await http.getJson(`https://apply.workable.com/api/v1/widget/accounts/${s}`);
      if (res.kind !== "ok") {
        result = res;
        break;
      }
      const parsed = workableBoard.safeParse(res.body);
      result = parsed.success
        ? {
            kind: "ok",
            board: {
              ats,
              slug,
              name: parsed.data.name ?? null,
              jobs: parsed.data.jobs.map((j) => ({
                title: j.title,
                url: j.url ?? j.shortlink ?? `https://apply.workable.com/j/${j.shortcode}`,
              })),
            },
          }
        : invalid(ats, slug);
      break;
    }
    case "recruitee": {
      const res = await http.getJson(`https://${slug.toLowerCase()}.recruitee.com/api/offers/`);
      if (res.kind !== "ok") {
        result = res;
        break;
      }
      const parsed = recruiteeBoard.safeParse(res.body);
      result = parsed.success
        ? {
            kind: "ok",
            board: {
              ats,
              slug,
              name: parsed.data.offers.find((o) => o.company_name)?.company_name ?? null,
              jobs: parsed.data.offers.map((o) => ({ title: o.title, url: o.careers_url })),
            },
          }
        : invalid(ats, slug);
      break;
    }
  }

  // Blocked / error answers are not cached (a later posting in this run may not retry them anyway:
  // blocked hosts are skipped, errors are counted once per company by the caller).
  if (result.kind === "ok" || result.kind === "missing") http.boards.set(key, result);
  return result;
}

/** Comparable key for name equality: normalized company name without spaces ("Hugging Face" = "huggingface"). */
const squash = (name: string): string => normalizeCompanyName(name).replace(/\s+/g, "");

/** exact: same name; partial: one contains the other (needs corroboration); no: different. */
export function compareNames(boardName: string, companyName: string): "exact" | "partial" | "no" {
  const a = squash(boardName);
  const b = squash(companyName);
  if (a === "" || b === "") return "no";
  if (a === b) return "exact";
  return a.includes(b) || b.includes(a) ? "partial" : "no";
}

/** Host of a URL without a leading "www.", "" when unparsable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export const hostMatchesDomain = (url: string, domain: string | null): boolean => {
  if (!domain) return false;
  const host = hostOf(url);
  const d = domain.toLowerCase().replace(/^www\./, "");
  return host === d || host.endsWith(`.${d}`);
};

/**
 * Same-company check for a slug GUESS (research t_5f31fe9d "Collision handling"):
 * - board states a name: exact match, or partial match plus corroboration (a job title match or a job URL on the
 *   company's domain);
 * - board states no name (Lever, Ashby): needs a title match AND corroboration (a matching job's description
 *   mentions the company name, or its URL is on the company's domain).
 */
export function isSameCompany(
  board: Board,
  company: { name: string; domain: string | null },
  titleMatches: (title: string) => boolean,
): boolean {
  const matched = board.jobs.filter((j) => titleMatches(j.title));
  const domainHit = board.jobs.some((j) => hostMatchesDomain(j.url, company.domain));
  if (board.name !== null) {
    const verdict = compareNames(board.name, company.name);
    if (verdict === "exact") return true;
    return verdict === "partial" && (matched.length > 0 || domainHit);
  }
  if (matched.length === 0) return false;
  const key = normalizeCompanyName(company.name);
  const mentions =
    key !== "" &&
    matched.some((j) => j.text !== undefined && normalizeCompanyName(j.text).includes(key));
  return mentions || matched.some((j) => hostMatchesDomain(j.url, company.domain));
}
