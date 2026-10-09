import type { SalaryConfig } from "@job-agent/core";
import type { Extraction } from "./extract.ts";
import { statedPolicy, type CompanyPayPolicy, type PayPolicy } from "./registry.ts";

export type Tier = "indonesia" | "regional" | "global_adjusted" | "global_flat";
export type TierBranch =
  "listed_agnostic" | "us_legal_note_unknown" | "flat" | "adjusted" | "unknown";

/** Units of each currency per 1 USD. `idrPerUsd` is required; `perUsd` covers other currencies. */
export interface TierFx {
  idrPerUsd: number;
  perUsd?: Readonly<Record<string, number>>;
}

export interface TierAsk {
  branch: TierBranch;
  tier: Tier;
  /** Always set, whole IDR per month, never below the floor. */
  askIdrMonth: number;
  /** Always set, whole USD per year (rounded up), never below the floor once converted back to IDR. */
  askUsdYear: number;
  /** Only for branches that cannot name a number (unknown policy): the answer for free-text fields. */
  askText: string | null;
  /** Branch and the inputs used. Never contains the floor or the configured tier asks. */
  askReason: string;
}

/** Same conversion as the salary normalizer: yearly / 12, hourly x 160. */
const TO_MONTH = { year: 1 / 12, month: 1, hour: 160 } as const;

const APAC_WORDS = /\b(apac|asia|southeast asia|sea|asean)\b/i;

function perUsd(fx: TierFx, currency: string): number | null {
  const code = currency.toUpperCase();
  if (code === "USD") return 1;
  if (code === "IDR") return fx.idrPerUsd;
  const rate = fx.perUsd?.[code];
  return rate !== undefined && Number.isFinite(rate) && rate > 0 ? rate : null;
}

interface ListedIdr {
  min: number | null;
  max: number | null;
}

/** Listed range in IDR per month (unrounded), or null when it has no number or no FX rate. */
function listedInIdrMonth(x: Extraction, fx: TierFx): ListedIdr | "no_fx" | null {
  const s = x.listedSalary;
  if (s === null) return null;
  const hasMin = s.min !== null && s.min > 0;
  const hasMax = s.max !== null && s.max > 0;
  if (!hasMin && !hasMax) return null;
  const rate = perUsd(fx, s.currency);
  if (rate === null) return "no_fx";
  const toIdr = (n: number) => ((n * TO_MONTH[s.period]) / rate) * fx.idrPerUsd;
  return {
    min: hasMin ? toIdr(s.min as number) : null,
    max: hasMax ? toIdr(s.max as number) : null,
  };
}

function describeListed(x: Extraction): string {
  const s = x.listedSalary;
  if (s === null) return "no listed range";
  const range =
    s.min !== null && s.max !== null && s.min !== s.max ? `${s.min}-${s.max}` : `${s.max ?? s.min}`;
  return `listed ${range} ${s.currency.toUpperCase()}/${s.period}`;
}

function indonesiaSpecific(x: Extraction): boolean {
  const onlyId = x.allowedCountries.length === 1 && x.allowedCountries[0] === "ID";
  const explicitLocal = x.indonesiaExplicit === true && x.hiringScope === "countries";
  const localEor = x.indonesiaExplicit === true && x.employment === "eor";
  return onlyId || (explicitLocal && x.allowedCountries.length <= 1) || localEor;
}

function regionLimited(x: Extraction): boolean {
  if (x.companyType === "agency" || x.companyType === "talent_marketplace") return true;
  if (x.hiringScope === "region" || x.hiringScope === "countries") return true;
  return x.regions.some((r) => APAC_WORDS.test(r));
}

/** Tier for the location-adjusted and unknown cases (PLAN 5.3 table). */
function adjustedTier(x: Extraction): Tier {
  if (indonesiaSpecific(x)) return "indonesia";
  if (regionLimited(x)) return "regional";
  return "global_adjusted";
}

function effectivePolicy(x: Extraction, registry: CompanyPayPolicy): PayPolicy {
  // The registry already holds the posting's own claim (registry stage), and keeps manual / careers sources.
  if (registry.policy !== "unknown") return registry.policy;
  const stated = statedPolicy(x);
  if (stated !== null) return stated;
  // PLAN 5.2 lower-tier signal: a listed range that depends on the hire's location.
  if (x.listedSalaryScope === "location_dependent") return "location_adjusted";
  return "unknown";
}

/**
 * Tier and ask from extracted facts (PLAN 5.3). Pure: no I/O, no clock, no LLM.
 * The floor always applies; every ask is checked in IDR per month.
 */
export function decideTierAndAsk(
  extraction: Extraction,
  payPolicy: CompanyPayPolicy,
  salary: SalaryConfig,
  fx: TierFx,
): TierAsk {
  const floor = salary.floor_idr_month;
  const policy = effectivePolicy(extraction, payPolicy);
  const inputs: string[] = [
    describeListed(extraction),
    `scope=${extraction.listedSalaryScope ?? "none"}`,
    `policy=${policy}${payPolicy.source !== null ? ` (registry ${payPolicy.source})` : ""}`,
    `hiring=${extraction.hiringScope ?? "unknown"}`,
    `company=${extraction.companyType ?? "unknown"}`,
    `employment=${extraction.employment ?? "unknown"}`,
  ];

  const usNote = extraction.listedSalaryScope === "us_only_or_legal_note";
  const listed = usNote ? null : listedInIdrMonth(extraction, fx);
  if (listed === "no_fx") inputs.push("listed range ignored: no FX rate for its currency");

  const range = listed === null || listed === "no_fx" ? null : listed;
  const agnosticRange =
    range !== null &&
    (extraction.listedSalaryScope === "all_locations" ||
      (extraction.listedSalaryScope !== "location_dependent" && policy === "location_agnostic"));

  let branch: TierBranch;
  let tier: Tier;
  let rawIdr: number;
  let askText: string | null = null;
  let configuredUsdYear: number | null = null;
  const notes: string[] = [];

  if (range !== null && agnosticRange) {
    branch = "listed_agnostic";
    tier = "global_flat";
    const { min, max } = range;
    const p = salary.position_in_listed_range;
    if (min !== null && max !== null) rawIdr = min + p * (Math.max(max, min) - min);
    else if (max !== null) rawIdr = max * p;
    else rawIdr = min as number;
    const cap = max ?? Number.POSITIVE_INFINITY;
    rawIdr = Math.min(Math.round(rawIdr), Math.floor(cap));
    notes.push(`position ${p} in listed range`);
  } else if (usNote) {
    branch = "us_legal_note_unknown";
    tier = "regional";
    rawIdr = salary.tiers.regional.ask_idr_month;
    askText = salary.text_field_answer;
    notes.push("listed range is a US pay-transparency / legal note, treated as unknown");
  } else if (policy === "location_agnostic") {
    branch = "flat";
    tier = "global_flat";
    configuredUsdYear = salary.tiers.global_flat.ask_usd_year;
    rawIdr = Math.ceil((configuredUsdYear / 12) * fx.idrPerUsd);
  } else if (policy === "location_adjusted") {
    branch = "adjusted";
    tier = adjustedTier(extraction);
    rawIdr =
      tier === "indonesia"
        ? salary.tiers.indonesia.ask_idr_month
        : tier === "regional"
          ? salary.tiers.regional.ask_idr_month
          : salary.tiers.global_adjusted.ask_idr_month;
  } else {
    branch = "unknown";
    tier = "regional";
    rawIdr = salary.tiers.regional.ask_idr_month;
    askText = salary.text_field_answer;
    notes.push("policy unknown, text field answer plus regional number");
  }

  let askIdrMonth = Math.round(rawIdr);
  if (askIdrMonth < floor) {
    askIdrMonth = Math.ceil(floor);
    notes.push("raised to floor");
    configuredUsdYear = null;
  }
  // Round the USD figure up so converting back to IDR can never land under the floor.
  const askUsdYear = configuredUsdYear ?? Math.ceil((askIdrMonth * 12) / fx.idrPerUsd);

  return {
    branch,
    tier,
    askIdrMonth,
    askUsdYear,
    askText,
    askReason: `branch=${branch}; tier=${tier}; ${inputs.join(", ")}${notes.length > 0 ? `; ${notes.join("; ")}` : ""}`,
  };
}

/** Reason older runs stored when they finished a posting without a tier because no IDR rate existed. */
export const TIER_SKIPPED_NO_FX = "tier skipped: no IDR FX rate stored";
