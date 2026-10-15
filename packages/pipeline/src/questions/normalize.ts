import { normalizeQuestion } from "@job-agent/apply";
import { decodeEntities } from "../apply-links/ats-links.ts";

/** Question text as plain text: markup removed, entities decoded, whitespace collapsed. */
export function plainText(raw: string): string {
  return decodeEntities(raw.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The key a question is matched on (phase-4 conventions section 7): case, punctuation, whitespace, trailing "?" and
 * "*" do not matter.
 */
export function normalizeLabel(label: string): string {
  return normalizeQuestion(plainText(label));
}
