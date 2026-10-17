import { z } from "zod";
import { slugCandidates } from "../apply-links/slugs.ts";

/** Lookup requests per posting (card t_5b6fb1d5). */
export const MAX_BOARD_LOOKUPS = 5;
export const BOARD_NOT_FOUND = "greenhouse board not found for gh_jid";

const SAFE_SLUG = /^[A-Za-z0-9]([A-Za-z0-9_-]*[A-Za-z0-9])?$/;
const PAGE_PREFIXES = new Set(["www", "careers", "jobs", "about", "apply", "work"]);

/** The tenant-looking label of a career page's host: `instacart.careers` -> `instacart`, `careers.acme.com` -> `acme`. */
export function hostLabel(pageUrl: string): string | null {
  let host: string;
  try {
    host = new URL(pageUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  const labels = host.split(".");
  while (labels.length > 2 && PAGE_PREFIXES.has(labels[0] ?? "")) labels.shift();
  const label = labels.length >= 2 ? (labels[0] ?? "") : "";
  return SAFE_SLUG.test(label) && label.length >= 3 ? label : null;
}

/** Board slugs worth a verified lookup, best first: guesses from the company name, then the career page's host name. */
export function greenhouseSlugCandidates(companyName: string | null, pageUrl: string): string[] {
  const all = [...(companyName === null ? [] : slugCandidates(companyName)), hostLabel(pageUrl)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of all) {
    if (c === null || !SAFE_SLUG.test(c) || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out.slice(0, MAX_BOARD_LOOKUPS);
}

type JsonResult =
  | { kind: "ok"; body: unknown }
  | { kind: "missing" }
  | { kind: "deferred"; status: number }
  | { kind: "error"; reason: string };

export type BoardLookupResult =
  { kind: "verified"; slug: string } | { kind: "not_found" } | { kind: "deferred"; status: number };

const jobBody = z.object({ id: z.number().int() });

/**
 * Verifies each candidate with `GET boards-api.greenhouse.io/v1/boards/<slug>/jobs/<gh_jid>` (logged-out, no redirects
 * followed, the client's per-host rate limit): 200 with the same job id is verified. Never a guessed slug.
 */
export async function resolveGreenhouseSlug(
  http: { getJson(url: string): Promise<JsonResult> },
  jobId: string,
  candidates: readonly string[],
): Promise<BoardLookupResult> {
  for (const slug of candidates.slice(0, MAX_BOARD_LOOKUPS)) {
    const res = await http.getJson(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs/${jobId}`,
    );
    if (res.kind === "deferred") return res;
    if (res.kind !== "ok") continue;
    const parsed = jobBody.safeParse(res.body);
    if (parsed.success && String(parsed.data.id) === jobId) return { kind: "verified", slug };
  }
  return { kind: "not_found" };
}
