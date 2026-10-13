import { eq } from "drizzle-orm";
import {
  callStructured,
  companies,
  httpGet,
  HttpError,
  log,
  MissingApiKeyError,
  LlmApiError,
  LlmOutputError,
  type Db,
  type LlmDeps,
} from "@job-agent/core";
import { z } from "zod";
import { ATS_APPLY_HOSTS } from "../filters/keywords.ts";
import { COMPANY_RESEARCH_SYSTEM_PROMPT } from "./prompts/company-research.ts";

export { PROMPT_VERSION as COMPANY_RESEARCH_PROMPT_VERSION } from "./prompts/company-research.ts";

export const COMPANY_RESEARCH_MODEL = "claude-haiku-5-5" as const;
const MAX_TOKENS = 512;
const MAX_PAGES = 2;
const MAX_PAGE_CHARS = 12_000;
const MIN_INTERVAL_MS = 2000;
/** A company is looked up at most once per this many days (PLAN 5.3). */
export const RESEARCH_INTERVAL_DAYS = 90;
const DAY_MS = 86_400_000;
/** The registry never replaces a human decision. */
const PROTECTED_SOURCE = /^manual/;
/** Public pages the company itself publishes; tried in order, at most MAX_PAGES. */
/** `pay_policy_source` marker written by a check that had no domain to look at. */
const NO_DOMAIN_SOURCE = "research:no domain";
const CAREERS_PATHS = ["/careers", "/jobs"];

/** Wire shape: "" and "unknown" instead of null (the API limits union-typed parameters). */
export const CompanyResearchWireSchema = z.object({
  quote: z.string(),
  classification: z.enum(["location_agnostic", "location_adjusted", "unknown"]),
});

export interface CompanyResearch {
  quote: string | null;
  classification: "location_agnostic" | "location_adjusted" | null;
}

export function toCompanyResearch(w: z.infer<typeof CompanyResearchWireSchema>): CompanyResearch {
  return {
    quote: w.quote === "" ? null : w.quote,
    classification: w.classification === "unknown" ? null : w.classification,
  };
}

/** How a lookup ended, for the `enrich` summary counts. */
export type ResearchCategory = "found" | "no_domain" | "fetch_failed" | "no_wording";

export type ResearchOutcome =
  | { kind: "skipped"; reason: string }
  | {
      kind: "found";
      policy: "location_agnostic" | "location_adjusted";
      source: string;
      reasons: string[];
      category: "found";
      reason: string;
    }
  /** `failed` is set when a fetch or the model output went wrong (as opposed to a page without pay wording). */
  | {
      kind: "unknown";
      reasons: string[];
      failed?: true;
      category: Exclude<ResearchCategory, "found">;
      /** Short logged reason: `no domain`, `fetch failed <url>: <status or error>`, `redirected off-site`, ... */
      reason: string;
    }
  /** Transient API problem: nothing stored, the company is retried on the next run. A spent budget throws instead. */
  | { kind: "retry"; reason: string };

export interface ResearchDeps extends LlmDeps {
  /** Page fetcher; default is the shared rate-limited HTTP client. Returns the final URL and body. */
  fetchPage?: (url: string) => Promise<{ finalUrl: string; body: string }>;
}

/** LinkedIn is never contacted, not even through a redirect (AGENTS.md guardrail). */
export function isLinkedInHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "linkedin.com" || host.endsWith(".linkedin.com") || host === "lnkd.in";
  } catch {
    return true;
  }
}

/** Second-level labels that make a two-letter TLD a public suffix (`co.id`, `com.au`, ...). */
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "or", "go"]);

/** Registrable domain, approximated without a public-suffix list: last two labels, three under `co.xx`. */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  const [sld, tld] = [labels.at(-2), labels.at(-1)];
  const take = sld !== undefined && tld?.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2;
  return labels.slice(-take).join(".");
}

function isAtsHost(host: string): boolean {
  const h = host.toLowerCase();
  return ATS_APPLY_HOSTS.some((a) => h === a || h.endsWith(`.${a}`));
}

/**
 * A careers-page redirect is followed only within the starting URL's registrable domain or to a known ATS host.
 * LinkedIn, other hosts and non-https targets are refused.
 */
export function isAllowedRedirect(startUrl: string, nextUrl: string): boolean {
  if (isLinkedInHost(nextUrl)) return false;
  try {
    const start = new URL(startUrl);
    const next = new URL(nextUrl);
    if (next.protocol !== "https:") return false;
    return (
      registrableDomain(next.hostname) === registrableDomain(start.hostname) ||
      isAtsHost(next.hostname)
    );
  } catch {
    return false;
  }
}

/** A redirect hop was refused (never requested). `linkedin` is true when the target was LinkedIn. */
export class RedirectRefusedError extends Error {
  constructor(public linkedin: boolean) {
    super(linkedin ? "redirected to linkedin" : "redirected off-site");
    this.name = "RedirectRefusedError";
  }
}

export async function defaultFetchPage(url: string): Promise<{ finalUrl: string; body: string }> {
  let refused: string | null = null;
  try {
    const res = await httpGet(url, {
      minIntervalMs: MIN_INTERVAL_MS,
      allowRedirectTo: (next) => {
        const ok = isAllowedRedirect(url, next);
        if (!ok) refused = next;
        return ok;
      },
    });
    return { finalUrl: res.url || url, body: await res.text() };
  } catch (e) {
    if (refused !== null) throw new RedirectRefusedError(isLinkedInHost(refused));
    throw e;
  }
}

/** Status or error kind of a failed fetch; never the response body or the error text. */
function describeFetchError(e: unknown): string {
  if (e instanceof HttpError) return e.status === null ? "network error" : `HTTP ${e.status}`;
  return e instanceof Error ? e.name : "error";
}

/** Visible text only: no scripts, styles or markup, whitespace collapsed. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Candidate pages from the company's own domain; never a third-party or LinkedIn host. */
export function candidateUrls(domain: string | null): string[] {
  if (!domain) return [];
  const host = domain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return [];
  return CAREERS_PATHS.slice(0, MAX_PAGES)
    .map((p) => `https://${host}${p}`)
    .filter((u) => !isLinkedInHost(u));
}

export function isDueForResearch(
  row: {
    pay_policy: string | null;
    pay_policy_source: string | null;
    pay_policy_checked_at: string | null;
    domain?: string | null;
  },
  now: Date,
): boolean {
  if (row.pay_policy !== null && row.pay_policy !== "unknown") return false;
  if (row.pay_policy_source !== null && PROTECTED_SOURCE.test(row.pay_policy_source)) return false;
  if (row.pay_policy_checked_at === null) return true;
  // Checked while the company had no domain (marker, or an unmarked pre-fix check): due again once it has one.
  if (
    row.domain &&
    (row.pay_policy_source === null || row.pay_policy_source === NO_DOMAIN_SOURCE)
  ) {
    return true;
  }
  const checked = Date.parse(row.pay_policy_checked_at);
  return Number.isNaN(checked) || now.getTime() - checked >= RESEARCH_INTERVAL_DAYS * DAY_MS;
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

function markChecked(db: Db, companyId: string, at: Date, source: string): void {
  db.update(companies)
    .set({ pay_policy_checked_at: at.toISOString(), pay_policy_source: source })
    .where(eq(companies.id, companyId))
    .run();
}

/**
 * One cheap lookup of the company's careers pages for its pay policy. Runs only when the policy is unknown and
 * `pay_policy_checked_at` is null or older than 90 days. Fetch failure or no wording: policy stays unknown and
 * `pay_policy_checked_at` is set. An API failure stores nothing so the company is retried later; a spent budget
 * throws BudgetExceededError (nothing stored).
 * Throws MissingApiKeyError before any request is made.
 */
export async function researchCompanyPayPolicy(
  companyId: string,
  deps: ResearchDeps,
): Promise<ResearchOutcome> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const env = deps.env ?? process.env;
  const row = db.select().from(companies).where(eq(companies.id, companyId)).get();
  if (!row) return { kind: "skipped", reason: "company not found" };
  if (!isDueForResearch(row, now))
    return { kind: "skipped", reason: "policy known or checked recently" };
  if (!env["ANTHROPIC_API_KEY"]) throw new MissingApiKeyError();

  const fetchPage = deps.fetchPage ?? defaultFetchPage;
  const failures: string[] = [];
  /** First failure, in the logged vocabulary. */
  let firstFailure: string | null = null;
  const fail = (short: string, long: string): void => {
    failures.push(long);
    firstFailure ??= short;
  };
  const pages: { url: string; text: string }[] = [];
  for (const url of candidateUrls(row.domain)) {
    try {
      const page = await fetchPage(url);
      if (isLinkedInHost(page.finalUrl)) {
        fail("redirected to linkedin", `${url}: redirected to linkedin, discarded`);
        continue;
      }
      if (!isAllowedRedirect(url, page.finalUrl)) {
        fail("redirected off-site", `${url}: redirected to another site, discarded`);
        continue;
      }
      const text = htmlToText(page.body).slice(0, MAX_PAGE_CHARS);
      if (text) pages.push({ url, text });
      else fail("empty page", `${url}: empty page`);
    } catch (e) {
      if (e instanceof RedirectRefusedError) {
        fail(e.message, `${url}: ${e.message}, discarded`);
      } else {
        const why = describeFetchError(e);
        fail(`fetch failed ${url}: ${why}`, `${url}: ${why}`);
      }
    }
  }
  if (pages.length === 0) {
    const noDomain = candidateUrls(row.domain).length === 0;
    const short = noDomain ? "no domain" : (firstFailure ?? "empty page");
    const reason = row.domain
      ? `pay policy research: no page fetched (${failures.join("; ") || "no candidate url"})`
      : "pay policy research: no company domain";
    log.info("company research", {
      company_id: companyId,
      outcome: noDomain ? "no_domain" : "fetch_failed",
      reason: short,
    });
    markChecked(db, companyId, now, noDomain ? NO_DOMAIN_SOURCE : `research:${short}`);
    return noDomain
      ? { kind: "unknown", reasons: [reason], category: "no_domain", reason: short }
      : {
          kind: "unknown",
          reasons: [reason],
          failed: true,
          category: "fetch_failed",
          reason: short,
        };
  }

  const unknownReasons: string[] = [];
  let outputFailed = false;
  for (const page of pages) {
    let result: CompanyResearch;
    try {
      result = await callStructured(
        {
          model: COMPANY_RESEARCH_MODEL,
          purpose: "company_research",
          system: COMPANY_RESEARCH_SYSTEM_PROMPT,
          input: `Page text:\n${page.text}`,
          schema: CompanyResearchWireSchema,
          map: toCompanyResearch,
          maxTokens: MAX_TOKENS,
          companyId,
        },
        deps,
      );
    } catch (e) {
      if (e instanceof LlmOutputError) {
        outputFailed = true;
        unknownReasons.push(
          `pay policy research ${page.url}: invalid model output (${e.issues.join("; ")})`,
        );
        continue;
      }
      if (e instanceof LlmApiError) return { kind: "retry", reason: e.message };
      // BudgetExceededError and anything unexpected go to the caller; nothing is stored.
      throw e;
    }
    // Code decides: the quote must really be on the page and the classification must come with it.
    if (
      result.classification !== null &&
      result.quote !== null &&
      result.quote.trim() !== "" &&
      squash(page.text).includes(squash(result.quote))
    ) {
      const source = `careers:${page.url}`;
      const quote = result.quote.replace(/\s+/g, " ").trim();
      db.update(companies)
        .set({
          pay_policy: result.classification,
          pay_policy_source: source,
          pay_policy_checked_at: now.toISOString(),
        })
        .where(eq(companies.id, companyId))
        .run();
      log.info("company research", {
        company_id: companyId,
        outcome: "found",
        reason: `found ${result.classification}`,
      });
      return {
        kind: "found",
        category: "found",
        reason: `found ${result.classification}`,
        policy: result.classification,
        source,
        reasons: [`pay policy ${result.classification} from ${source}: "${quote}"`],
      };
    }
    unknownReasons.push(`pay policy research ${page.url}: no pay-policy wording`);
  }
  markChecked(db, companyId, now, "research:no pay wording");
  log.info("company research", {
    company_id: companyId,
    outcome: "no_wording",
    reason: "no pay wording",
  });
  const reasons = [...failures.map((f) => `pay policy research: ${f}`), ...unknownReasons];
  const base = { reasons, category: "no_wording" as const, reason: "no pay wording" };
  return failures.length > 0 || outputFailed
    ? { kind: "unknown", ...base, failed: true }
    : { kind: "unknown", ...base };
}
