import {
  ROLE_ENGINEER_NOUNS,
  ROLE_GENERIC_TITLES,
  ROLE_JUNIOR_PHRASES,
  ROLE_LEADERSHIP_PHRASES,
  ROLE_NON_ENGINEERING_DOMAIN_PHRASES,
  ROLE_NON_ENGINEERING_PHRASES,
  ROLE_OUT_OF_TARGET_PHRASES,
  ROLE_SENIORITY_WORDS,
  ROLE_TARGET_EXCLUDED_PHRASES,
  ROLE_TARGET_PHRASES,
} from "./keywords.ts";
import { phrasePattern } from "./phrases.ts";

export type RoleClass = "keep" | "reject" | "unclear";

export type RoleInput = {
  title: string;
  descriptionText?: string | null;
};

export type RoleResult = { class: RoleClass; reason: string };

function findPhrase(text: string, phrases: readonly string[]): string | undefined {
  return phrases.find((phrase) => phrasePattern(phrase).test(text));
}

/** The title without parentheticals, "- Remote" style tails and seniority words, for exact generic-title matching. */
function bareTitle(title: string): string {
  let text = title.toLowerCase().replace(/\([^)]*\)/g, " ");
  for (const word of ROLE_SENIORITY_WORDS) text = text.replace(phrasePattern(word), " ");
  return text
    .replace(/[^\p{L}\p{N}+#. ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Role relevance from the title. Order: junior wording rejects; mobile frameworks and non-engineering titles reject;
 * a target skill keeps; out-of-target roles reject; leadership keeps; everything else (generic or unknown titles) is unclear.
 * The description only adds a hint to the reason of a generic title, it never changes the class.
 */
export function classifyRole(input: RoleInput): RoleResult {
  const title = input.title;

  const junior = findPhrase(title, ROLE_JUNIOR_PHRASES);
  if (junior !== undefined)
    return { class: "reject", reason: `junior or intern role ("${junior}")` };

  const mobileFramework = findPhrase(title, ROLE_TARGET_EXCLUDED_PHRASES);
  if (mobileFramework !== undefined) {
    return { class: "reject", reason: `mobile framework role ("${mobileFramework}")` };
  }
  const nonEngineering = findPhrase(title, ROLE_NON_ENGINEERING_PHRASES);
  if (nonEngineering !== undefined) {
    return { class: "reject", reason: `non-engineering role ("${nonEngineering}")` };
  }
  const domain = findPhrase(title, ROLE_NON_ENGINEERING_DOMAIN_PHRASES);
  if (domain !== undefined && findPhrase(title, ROLE_ENGINEER_NOUNS) === undefined) {
    return { class: "reject", reason: `non-engineering role ("${domain}")` };
  }

  const target = findPhrase(title, ROLE_TARGET_PHRASES);
  if (target !== undefined) return { class: "keep", reason: `target role ("${target}")` };

  const outOfTarget = findPhrase(title, ROLE_OUT_OF_TARGET_PHRASES);
  if (outOfTarget !== undefined) {
    return { class: "reject", reason: `engineering role outside the target ("${outOfTarget}")` };
  }

  const leadership = findPhrase(title, ROLE_LEADERSHIP_PHRASES);
  if (leadership !== undefined)
    return { class: "keep", reason: `engineering leadership ("${leadership}")` };

  const bare = bareTitle(title);
  if (ROLE_GENERIC_TITLES.includes(bare)) {
    const hint = findPhrase(input.descriptionText ?? "", ROLE_TARGET_PHRASES);
    return {
      class: "unclear",
      reason:
        `generic engineering title without a skill ("${bare}")` +
        (hint !== undefined ? `; description mentions "${hint}"` : ""),
    };
  }
  return { class: "unclear", reason: "title matches no target or non-target role" };
}
