import { normalizeQuestion } from "../match.ts";

/** Text as a page may hand it back: Unicode-normalised, whitespace runs collapsed to one space, trimmed, case folded. */
export const normalizeText = (s: string): string =>
  s.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();

/** Last path segment of a POSIX or Windows path (`C:\fakepath\cv.pdf` -> `cv.pdf`), case folded. */
export const fileNameOf = (s: string): string =>
  (s.trim().split(/[\\/]/u).pop() ?? "").normalize("NFC").trim().toLowerCase();

/**
 * Readback compare per control kind. Text: equal after `normalizeText`. File: equal by file name only (a page may read back
 * a path such as `C:\fakepath\<name>`). Choices: equal by `normalizeQuestion` label. A really different value is never equal.
 */
export function readbackEqual(
  kind: string,
  value: string | string[],
  got: readonly string[],
): boolean {
  const planned = Array.isArray(value) ? value : [value];
  if (kind === "text" || kind === "textarea")
    return (
      got.length === 1 &&
      planned.length === 1 &&
      normalizeText(got[0] ?? "") === normalizeText(planned[0] ?? "")
    );
  const norm = kind === "file" ? fileNameOf : normalizeQuestion;
  const want = planned.map(norm);
  const have = got.map(norm);
  return want.length === have.length && want.every((w) => have.includes(w));
}
