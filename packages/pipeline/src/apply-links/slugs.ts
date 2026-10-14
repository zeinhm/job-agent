/** At most this many slug candidates are tried per company (docs/phase-3-conventions.md section 2). */
export const MAX_SLUG_CANDIDATES = 3;

const LEGAL_SUFFIXES = new Set([
  "inc",
  "llc",
  "ltd",
  "limited",
  "gmbh",
  "ag",
  "corp",
  "corporation",
  "co",
  "company",
  "plc",
  "bv",
  "sa",
  "pte",
  "sdn",
  "bhd",
  "pty",
]);

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

/** Company name -> lowercase words without accents, legal suffixes and a leading "the". */
function nameWords(name: string): string[] {
  const words = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/&/g, " and ")
    .replace(/[^A-Za-z0-9 -]/g, " ")
    .split(/[\s]+/)
    .filter(Boolean);
  while (words.length > 0 && LEGAL_SUFFIXES.has((words.at(-1) ?? "").toLowerCase())) words.pop();
  if ((words[0] ?? "").toLowerCase() === "the") words.shift();
  return words;
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
