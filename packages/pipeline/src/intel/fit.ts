import { callStructured, type LlmDeps } from "@job-agent/core";
import { z } from "zod";
import type { Extraction } from "./extract.ts";
import { FIT_SYSTEM_PROMPT } from "./prompts/fit.ts";

export { PROMPT_VERSION as FIT_PROMPT_VERSION } from "./prompts/fit.ts";

export const FIT_MODEL = "claude-sonnet-5-5" as const;
/**
 * Measured output: 300 tokens in the fixture, about 450 in the owner's live run (2026-10-09). Thinking is set to
 * `between_tools` (no tools are used, so none is expected), but thinking would count against `max_tokens`
 * (research t_01c08cc2, section 2), so it is included: 2 x 450 = 900 for the answer, + 600 for any thinking = 1500,
 * rounded up to 1536. The $1/day reservation uses this value (`reserveUsd`).
 */
export const FIT_MAX_TOKENS = 1536;
const MAX_DESCRIPTION_CHARS = 12_000;
export const MAX_REASON_CHARS = 140;
export const MAX_REASONS = 3;

/**
 * Structured outputs accept no numeric or string constraints (research R1 section 2), so the score range is a Zod
 * refinement checked after the call. Reason length and count are display text, not decisions: `normalizeFit` cuts
 * them in code instead of failing the whole score.
 */
export const FitSchema = z.object({
  score: z.number().refine((n) => Number.isInteger(n) && n >= 0 && n <= 100, "0-100 integer"),
  reasons: z
    .array(z.string())
    .refine((r) => r.length >= 1 && r.every((s) => s.trim().length > 0), "reason"),
  matchedSkills: z.array(z.string()),
  missingSkills: z.array(z.string()),
});
export type Fit = z.infer<typeof FitSchema>;

/** Cuts a reason longer than `max` on a word boundary and ends it with "…" (result is at most `max` chars). */
export function truncateReason(reason: string, max = MAX_REASON_CHARS): string {
  const text = reason.trim();
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const space = room.lastIndexOf(" ");
  const cut = space > 0 ? room.slice(0, space) : room;
  return `${cut.replace(/[\s,;:.\-]+$/, "")}…`;
}

/** Keeps the first 3 reasons and cuts each to `MAX_REASON_CHARS`. */
export function normalizeFit(fit: Fit): Fit {
  return { ...fit, reasons: fit.reasons.slice(0, MAX_REASONS).map((r) => truncateReason(r)) };
}

/** A posting whose fit failed is tried again on later runs, at most this many runs in total. */
export const MAX_FIT_ATTEMPTS = 3;
const FIT_ATTEMPT_RE = /^fit_attempt:(\d+)$/;

/** Failed fit runs recorded in `intel.resolved_reasons` (JSON array of strings); 0 when there is no marker. */
export function failedFitRuns(resolvedReasons: string | null): number {
  let list: unknown;
  try {
    list = JSON.parse(resolvedReasons ?? "[]");
  } catch {
    return 0;
  }
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const r of list) {
    const m = typeof r === "string" ? FIT_ATTEMPT_RE.exec(r) : null;
    if (m?.[1] !== undefined) n = Math.max(n, Number(m[1]));
  }
  return n;
}

export const fitAttemptMarker = (n: number): string => `fit_attempt:${n}`;

export interface FitInput {
  postingId: string;
  title: string;
  companyName: string;
  locationText: string | null;
  descriptionText: string | null;
  extraction: Extraction;
}

/** The static, cacheable block: the CV. Never logged. */
export function buildCvPrefix(cv: string): string {
  return `Candidate CV:\n\n${cv.trim()}`;
}

/** The variable part of the request. Contains posting text, so it is never logged. */
export function buildFitInput(p: FitInput): string {
  const description = (p.descriptionText ?? "").slice(0, MAX_DESCRIPTION_CHARS);
  return [
    `Title: ${p.title}`,
    `Company: ${p.companyName}`,
    `Location: ${p.locationText ?? "(not given)"}`,
    `Extracted facts: ${JSON.stringify(p.extraction)}`,
    "",
    "Description:",
    description || "(empty)",
  ].join("\n");
}

/** One Sonnet call; throws BudgetExceededError, MissingApiKeyError, LlmOutputError or LlmApiError. */
export function scoreFit(p: FitInput, cv: string, deps: LlmDeps): Promise<Fit> {
  return callStructured(
    {
      model: FIT_MODEL,
      purpose: "fit",
      system: FIT_SYSTEM_PROMPT,
      cacheablePrefix: buildCvPrefix(cv),
      input: buildFitInput(p),
      schema: FitSchema,
      map: normalizeFit,
      maxTokens: FIT_MAX_TOKENS,
      postingId: p.postingId,
    },
    deps,
  );
}
