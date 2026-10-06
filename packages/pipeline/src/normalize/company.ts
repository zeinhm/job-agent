const LEGAL_SUFFIXES = new Set([
  "inc",
  "llc",
  "ltd",
  "gmbh",
  "pte",
  "bv",
  "sa",
  "ag",
  "corp",
  "co",
  "limited",
  "pty",
]);

/** Comparable company key: lowercase, no punctuation, no trailing legal suffixes. Empty string if nothing is left. */
export function normalizeCompanyName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[.'’`]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = cleaned.split(" ").filter(Boolean);
  while (LEGAL_SUFFIXES.has(tokens.at(-1) ?? "")) tokens.pop();
  // A name made only of suffixes ("Co") keeps its cleaned form.
  return tokens.length > 0 ? tokens.join(" ") : cleaned;
}
