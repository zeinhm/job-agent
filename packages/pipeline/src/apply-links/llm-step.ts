import { callStructured, type LlmDeps } from "@job-agent/core";
import { z } from "zod";
import { APPLY_LINK_SYSTEM_PROMPT } from "../intel/prompts/apply-link.ts";
import { atsLinkOf } from "./ats-links.ts";
import { hostOf } from "./boards.ts";
import { plainText, textLinks } from "./posting-text.ts";

export { PROMPT_VERSION as APPLY_LINK_PROMPT_VERSION } from "../intel/prompts/apply-link.ts";

export const APPLY_LINK_MODEL = "claude-haiku-5-5" as const;
/**
 * The answer is `{"choice":3,"kind":"ats"}`, about 15 tokens. Haiku runs with thinking disabled, so 64 leaves room for
 * a verbose key order or whitespace and keeps the $1/day reservation small (`reserveUsd`).
 */
export const APPLY_LINK_MAX_TOKENS = 64;
export const MAX_CANDIDATES = 10;
/** Posting text sent along, around the candidate links. */
export const MAX_CONTEXT_CHARS = 2000;
const MAX_URL_CHARS = 300;
const MAX_ANCHOR_CHARS = 100;

/** Wire schema: no nullable fields, no unions; `0` means none. */
export const ApplyLinkWireSchema = z.object({
  choice: z.number().refine((n) => Number.isInteger(n) && n >= 0, "index"),
  kind: z.enum(["ats", "company_form", "paid_aggregator", "unknown"]),
});
export type ApplyLinkAnswer = z.infer<typeof ApplyLinkWireSchema>;

export interface Candidate {
  url: string;
  /** Visible link text, "" for a bare URL. */
  anchor: string;
}

const SKIP_HOSTS = ["linkedin.com", "lnkd.in"];
const ASSET = /\.(?:png|jpe?g|gif|svg|webp|ico|css|js|woff2?)(?:[?#]|$)/i;

const clean = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * The candidate links of a posting: http(s) links in its text and the source's own apply URL, without the posting's own
 * listing URL, LinkedIn links (never fetched or followed) and asset files. Order of first appearance, at most 10.
 */
export function candidateLinks(
  text: string | null,
  extraUrls: Array<string | null | undefined>,
  ownUrls: Array<string | null | undefined>,
): Candidate[] {
  const own = new Set(ownUrls.filter((u): u is string => !!u));
  const anchors = new Map<string, string>();
  for (const m of (text ?? "").matchAll(
    /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi,
  )) {
    const href = (m[1] ?? m[2] ?? "").replace(/&amp;/g, "&");
    const label = clean(plainText(m[3] ?? ""));
    if (href !== "" && !anchors.has(href) && label !== "" && label !== href) {
      anchors.set(href, label);
    }
  }
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const url of textLinks(text, extraUrls).urls) {
    if (seen.has(url) || own.has(url) || url.length > MAX_URL_CHARS || ASSET.test(url)) continue;
    const host = hostOf(url);
    if (host === "" || SKIP_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) continue;
    seen.add(url);
    out.push({ url, anchor: (anchors.get(url) ?? "").slice(0, MAX_ANCHOR_CHARS) });
    if (out.length === MAX_CANDIDATES) break;
  }
  return out;
}

/** True when one of the links is an ATS job URL (the free steps would already have used it). */
export const hasAtsJobUrl = (cands: Candidate[]): boolean =>
  cands.some((c) => atsLinkOf(c.url)?.kind === "job");

/** At most `MAX_CONTEXT_CHARS` of the plain posting text, starting a little before the first candidate link. */
function context(text: string | null, cands: Candidate[]): string {
  const body = clean(plainText(text ?? ""));
  const first = cands
    .map((c) => body.indexOf(c.url))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];
  const start = Math.max(0, (first ?? 0) - 300);
  return body.slice(start, start + MAX_CONTEXT_CHARS);
}

export function buildApplyLinkInput(
  p: { title: string; companyName: string; descriptionText: string | null },
  cands: Candidate[],
): string {
  return [
    `Title: ${p.title}`,
    `Company: ${p.companyName}`,
    "",
    "Links:",
    ...cands.map(
      (c, i) => `${i + 1}. ${c.url}${c.anchor !== "" ? ` (link text: ${c.anchor})` : ""}`,
    ),
    "",
    "Posting text around the links:",
    context(p.descriptionText, cands) || "(empty)",
  ].join("\n");
}

/** One Haiku call; throws BudgetExceededError, MissingApiKeyError, LlmOutputError or LlmApiError. */
export function chooseApplyLink(
  p: { postingId: string; title: string; companyName: string; descriptionText: string | null },
  cands: Candidate[],
  deps: LlmDeps,
): Promise<ApplyLinkAnswer> {
  return callStructured(
    {
      model: APPLY_LINK_MODEL,
      purpose: "apply_link",
      system: APPLY_LINK_SYSTEM_PROMPT,
      input: buildApplyLinkInput(p, cands),
      schema: ApplyLinkWireSchema,
      maxTokens: APPLY_LINK_MAX_TOKENS,
      postingId: p.postingId,
    },
    deps,
  );
}
