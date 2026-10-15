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
export const ROLE_FAMILIES = [
  "frontend",
  "fullstack",
  "backend",
  "mobile",
  "data_ml",
  "devops_sre",
  "security",
  "design",
  "non_engineering",
  "not_a_job",
] as const;
export type RoleFamily = (typeof ROLE_FAMILIES)[number];

export const PAY_TYPES = ["paid", "unpaid", "equity_only"] as const;
export type PayType = (typeof PAY_TYPES)[number];

export const HOURS_ZONES = ["europe", "americas", "apac", "other"] as const;
export type HoursZone = (typeof HOURS_ZONES)[number];

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
  /**
   * Old intel rows predate this fact: a missing field parses as null (the text does not say). The extract-v3
   * value "engineering" was too coarse to decide on and also parses as null.
   */
  roleFamily: z.preprocess(
    (v) => (v === "engineering" ? null : v),
    z.enum(ROLE_FAMILIES).nullable().default(null),
  ),
  /** The job title the posting hires for, in its words. Old rows predate it: missing parses as null. */
  roleTitle: z.string().nullable().default(null),
  /** Old rows predate this fact: a missing field parses as null (the text does not say). */
  payType: z.enum(PAY_TYPES).nullable().default(null),
  /**
   * The zone whose working hours the posting asks you to overlap with (when you must be online, not where you
   * live). Old rows predate it: missing parses as null.
   */
  hoursZone: z.enum(HOURS_ZONES).nullable().default(null),
  /** Hours of required overlap with `hoursZone`; null when not stated. Old rows: missing parses as null. */
  overlapHours: z.number().nullable().default(null),
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

const unknownEnum = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.enum([...values, "unknown"] as [...T, "unknown"]);
/** A nullable boolean as a three-way enum: nullable fields count against the API's 16-union limit. */
const triState = z.enum(["yes", "no", "unknown"]);
const fromTri = (v: z.infer<typeof triState>): boolean | null =>
  v === "unknown" ? null : v === "yes";
const orNull = <T extends string>(v: T | "unknown"): T | null => (v === "unknown" ? null : v);

/**
 * What the model is asked for. The API rejects schemas with more than 16 union-typed parameters (nullable,
 * type arrays, anyOf), so unknown is spelled "unknown" / "" / 0 here and mapped back to null by `toExtraction`;
 * the stored `Extraction` is unchanged. Only listedSalary stays nullable.
 */
export const ExtractionWireSchema = z.object({
  listedSalary: z
    .object({
      /** 0 = the posting gives no such bound. */
      min: z.number(),
      max: z.number(),
      currency: z.string(),
      period: z.enum(["year", "month", "hour"]),
    })
    .nullable(),
  listedSalaryScope: unknownEnum([
    "all_locations",
    "location_dependent",
    "us_only_or_legal_note",
    "unspecified",
  ]),
  hiringScope: unknownEnum(["worldwide", "region", "countries"]),
  regions: z.array(z.string()),
  remoteRegions: z.array(z.string()),
  allowedCountries: z.array(iso2),
  indonesiaExplicit: triState,
  /** "" = not stated. */
  companyHq: z.string().regex(/^([A-Z]{2})?$/),
  companyType: unknownEnum([
    "product",
    "enterprise",
    "web3_protocol",
    "agency",
    "talent_marketplace",
  ]),
  payPolicy: unknownEnum(["location_agnostic", "location_adjusted"]),
  employment: unknownEnum(["employee", "contractor", "eor"]),
  /** "" = none named. */
  eorProvider: z.string(),
  seniority: unknownEnum(["mid", "senior", "lead"]),
  roleFamily: unknownEnum(ROLE_FAMILIES),
  /** "" = not a job, or no title stated. A plain string, so the union count does not grow. */
  roleTitle: z.string(),
  /** A plain enum with "unknown", so the union count does not grow. */
  payType: unknownEnum(PAY_TYPES),
  /** A plain enum with "unknown", so the union count does not grow. */
  hoursZone: unknownEnum(HOURS_ZONES),
  /** 0 = not stated. A plain number, so the union count does not grow. */
  overlapHours: z.number(),
  contactChannels: ExtractionSchema.shape.contactChannels,
  personalEmailDomain: triState,
  asksForPaymentOrId: triState,
  repoAssessmentEarly: triState,
  urgencyLanguage: triState,
  vagueDescription: triState,
});
export type ExtractionWire = z.infer<typeof ExtractionWireSchema>;

/** Wire output to the stored shape; the only place "unknown" turns into null. */
export function toExtraction(w: ExtractionWire): Extraction {
  return {
    listedSalary: w.listedSalary && {
      min: w.listedSalary.min > 0 ? w.listedSalary.min : null,
      max: w.listedSalary.max > 0 ? w.listedSalary.max : null,
      currency: w.listedSalary.currency,
      period: w.listedSalary.period,
    },
    listedSalaryScope: orNull(w.listedSalaryScope),
    hiringScope: orNull(w.hiringScope),
    regions: w.regions,
    remoteRegions: w.remoteRegions,
    allowedCountries: w.allowedCountries,
    indonesiaExplicit: fromTri(w.indonesiaExplicit),
    companyHq: w.companyHq === "" ? null : w.companyHq,
    companyType: orNull(w.companyType),
    payPolicy: orNull(w.payPolicy),
    employment: orNull(w.employment),
    eorProvider: w.eorProvider.trim() === "" ? null : w.eorProvider,
    seniority: orNull(w.seniority),
    roleFamily: orNull(w.roleFamily),
    roleTitle: w.roleTitle.trim() === "" ? null : w.roleTitle.trim(),
    payType: orNull(w.payType),
    hoursZone: orNull(w.hoursZone),
    overlapHours: w.overlapHours > 0 ? w.overlapHours : null,
    contactChannels: w.contactChannels,
    personalEmailDomain: fromTri(w.personalEmailDomain),
    asksForPaymentOrId: fromTri(w.asksForPaymentOrId),
    repoAssessmentEarly: fromTri(w.repoAssessmentEarly),
    urgencyLanguage: fromTri(w.urgencyLanguage),
    vagueDescription: fromTri(w.vagueDescription),
  };
}

export interface ExtractInput {
  /** Absent for eval cases: they are not postings in the DB, so the call is recorded without one. */
  postingId?: string | undefined;
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
export function extractFacts(
  p: ExtractInput,
  deps: LlmDeps,
  purpose: "extract" | "eval_extract" | "eval_fit" = "extract",
): Promise<Extraction> {
  return callStructured(
    {
      model: EXTRACT_MODEL,
      purpose,
      system: EXTRACT_SYSTEM_PROMPT,
      input: buildExtractInput(p),
      schema: ExtractionWireSchema,
      map: toExtraction,
      maxTokens: EXTRACT_MAX_TOKENS,
      ...(p.postingId !== undefined ? { postingId: p.postingId } : {}),
    },
    deps,
  );
}
