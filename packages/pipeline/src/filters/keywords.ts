/**
 * Keyword lists for the rule-based filters, all in one module (owner decision 2026-10-06).
 * Phrases are matched case-insensitively on word boundaries, except those in CASE_SENSITIVE_PHRASES.
 * Timezone ranges are not listed here: they are parsed in location.ts.
 */

/** Phrases that only count when written exactly like this (short tokens that are also ordinary words). */
export const CASE_SENSITIVE_PHRASES: readonly string[] = ["SEA"];

/** APAC signals: location text, tags, or (lower precedence) description. */
export const APAC_PHRASES: readonly string[] = [
  "APAC",
  "Asia",
  "Asia-Pacific",
  "Asia Pacific",
  "Southeast Asia",
  "South East Asia",
  "SEA",
  "Indonesia",
  "WIB",
];

/** Geographic or eligibility restrictions that exclude an Indonesia-based candidate. */
export const RESTRICTION_PHRASES: readonly string[] = [
  "US only",
  "U.S. only",
  "Remote (US",
  "Remote (U.S.",
  "US-based",
  "U.S.-based",
  "US time zones",
  "U.S. time zones",
  "US hours",
  "must reside in",
  "must be located in",
  "authorized to work in the US",
  "authorized to work in the U.S.",
  "authorized to work in the UK",
  "authorized to work in the EU",
  "EU only",
  "UK only",
  "Canada only",
  "within UK",
  "within the UK",
  "within Europe",
  "within the EU",
  "North America",
  "South America",
  "Americas",
  "EMEA",
  "LATAM",
];

/** On-site or hybrid wording in the location text. Restricts unless a remote option is stated. */
export const ONSITE_PHRASES: readonly string[] = [
  "on-site",
  "onsite",
  "on site",
  "hybrid",
  "in-office",
  "in office",
];

/** The location text or tags offer a remote option. */
export const REMOTE_PHRASES: readonly string[] = ["remote", "work from home", "WFH"];

/** Wording that says there is no remote option (location, tags or description). */
export const NO_REMOTE_PHRASES: readonly string[] = [
  "no remote",
  "not remote",
  "not fully remote",
  "not a remote",
  "on-site only",
  "onsite only",
  "on site only",
  "in-office only",
];

/** Worldwide wording in the location text or tags. */
export const WORLDWIDE_LOCATION_PHRASES: readonly string[] = [
  "worldwide",
  "world wide",
  "anywhere",
  "global",
  "globally",
  "(world)",
  "work from anywhere",
  "remote - anywhere",
];

/** Worldwide wording in the description. More specific than the location list: "global" alone is marketing copy there. */
export const WORLDWIDE_DESCRIPTION_PHRASES: readonly string[] = [
  "worldwide",
  "work from anywhere",
  "remote - anywhere",
  "anywhere in the world",
  "hire globally",
  "hiring globally",
  "global hiring",
  "no geographic restriction",
  "no geographic restrictions",
  "no location restriction",
  "no location restrictions",
  "no timezone restriction",
  "no us timezone restriction",
  "no restrictions",
];

/** Indonesia mention in the location text or description (cities, country, demonym, timezone). */
export const INDONESIA_PHRASES: readonly string[] = [
  "Indonesia",
  "Indonesian",
  "Jakarta",
  "Bandung",
  "Surabaya",
  "Yogyakarta",
  "Bali",
  "Denpasar",
  "Medan",
  "Semarang",
  "WIB",
];

/** Employer-of-record signals. The bare word "remote" is not one; only the provider "Remote.com" is. */
export const EOR_PHRASES: readonly string[] = [
  "employer of record",
  "EOR",
  "Deel",
  "Remote.com",
  "Oyster",
  "Papaya Global",
  "Multiplier",
  "Velocity Global",
  "Globalization Partners",
  "G-P",
  "Omnipresent",
];
