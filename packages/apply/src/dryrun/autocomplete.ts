import type { DryRunFieldInput } from "../dry-runs-store.ts";
import type { FormField, PlanAnswer } from "../fill-plan.ts";

/** The answer key a location autocomplete (Greenhouse "Location (City)", Lever "Current location", Ashby "Location") is typed from. */
export const LOCATION_ANSWER_KEY = "contact.location";

/** Row notes of a location autocomplete that was not picked (fixed wording, never the typed text or a suggestion). */
export const AUTOCOMPLETE_NOTES = {
  noAnswer: "location autocomplete: no approved location answer",
  none: "location autocomplete: no suggestion matches the answer",
  several: "location autocomplete: several suggestions match the answer",
  notKept: "location autocomplete: the page did not keep the suggestion",
  refused: "location autocomplete: the page refused the input",
} as const;

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Indexes of the suggestions that match the answer: case-insensitive, every word of the answer is a word of the
 * suggestion. An answer without any word matches nothing.
 */
export function matchingSuggestions(answer: string, suggestions: readonly string[]): number[] {
  const want = words(answer);
  if (want.length === 0) return [];
  const hits: number[] = [];
  suggestions.forEach((s, i) => {
    const have = new Set(words(s));
    if (want.every((w) => have.has(w))) hits.push(i);
  });
  return hits;
}

/** Words of a text joined by single spaces: case, punctuation and extra spaces ignored. */
const normalized = (text: string): string => words(text).join(" ");

/** The leading city part (before the first comma), normalized. */
const cityPart = (text: string): string => normalized(text.split(",")[0] ?? "");

/**
 * The suggestion to pick among those matching the answer (`matchingSuggestions`): the only one, else the only one whose
 * whole text equals the answer, else the only one whose leading city part equals the answer's city. `none` when nothing
 * matches, `several` when the tie cannot be broken (the owner decides then).
 */
export function chooseSuggestion(
  answer: string,
  suggestions: readonly string[],
): { index: number } | { reason: "none" | "several" } {
  const hits = matchingSuggestions(answer, suggestions);
  if (hits.length === 0) return { reason: "none" };
  const only = (keep: (text: string) => boolean): number | undefined => {
    const kept = hits.filter((i) => keep(suggestions[i] as string));
    return kept.length === 1 ? kept[0] : undefined;
  };
  const index =
    hits.length === 1
      ? hits[0]
      : (only((s) => normalized(s) === normalized(answer)) ??
        only((s) => cityPart(s) !== "" && cityPart(s) === cityPart(answer)));
  return index === undefined ? { reason: "several" } : { index };
}

/** The approved location answer, or null (a missing, unapproved or empty one needs the owner). */
export function approvedLocation(answers: readonly PlanAnswer[]): string | null {
  const a = answers.find((x) => x.key === LOCATION_ANSWER_KEY && x.approved);
  const text = a?.answer.trim() ?? "";
  return text === "" ? null : text;
}

export type SuggestionResult =
  { picked: true; text: string } | { picked: false; reason: keyof typeof AUTOCOMPLETE_NOTES };

/** The field-table row of a location autocomplete: the picked suggestion (source `autocomplete`), or why it stays open. */
export function autocompleteRow(
  field: Pick<FormField, "label" | "field_type" | "required">,
  result: SuggestionResult,
): DryRunFieldInput {
  const base = {
    label: field.label,
    field_type: field.field_type,
    required: field.required,
    answer_key: LOCATION_ANSWER_KEY,
  };
  return result.picked
    ? { ...base, source: "autocomplete", value: result.text, filled: true, note: null }
    : {
        ...base,
        source: "none",
        value: null,
        filled: false,
        note: AUTOCOMPLETE_NOTES[result.reason],
      };
}
