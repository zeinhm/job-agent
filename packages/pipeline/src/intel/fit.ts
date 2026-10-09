import { callStructured, type LlmDeps } from "@job-agent/core";
import { z } from "zod";
import type { Extraction } from "./extract.ts";
import { FIT_SYSTEM_PROMPT } from "./prompts/fit.ts";

export { PROMPT_VERSION as FIT_PROMPT_VERSION } from "./prompts/fit.ts";

export const FIT_MODEL = "claude-sonnet-5-5" as const;
const FIT_MAX_TOKENS = 1024;
const MAX_DESCRIPTION_CHARS = 12_000;
export const MAX_REASON_CHARS = 140;

/**
 * Structured outputs accept no numeric or string constraints (research R1 section 2), so the limits are
 * Zod refinements: they are checked here after the call and are left out of the JSON schema sent to the API.
 */
export const FitSchema = z.object({
  score: z.number().refine((n) => Number.isInteger(n) && n >= 0 && n <= 100, "0-100 integer"),
  reasons: z
    .array(z.string().refine((s) => s.trim().length > 0 && s.length <= MAX_REASON_CHARS, "reason"))
    .refine((r) => r.length >= 1 && r.length <= 3, "1-3 reasons"),
  matchedSkills: z.array(z.string()),
  missingSkills: z.array(z.string()),
});
export type Fit = z.infer<typeof FitSchema>;

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
      maxTokens: FIT_MAX_TOKENS,
      postingId: p.postingId,
    },
    deps,
  );
}
