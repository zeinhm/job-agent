import { CASE_SENSITIVE_PHRASES } from "./keywords.ts";

const patternCache = new Map<string, RegExp>();

/** Word-boundary pattern for a keyword phrase; case-insensitive unless the phrase is in CASE_SENSITIVE_PHRASES. */
export function phrasePattern(phrase: string): RegExp {
  let re = patternCache.get(phrase);
  if (!re) {
    const body = phrase
      .trim()
      .split(/\s+/)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");
    const flags = CASE_SENSITIVE_PHRASES.includes(phrase) ? "u" : "ui";
    re = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, flags);
    patternCache.set(phrase, re);
  }
  return re;
}

const compoundCache = new Map<string, RegExp>();

/** Like phrasePattern, but the term may sit inside a German compound word ("Finanzbuchhalterin", "Vertriebsleiter", "IT-Berater"). */
export function compoundPattern(term: string): RegExp {
  let re = compoundCache.get(term);
  if (!re) {
    re = new RegExp(
      `(?<![\\p{L}\\p{N}])\\p{L}*${term.trim().toLowerCase()}\\p{L}*(?![\\p{L}\\p{N}])`,
      "ui",
    );
    compoundCache.set(term, re);
  }
  return re;
}
