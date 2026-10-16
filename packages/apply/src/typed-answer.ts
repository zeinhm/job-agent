import type { ANSWER_TYPES } from "@job-agent/core";

export type TypedAnswerRule =
  "yes_no" | "number" | "choice_member" | "choices_required" | "non_empty";

export type TypedAnswerCheck =
  { ok: true } | { ok: false; field: "answer" | "choices"; rule: TypedAnswerRule };

// Optional sign, digits with an optional fraction (or a bare fraction), optional exponent. No hex, no "Infinity",
// no thousands separators.
const NUMBER = /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;

/** Trim, collapse inner whitespace, lower-case: the compare form of a choice. */
const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The one rule set for a stored answer, used by every write path (import, POST/PATCH, approve, inbox).
 * - `yes_no`: `yes` or `no`, any case, surrounding whitespace ignored.
 * - `number`: a finite decimal number (see NUMBER above), whitespace trimmed.
 * - `choice`: `choices` is non-empty and the answer equals one of them after trim, whitespace collapse, lower-casing.
 * - `text`, `long_text`, or no type: not empty after trim.
 * Returns the failing field and rule only, never the value.
 */
export function validateTypedAnswer(input: {
  answer: string;
  type: (typeof ANSWER_TYPES)[number] | null | undefined;
  choices: string[] | null | undefined;
}): TypedAnswerCheck {
  const a = input.answer.trim();
  switch (input.type) {
    case "yes_no":
      return /^(yes|no)$/i.test(a) ? { ok: true } : { ok: false, field: "answer", rule: "yes_no" };
    case "number":
      return NUMBER.test(a) && Number.isFinite(Number(a))
        ? { ok: true }
        : { ok: false, field: "answer", rule: "number" };
    case "choice": {
      const choices = input.choices ?? [];
      if (choices.length === 0) return { ok: false, field: "choices", rule: "choices_required" };
      return choices.some((c) => norm(c) === norm(a))
        ? { ok: true }
        : { ok: false, field: "answer", rule: "choice_member" };
    }
    default:
      return a.length > 0 ? { ok: true } : { ok: false, field: "answer", rule: "non_empty" };
  }
}
