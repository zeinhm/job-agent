import {
  LANGUAGE_NAMES,
  LANGUAGE_NATIVE_REQUIREMENT_PATTERNS,
  LANGUAGE_OPTIONAL_PHRASES,
  LANGUAGE_TITLE_PHRASES,
  LANGUAGE_TITLE_SPEAKING_TERMS,
  LANGUAGE_TITLE_TERMS,
} from "./keywords.ts";
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
  re(`${LANG}\\s+speaker`),
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

function isOptional(clause: string): boolean {
  return LANGUAGE_OPTIONAL_PHRASES.some((p) => phrasePattern(p).test(clause));
}

function titleWord(title: string): string | undefined {
  return (
    LANGUAGE_TITLE_TERMS.find((t) => compoundPattern(t).test(title)) ??
    LANGUAGE_TITLE_PHRASES.find((p) => phrasePattern(p).test(title))
  );
}

/**
 * Rejects postings that need a language other than English or Indonesian: a German/French title, or a
 * language requirement in the title or description. A gender marker such as "(m/w/d)" is not a signal.
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

  for (const clause of clauses(input.descriptionText ?? "")) {
    if (isOptional(clause)) continue;
    const text = withoutAlternatives(clause);
    for (const pattern of DESCRIPTION_PATTERNS) {
      const m = pattern.exec(text);
      if (m !== null) {
        return { class: "reject", reason: `description requires a language ("${m[0]}")` };
      }
    }
  }
  return { class: "ok", reason: "no language other than English or Indonesian required" };
}
