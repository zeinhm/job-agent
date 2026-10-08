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

/**
 * Country names (and common abbreviations) that make a "Countries: ...", "Remote, <country>" or
 * "<country> (Remote)" location a restriction. Indonesia and the APAC region words are deliberately absent:
 * they are APAC signals and win first. Matched as whole list items, case-insensitively.
 */
export const RESTRICTED_COUNTRY_NAMES: readonly string[] = [
  "United States",
  "United States of America",
  "USA",
  "US",
  "U.S.",
  "U.S.A.",
  "United Kingdom",
  "UK",
  "U.K.",
  "Canada",
  "Mexico",
  "Brazil",
  "Argentina",
  "Chile",
  "Colombia",
  "Peru",
  "Uruguay",
  "Costa Rica",
  "Germany",
  "France",
  "Spain",
  "Portugal",
  "Italy",
  "Netherlands",
  "Belgium",
  "Switzerland",
  "Austria",
  "Ireland",
  "Poland",
  "Czech Republic",
  "Czechia",
  "Romania",
  "Bulgaria",
  "Hungary",
  "Greece",
  "Sweden",
  "Norway",
  "Denmark",
  "Finland",
  "Estonia",
  "Latvia",
  "Lithuania",
  "Ukraine",
  "Serbia",
  "Croatia",
  "Slovenia",
  "Slovakia",
  "Turkey",
  "Israel",
  "United Arab Emirates",
  "UAE",
  "Saudi Arabia",
  "Egypt",
  "Nigeria",
  "Kenya",
  "Ghana",
  "South Africa",
  "Morocco",
  "Pakistan",
  "Bangladesh",
  "Sri Lanka",
  "Nepal",
  "India",
  "Philippines",
  "Vietnam",
  "Thailand",
  "Malaysia",
  "Singapore",
  "Cambodia",
  "Japan",
  "South Korea",
  "Taiwan",
  "Hong Kong",
  "China",
  "Australia",
  "New Zealand",
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

/** Junior, intern and graduate wording in the title: rejected before anything else (owner decision 2026-10-08). */
export const ROLE_JUNIOR_PHRASES: readonly string[] = [
  "junior",
  "jr",
  "intern",
  "internship",
  "graduate",
  "new grad",
  "trainee",
  "apprentice",
  "entry level",
  "entry-level",
];

/** Target-role skills in the title. A hit keeps the posting, even next to a backend or data word ("Full-Stack (React/Node)"). */
export const ROLE_TARGET_PHRASES: readonly string[] = [
  "frontend",
  "front-end",
  "front end",
  "full-stack",
  "full stack",
  "fullstack",
  "react",
  "typescript",
  "javascript",
  "next.js",
  "nextjs",
  "next js",
  "web3",
  "dapp",
  "ui engineer",
  "web engineer",
  "web developer",
];

/** Mobile-framework phrases: a title containing one is rejected even next to "Front-End" or "React". */
export const ROLE_TARGET_EXCLUDED_PHRASES: readonly string[] = ["react native", "flutter"];

/** Non-engineering roles: rejected unless the title has a target skill. */
export const ROLE_NON_ENGINEERING_PHRASES: readonly string[] = [
  "attorney",
  "lawyer",
  "counsel",
  "paralegal",
  "legal",
  "medical",
  "physician",
  "nurse",
  "clinical",
  "pharmacist",
  "sales",
  "account executive",
  "account manager",
  "business development",
  "marketing",
  "seo",
  "copywriter",
  "content writer",
  "technical writer",
  "writer",
  "service desk",
  "help desk",
  "helpdesk",
  "psychotherapist",
  "therapist",
  "recruiter",
  "talent acquisition",
  "human resources",
  "hr",
  "people operations",
  "customer success",
  "customer support",
  "support specialist",
  "support engineer",
  "solutions engineer",
  "customer engineer",
  "accountant",
  "finance",
  "bookkeeper",
  "operations manager",
  "office manager",
  "executive assistant",
  "product manager",
  "project manager",
  "program manager",
  "product designer",
  "ux designer",
  "ui designer",
  "graphic designer",
  "website designer",
  "community manager",
  "social media",
  "developer advocate",
  "developer relations",
  "data entry",
  "compliance",
  "partnerships",
];

/** Engineering roles outside the target: rejected unless the title has a target skill. */
export const ROLE_OUT_OF_TARGET_PHRASES: readonly string[] = [
  "backend",
  "back-end",
  "back end",
  "mobile",
  "react native",
  "ios",
  "android",
  "flutter",
  "data engineer",
  "data engineering",
  "data platform",
  "data scientist",
  "data analyst",
  "analytics engineer",
  "machine learning",
  "ml",
  "devops",
  "sre",
  "site reliability",
  "infrastructure engineer",
  "cloud engineer",
  "qa",
  "quality assurance",
  "test engineer",
  "shopify",
  "security software",
  "test automation",
  "research engineer",
  "research scientist",
  "database",
  "platform engineer",
  "sdet",
  "embedded",
  "firmware",
  "golang",
  "python",
  "java",
  "php",
  "ruby",
  "rust",
  "c++",
  ".net",
  "scala",
  "kotlin",
];

/** Engineering and frontend leadership titles: kept without a flag (owner decision 2026-10-08). */
export const ROLE_LEADERSHIP_PHRASES: readonly string[] = [
  "engineering manager",
  "head of engineering",
  "vp of engineering",
  "vp engineering",
  "director of engineering",
  "tech lead",
  "technical lead",
  "cto",
];

/** Seniority words dropped before comparing a title with ROLE_GENERIC_TITLES. */
export const ROLE_SENIORITY_WORDS: readonly string[] = [
  "senior",
  "sr",
  "staff",
  "principal",
  "lead",
  "mid-level",
  "mid level",
  "remote",
];

/** Engineering titles with no skill in them: kept with the `role_unclear` flag, never rejected (owner decision 2026-10-08). */
export const ROLE_GENERIC_TITLES: readonly string[] = [
  "engineer",
  "software engineer",
  "software developer",
  "developer",
  "product engineer",
  "founding engineer",
  "member of technical staff",
  "mts",
  "design engineer",
];
