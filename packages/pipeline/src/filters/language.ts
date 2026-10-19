import {
  LANGUAGE_MARKET_NOUNS,
  LANGUAGE_NAMES,
  LANGUAGE_NEGATION_PATTERNS,
  LANGUAGE_NEGATION_PHRASES,
  LANGUAGE_NATIVE_REQUIREMENT_PATTERNS,
  LANGUAGE_OPTIONAL_PHRASES,
  LANGUAGE_TITLE_PHRASES,
  LANGUAGE_TITLE_SPEAKING_TERMS,
  LANGUAGE_TITLE_TERMS,
} from "./keywords.ts";
import { foreignDescriptionLanguage } from "./description-language.ts";
import { compoundPattern, phrasePattern } from "./phrases.ts";

export type LanguageClass = "ok" | "reject";

export type LanguageInput = {
  title: string;
  descriptionText?: string | null;
};

export type LanguageResult = { class: LanguageClass; reason: string };

const LANG = `(${LANGUAGE_NAMES.join("|")})`;
const NOT_WORD_BEFORE = "(?<![\\p{L}\\p{N}])";
const NOT_WORD_AFTER = "(?![\\p{L}\\p{N}])";

function re(body: string): RegExp {
  return new RegExp(`${NOT_WORD_BEFORE}${body}${NOT_WORD_AFTER}`, "iu");
}

/** English and Indonesian never reject, but may precede the other language in a list ("fluent English and German"). */
const KNOWN = "(?:English|Indonesian|Bahasa(?:\\s+Indonesia)?)";
const KNOWN_LIST = `(?:${KNOWN}\\s*(?:,|and|&|/|or)\\s*)?`;

/** "English or German", "German / English", "English, French or German": English is offered as an alternative, so the list is not a requirement. */
const ITEM = `(?:${KNOWN}|${LANG})`;
const ALTERNATIVES = new RegExp(
  `${NOT_WORD_BEFORE}${ITEM}(?:\\s*(?:,|/|or)\\s*${ITEM})+${NOT_WORD_AFTER}`,
  "giu",
);
const KNOWN_ITEM = re(KNOWN);

function withoutAlternatives(clause: string): string {
  return clause.replace(ALTERNATIVES, (list) =>
    KNOWN_ITEM.test(list) && /\/|(?<![\p{L}])or(?![\p{L}])/iu.test(list) ? " " : list,
  );
}

const TITLE_SPEAKING = re(`${LANG}[\\s-]*(?:speaking|speaker)`);

const DESCRIPTION_PATTERNS: RegExp[] = [
  re(`fluen(?:t|cy)(?:\\s+in)?\\s+${KNOWN_LIST}${LANG}`),
  re(`native\\s+${LANG}(?:\\s+speaker)?`),
  re(`${LANG}\\s*[(:,-]?\\s*(?:c1|c2|native|business\\s+fluent|fluent)`),
  re(`business\\s+fluent\\s+${LANG}`),
  re(
    `(?:excellent|very\\s+good|strong|good)\\s+${LANG}\\s+(?:language\\s+)?(?:skills|communication)`,
  ),
  re(`${LANG}\\s+speaker(?!s?\\s+(?:${LANGUAGE_MARKET_NOUNS.join("|")})${NOT_WORD_AFTER})`),
  re(`(?:must|need\\s+to|have\\s+to|able\\s+to)\\s+speak\\s+(?:fluent\\s+)?${LANG}`),
  ...LANGUAGE_NATIVE_REQUIREMENT_PATTERNS.map(re),
];

/** Sentences and clauses; the "optional" wording only protects the clause it sits in. */
function clauses(text: string): string[] {
  return text
    .split(/[.!?\n\r;•]+|\s+but\s+|\s+while\s+|,\s+(?=(?:English|Indonesian|Bahasa)\b)/i)
    .map((c) => c.trim())
    .filter((c) => c !== "");
}

/** Lower case without accents, so "pas nécessaire" and "pas necessaire" are the same. */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

function matchesPhrase(phrases: readonly string[], clause: string): boolean {
  const folded = fold(clause);
  return phrases.some((p) => phrasePattern(p).test(clause) || phrasePattern(fold(p)).test(folded));
}

const NEGATION_PATTERNS = LANGUAGE_NEGATION_PATTERNS.map((p) => re(p));

function isNegation(clause: string): boolean {
  return (
    matchesPhrase(LANGUAGE_NEGATION_PHRASES, clause) ||
    NEGATION_PATTERNS.some((p) => p.test(clause) || p.test(fold(clause)))
  );
}

const SOFT_PHRASES = LANGUAGE_OPTIONAL_PHRASES.filter(
  (p) => !LANGUAGE_NEGATION_PHRASES.includes(p),
);

function isOptional(clause: string): boolean {
  return isNegation(clause) || matchesPhrase(LANGUAGE_OPTIONAL_PHRASES, clause);
}

/** Spelling variants (English, German, French) of each language; the key is the English name. */
const LANGUAGE_ALIASES: Record<string, string> = {
  german: "german|deutsch",
  french: "french|franz[oö]sisch|francais",
  dutch: "dutch|niederl[aä]ndisch|nederlands",
  spanish: "spanish|spanisch|espanol",
  portuguese: "portuguese|portugiesisch",
  italian: "italian|italienisch",
  polish: "polish|polnisch",
};
const LANGUAGE_IDS = LANGUAGE_NAMES.map((name) => {
  const key = name.toLowerCase();
  return { key, pattern: new RegExp(`(?<![\\p{L}])(?:${LANGUAGE_ALIASES[key] ?? key})`, "iu") };
});

/** The languages a piece of text names (by English name). */
function languagesIn(text: string): Set<string> {
  const folded = fold(text);
  return new Set(LANGUAGE_IDS.filter((l) => l.pattern.test(folded)).map((l) => l.key));
}

const LANGUAGE_GLOBAL_PATTERNS = LANGUAGE_IDS.map((l) => new RegExp(l.pattern.source, "giu"));

/** A segment that is only a list of languages ("Fluent German", "French"), with no wording of its own. */
function isLanguageList(segment: string): boolean {
  let rest = fold(segment);
  for (const p of LANGUAGE_GLOBAL_PATTERNS) rest = rest.replace(p, " ");
  rest = rest.replace(/\b(?:fluent|native|good|basic|knowledge|skills?|in|of|the|a)\b/g, " ");
  return !/\p{L}/u.test(rest) && languagesIn(segment).size > 0;
}

/** A negation that has no subject of its own ("is not needed", "isn't required"): it speaks of what came before. */
const BARE_CONTINUATION =
  /^\s*(?:(?:is|are|was|were|isn't|aren't|not|it|this|that|they|these|those)\b)/i;

/**
 * Languages a paragraph says are not needed: a negation names the languages in its own segment (plus a list of
 * bare language names right before it, "German, French are not required"). A negation that names none and is a bare
 * continuation ("Fluent German helps, but is not needed") takes the language of the segment before it; one about
 * something else ("a car is not required") protects nothing.
 */
function protectedLanguages(paragraph: string): Set<string> {
  const out = new Set<string>();
  for (const sentence of paragraph.split(/[.!?;]+/)) {
    let previous: string | undefined;
    for (const clause of clauses(sentence)) {
      const segments = clause.split(/\s*(?:,|&|\band\b|\bor\b)\s*/i).filter((x) => x.trim() !== "");
      segments.forEach((seg, i) => {
        if (isNegation(seg)) {
          const own = languagesIn(seg);
          if (own.size > 0) {
            for (const l of own) out.add(l);
            for (let j = i - 1; j >= 0 && isLanguageList(segments[j] ?? ""); j--) {
              for (const l of languagesIn(segments[j] ?? "")) out.add(l);
            }
          } else if (BARE_CONTINUATION.test(seg)) {
            const before = i > 0 ? segments[i - 1] : previous;
            if (before !== undefined) for (const l of languagesIn(before)) out.add(l);
          }
        }
        previous = seg;
      });
    }
  }
  return out;
}

function titleWord(title: string): string | undefined {
  return (
    LANGUAGE_TITLE_TERMS.find((t) => compoundPattern(t).test(title)) ??
    LANGUAGE_TITLE_PHRASES.find((p) => phrasePattern(p).test(title))
  );
}

/**
 * Rejects postings that need a language other than English or Indonesian: a German/French title, a
 * description mainly written in another language, or a language requirement in the title or description. A gender marker such as "(m/w/d)" is not a signal.
 * Wording that makes the language optional ("a plus", "nice to have") keeps the posting.
 */
export function classifyLanguage(input: LanguageInput): LanguageResult {
  const title = input.title;

  const word = titleWord(title);
  if (word !== undefined) {
    return { class: "reject", reason: `title written in German or French ("${word}")` };
  }
  const speaking = LANGUAGE_TITLE_SPEAKING_TERMS.find((t) => compoundPattern(t).test(title));
  if (speaking !== undefined) {
    return { class: "reject", reason: `title asks for a language ("${speaking}")` };
  }
  for (const clause of clauses(title)) {
    const m = TITLE_SPEAKING.exec(clause);
    if (m !== null && !isOptional(clause)) {
      return { class: "reject", reason: `title asks for a language ("${m[0]}")` };
    }
  }

  const written = foreignDescriptionLanguage(input.descriptionText);
  if (written !== null) {
    return { class: "reject", reason: `description written in ${written}` };
  }

  for (const paragraph of (input.descriptionText ?? "").split(/[\n\r•]+/)) {
    const safe = protectedLanguages(paragraph);
    for (const clause of clauses(paragraph)) {
      const negated = isNegation(clause);
      if (matchesPhrase(SOFT_PHRASES, clause)) continue;
      const text = withoutAlternatives(clause);
      for (const pattern of DESCRIPTION_PATTERNS) {
        const m = pattern.exec(text);
        if (m === null) continue;
        const named = languagesIn(m[0]);
        if (negated && named.size === 0) continue;
        if (named.size > 0 && [...named].every((l) => safe.has(l))) continue;
        return { class: "reject", reason: `description requires a language ("${m[0]}")` };
      }
    }
  }
  return { class: "ok", reason: "no language other than English or Indonesian required" };
}
