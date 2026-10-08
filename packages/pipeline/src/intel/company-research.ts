import { eq } from "drizzle-orm";
import {
  BudgetExceededError,
  callStructured,
  companies,
  httpGet,
  log,
  MissingApiKeyError,
  LlmApiError,
  LlmOutputError,
  type Db,
  type LlmDeps,
} from "@job-agent/core";
import { z } from "zod";
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
const CAREERS_PATHS = ["/careers", "/jobs"];

export const CompanyResearchSchema = z.object({
  quote: z.string().nullable(),
  classification: z.enum(["location_agnostic", "location_adjusted"]).nullable(),
});

export type ResearchOutcome =
  | { kind: "skipped"; reason: string }
  | {
      kind: "found";
      policy: "location_agnostic" | "location_adjusted";
      source: string;
      reasons: string[];
    }
  | { kind: "unknown"; reasons: string[] }
  /** Budget or transient API problem: nothing stored, the company is retried on the next run. */
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

export async function defaultFetchPage(url: string): Promise<{ finalUrl: string; body: string }> {
  const res = await httpGet(url, {
    minIntervalMs: MIN_INTERVAL_MS,
    allowRedirectTo: (next) => !isLinkedInHost(next),
  });
  return { finalUrl: res.url || url, body: await res.text() };
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
  },
  now: Date,
): boolean {
  if (row.pay_policy !== null && row.pay_policy !== "unknown") return false;
  if (row.pay_policy_source !== null && PROTECTED_SOURCE.test(row.pay_policy_source)) return false;
  if (row.pay_policy_checked_at === null) return true;
  const checked = Date.parse(row.pay_policy_checked_at);
  return Number.isNaN(checked) || now.getTime() - checked >= RESEARCH_INTERVAL_DAYS * DAY_MS;
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

function markChecked(db: Db, companyId: string, at: Date): void {
  db.update(companies)
    .set({ pay_policy_checked_at: at.toISOString() })
    .where(eq(companies.id, companyId))
    .run();
}

/**
 * One cheap lookup of the company's careers pages for its pay policy. Runs only when the policy is unknown and
 * `pay_policy_checked_at` is null or older than 90 days. Fetch failure or no wording: policy stays unknown and
 * `pay_policy_checked_at` is set. Budget / API failures store nothing so the company is retried later.
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
  const pages: { url: string; text: string }[] = [];
  for (const url of candidateUrls(row.domain)) {
    try {
      const page = await fetchPage(url);
      if (isLinkedInHost(page.finalUrl)) {
        failures.push(`${url}: redirected to linkedin, discarded`);
        continue;
      }
      const text = htmlToText(page.body).slice(0, MAX_PAGE_CHARS);
      if (text) pages.push({ url, text });
      else failures.push(`${url}: empty page`);
    } catch (e) {
      failures.push(`${url}: ${e instanceof Error ? e.message : "fetch failed"}`);
    }
  }
  if (pages.length === 0) {
    const reason = row.domain
      ? `pay policy research: no page fetched (${failures.join("; ") || "no candidate url"})`
      : "pay policy research: no company domain";
    log.info("company research: no page", { company_id: companyId, failures: failures.length });
    markChecked(db, companyId, now);
    return { kind: "unknown", reasons: [reason] };
  }

  const unknownReasons: string[] = [];
  for (const page of pages) {
    let result: z.infer<typeof CompanyResearchSchema>;
    try {
      result = await callStructured(
        {
          model: COMPANY_RESEARCH_MODEL,
          purpose: "company_research",
          system: COMPANY_RESEARCH_SYSTEM_PROMPT,
          input: `Page text:\n${page.text}`,
          schema: CompanyResearchSchema,
          maxTokens: MAX_TOKENS,
          companyId,
        },
        deps,
      );
    } catch (e) {
      if (e instanceof LlmOutputError) {
        unknownReasons.push(
          `pay policy research ${page.url}: invalid model output (${e.issues.join("; ")})`,
        );
        continue;
      }
      if (e instanceof LlmApiError) return { kind: "retry", reason: e.message };
      if (e instanceof BudgetExceededError) {
        return { kind: "retry", reason: e.message };
      }
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
      return {
        kind: "found",
        policy: result.classification,
        source,
        reasons: [`pay policy ${result.classification} from ${source}: "${quote}"`],
      };
    }
    unknownReasons.push(`pay policy research ${page.url}: no pay-policy wording`);
  }
  markChecked(db, companyId, now);
  return {
    kind: "unknown",
    reasons: [...failures.map((f) => `pay policy research: ${f}`), ...unknownReasons],
  };
}
