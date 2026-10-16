import { choice_mappings, type Db } from "@job-agent/core";
import { eq } from "drizzle-orm";
import { optionsHash } from "./dry-runs-store.ts";
import { normalizeQuestion } from "./match.ts";

/** Question types whose answer is one or more of the form's own options. */
export const CHOICE_QUESTION_TYPES: readonly string[] = ["choice", "multi_choice"];

/** The form's options of a choice / multi-choice question, exactly as stored; null for any other question. */
export function choiceOptions(type: string, options: string | null): string[] | null {
  if (!CHOICE_QUESTION_TYPES.includes(type) || options === null) return null;
  try {
    const v: unknown = JSON.parse(options);
    if (!Array.isArray(v)) return null;
    const list = v.filter((x): x is string => typeof x === "string");
    return list.length > 0 ? list : null;
  } catch {
    return null;
  }
}

const idOf = (answerKey: string, normalizedLabel: string, hash: string) =>
  JSON.stringify([answerKey, normalizedLabel, hash]);

/** Identity of the mapping a choice question needs (answer key, normalized wording, option-set hash). */
export function mappingId(answerKey: string, label: string, options: string[]): string {
  return idOf(answerKey, normalizeQuestion(label), optionsHash(options));
}

/** Ids of every approved mapping; a choice question is covered only when its id is in here. */
export function approvedMappingIds(db: Pick<Db, "select">): Set<string> {
  return new Set(approvedMappings(db).keys());
}

/** Approved mappings by id (see `mappingId`) -> the option texts the owner picked. */
export function approvedMappings(db: Pick<Db, "select">): Map<string, string[]> {
  return new Map(
    db
      .select()
      .from(choice_mappings)
      .where(eq(choice_mappings.approved, true))
      .all()
      .map((m) => [idOf(m.answer_key, m.normalized_label, m.options_hash), parseChosen(m.chosen)]),
  );
}

function parseChosen(text: string): string[] {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
