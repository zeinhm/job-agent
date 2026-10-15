import type { NotInterestedReason } from "./api.ts";

/** `x` then a number key: 1-9 are the first nine reasons, 0 is `expired`. `other` needs a note, so it has no key. */
export const REASON_KEYS: Readonly<Record<string, NotInterestedReason>> = {
  "1": "location",
  "2": "timezone",
  "3": "role",
  "4": "seniority",
  "5": "stack",
  "6": "salary",
  "7": "company",
  "8": "domestic_company",
  "9": "language",
  "0": "expired",
};

export const SHORTCUTS: readonly (readonly [keys: string, what: string])[] = [
  ["j / k", "next / previous posting"],
  ["o", "open the apply link in a new tab"],
  ["i", "interested"],
  ["a", "applied manually"],
  ["l", "later"],
  ["x, then 1-9 or 0", "not interested with that reason"],
  ["s", "scam"],
  ["u", "undo the last action (10 s)"],
  ["?", "show or hide this list"],
  ["Esc", "cancel x, close this list"],
];

/** True when the key event came from somewhere the user is typing. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return (
    target instanceof HTMLInputElement && !["checkbox", "radio", "button"].includes(target.type)
  );
}
