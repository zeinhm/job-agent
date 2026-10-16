/** Legal-form words; removed as whole words anywhere in a name. */
const LEGAL_WORDS = new Set([
  "inc",
  "llc",
  "ltd",
  "limited",
  "gmbh",
  "ag",
  "sa",
  "bv",
  "pte",
  "pty",
  "plc",
  "corp",
  "corporation",
  "co",
  "srl",
  "oy",
  "ab",
  "as",
  "kk",
  "tbk",
  "pt",
  "sdn",
  "bhd",
  "company",
]);

/** Filler words; removed as whole words, except one in first place (see `companyNameWords`). "the" goes everywhere. */
const FILLER_WORDS = new Set([
  "operations",
  "technologies",
  "technology",
  "labs",
  "group",
  "holdings",
  "software",
  "solutions",
  "hq",
  "the",
]);

const DOMAIN_TLDS = "io|com|co|ai|dev|app|net|org|xyz|tech";
/** A token that is a domain name: label(s), then a known TLD, a two-letter country TLD, or `co.uk`-style pair. */
const DOMAIN_NAME_RE = new RegExp(
  `^([a-z0-9-]{2,}(?:\\.[a-z0-9-]+)*?)\\.(?:(?:co|com|org|ac|gov|net)\\.[a-z]{2}|${DOMAIN_TLDS}|[a-z]{2})$`,
);

export interface CompanyWordsOptions {
  /** Keep the case of the name's words (SmartRecruiters ids are case-sensitive). Default false: lowercase. */
  keepCase?: boolean;
  /** Keep filler words other than "the" (slug guesses: boards are often named "Acme Labs"). Default false. */
  keepFiller?: boolean;
}

/**
 * The distinctive words of a company name: accents folded, a domain suffix cut off a domain-looking token
 * ("tether.io" -> "tether"), legal and filler words removed as whole words. A filler word that comes first
 * among the kept words stays ("Group One" is not "One"). If nothing is left, the cleaned words are returned unchanged ("Operations Limited").
 */
export function companyNameWords(name: string, opts: CompanyWordsOptions = {}): string[] {
  const folded = name.normalize("NFKD").replace(/\p{M}/gu, "");
  const cleaned: string[] = [];
  for (const raw of folded.split(/\s+/)) {
    let token = raw.replace(/[’'`]/g, "");
    const m = DOMAIN_NAME_RE.exec(token.toLowerCase());
    if (m?.[1] !== undefined) token = token.slice(0, m[1].length);
    token = token.replace(/\./g, "");
    for (const part of token.split(/[^\p{L}\p{N}]+/u)) {
      if (part !== "") cleaned.push(opts.keepCase ? part : part.toLowerCase());
    }
  }
  const kept: string[] = [];
  for (const w of cleaned) {
    const lower = w.toLowerCase();
    if (LEGAL_WORDS.has(lower)) continue;
    if (FILLER_WORDS.has(lower)) {
      if (lower === "the") continue;
      if (opts.keepFiller !== true && kept.length > 0) continue;
    }
    kept.push(w);
  }
  return kept.length > 0 ? kept : cleaned;
}

/**
 * The one company-name key: the words of `companyNameWords`, space-joined. Used for the company lookup, the ATS
 * index, name comparison, careers and slug code. Empty string if the name has no letters or digits.
 */
export function normalizeCompanyName(name: string): string {
  return companyNameWords(name).join(" ");
}
