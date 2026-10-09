import { callStructured, type LlmDeps } from "@job-agent/core";
import { z } from "zod";
import { EXTRACT_SYSTEM_PROMPT } from "./prompts/extract.ts";

export { PROMPT_VERSION as EXTRACT_PROMPT_VERSION } from "./prompts/extract.ts";

export const EXTRACT_MODEL = "claude-haiku-5-5" as const;
const EXTRACT_MAX_TOKENS = 1024;
const MAX_DESCRIPTION_CHARS = 12_000;

const iso2 = z.string().regex(/^[A-Z]{2}$/);

/**
 * Facts only (PLAN 5.1 PayContext plus company, EOR and the scam signals only the LLM can see).
 * Every field may be unknown: null, or an empty list.
 */
export const ExtractionSchema = z.object({
  listedSalary: z
    .object({
      min: z.number().nullable(),
      max: z.number().nullable(),
      currency: z.string(),
      period: z.enum(["year", "month", "hour"]),
    })
    .nullable(),
  listedSalaryScope: z
    .enum(["all_locations", "location_dependent", "us_only_or_legal_note", "unspecified"])
    .nullable(),
  hiringScope: z.enum(["worldwide", "region", "countries"]).nullable(),
  regions: z.array(z.string()),
  remoteRegions: z.array(z.string()),
  allowedCountries: z.array(iso2),
  indonesiaExplicit: z.boolean().nullable(),
  companyHq: iso2.nullable(),
  companyType: z
    .enum(["product", "enterprise", "web3_protocol", "agency", "talent_marketplace"])
    .nullable(),
  payPolicy: z.enum(["location_agnostic", "location_adjusted"]).nullable(),
  employment: z.enum(["employee", "contractor", "eor"]).nullable(),
  eorProvider: z.string().nullable(),
  seniority: z.enum(["mid", "senior", "lead"]).nullable(),
  /** Old intel rows predate this fact: a missing field parses as null (the text does not say). */
  roleFamily: z.enum(["engineering", "non_engineering"]).nullable().default(null),
  contactChannels: z.array(
    z.enum(["email", "company_form", "ats", "telegram", "whatsapp", "discord", "other_chat"]),
  ),
  personalEmailDomain: z.boolean().nullable(),
  asksForPaymentOrId: z.boolean().nullable(),
  repoAssessmentEarly: z.boolean().nullable(),
  urgencyLanguage: z.boolean().nullable(),
  vagueDescription: z.boolean().nullable(),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export interface ExtractInput {
  postingId: string;
  title: string;
  companyName: string;
  locationText: string | null;
  salaryText: string | null;
  descriptionText: string | null;
}

/** The variable part of the request. Contains posting text, so it is never logged. */
export function buildExtractInput(p: ExtractInput): string {
  const description = (p.descriptionText ?? "").slice(0, MAX_DESCRIPTION_CHARS);
  return [
    `Title: ${p.title}`,
    `Company: ${p.companyName}`,
    `Location: ${p.locationText ?? "(not given)"}`,
    `Salary field: ${p.salaryText ?? "(not given)"}`,
    "",
    "Description:",
    description || "(empty)",
  ].join("\n");
}

/** One Haiku call; throws BudgetExceededError, MissingApiKeyError, LlmOutputError or LlmApiError. */
export function extractFacts(p: ExtractInput, deps: LlmDeps): Promise<Extraction> {
  return callStructured(
    {
      model: EXTRACT_MODEL,
      purpose: "extract",
      system: EXTRACT_SYSTEM_PROMPT,
      input: buildExtractInput(p),
      schema: ExtractionSchema,
      maxTokens: EXTRACT_MAX_TOKENS,
      postingId: p.postingId,
    },
    deps,
  );
}
