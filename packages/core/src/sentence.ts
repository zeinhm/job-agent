/** Ends a sentence with a period unless the text already ends with `.`, `!`, `?` or `…`, optionally followed by closing quotes or brackets. */
export function endSentence(text: string): string {
  const t = text.trim();
  if (t === "") return t;
  return /[.!?…]["'”’)\]}»]*$/u.test(t) ? t : `${t}.`;
}
