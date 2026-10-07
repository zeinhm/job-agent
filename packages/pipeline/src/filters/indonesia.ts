import { EOR_PHRASES, INDONESIA_PHRASES } from "./keywords.ts";
import { phrasePattern } from "./phrases.ts";

export type IndonesiaClass = "not_applicable" | "foreign_hiring_id" | "domestic" | "unclear";

export type IndonesiaInput = {
  locationText?: string | null;
  descriptionText?: string | null;
  /** ISO 3166-1 alpha-2 code of the company HQ, when known. */
  companyHqCountry?: string | null;
  companyDomain?: string | null;
  /** ISO 4217 code of the listed salary, when any. */
  salaryCurrency?: string | null;
};

export type IndonesiaResult = { value: IndonesiaClass; reason: string };

function firstMatch(text: string, phrases: readonly string[]): string | undefined {
  return phrases.find((phrase) => phrasePattern(phrase).test(text));
}

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
}

export function classifyIndonesia(input: IndonesiaInput): IndonesiaResult {
  const location = clean(input.locationText);
  const description = clean(input.descriptionText);
  const hq = clean(input.companyHqCountry).toUpperCase();
  const domain = clean(input.companyDomain).toLowerCase().replace(/\.$/, "");
  const currency = clean(input.salaryCurrency).toUpperCase();

  if (hq === "ID") return { value: "domestic", reason: "Company HQ is in Indonesia (ID)." };

  const mention =
    firstMatch(location, INDONESIA_PHRASES) ?? firstMatch(description, INDONESIA_PHRASES);
  const idDomain = domain.endsWith(".id");

  if (!mention && !idDomain) {
    return {
      value: "not_applicable",
      reason: "No Indonesia mention in location or description, and the domain is not .id.",
    };
  }

  const where = mention ? `Indonesia mention "${mention}"` : `.id domain "${domain}"`;

  if (hq) {
    return {
      value: "foreign_hiring_id",
      reason: `${where}; company HQ is in ${hq}, not Indonesia.`,
    };
  }

  const eor = firstMatch(location, EOR_PHRASES) ?? firstMatch(description, EOR_PHRASES);
  const foreignSignal =
    currency !== "" && currency !== "IDR"
      ? `salary in ${currency}`
      : eor
        ? `employer-of-record mention "${eor}"`
        : undefined;

  if (idDomain) {
    return foreignSignal
      ? {
          value: "unclear",
          reason: `Domain "${domain}" is .id but there is a foreign signal (${foreignSignal}).`,
        }
      : {
          value: "domestic",
          reason: `Domain "${domain}" is .id with no foreign salary currency or employer-of-record mention.`,
        };
  }

  if (foreignSignal) {
    return {
      value: "foreign_hiring_id",
      reason: `${where}; HQ unknown; foreign signal: ${foreignSignal}.`,
    };
  }

  return {
    value: "unclear",
    reason: `${where}; HQ unknown and no foreign salary currency or employer-of-record mention.`,
  };
}
