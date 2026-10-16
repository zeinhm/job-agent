import { companyNameWords } from "../normalize/company.ts";

/** At most this many slug candidates are tried per company (docs/phase-3-conventions.md section 2). */
export const MAX_SLUG_CANDIDATES = 3;

const GENERIC_FIRST_WORDS = new Set([
  "global",
  "digital",
  "group",
  "tech",
  "labs",
  "software",
  "systems",
  "solutions",
  "the",
  "new",
  "first",
]);

const MIN_SLUG_LENGTH = 3;

/** Company name -> words without accents, domain suffix, legal words and "the" (filler words stay: boards use them). */
function nameWords(name: string): string[] {
  return companyNameWords(name.replace(/&/g, " and "), { keepCase: true, keepFiller: true });
}

/**
 * Slug guesses for a company name, best first, at most MAX_SLUG_CANDIDATES (research t_5f31fe9d section 1):
 * A = words joined, B = words joined with "-", C = first word (only for a multi-word name whose first word is
 * 4+ characters and not generic). With `keepCase` (SmartRecruiters ids are case-sensitive) A keeps the case of
 * the name's words.
 */
export function slugCandidates(name: string, keepCase = false): string[] {
  const words = nameWords(name);
  if (words.length === 0) return [];
  const lower = words.map((w) => w.toLowerCase());
  const first = lower[0] ?? "";
  const candidates = [
    keepCase ? words.join("") : lower.join(""),
    lower.join("-"),
    ...(lower.length > 1 && first.length >= 4 && !GENERIC_FIRST_WORDS.has(first) ? [first] : []),
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const c of candidates) {
    if (c.length < MIN_SLUG_LENGTH || seen.has(c)) continue;
    seen.add(c);
    result.push(c);
  }
  return result.slice(0, MAX_SLUG_CANDIDATES);
}
