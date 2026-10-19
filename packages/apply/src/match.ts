/** Pure question matching (phase-4 conventions section 7). No fuzzy or LLM matching. */

/** Case, punctuation, whitespace, trailing "?" and "*" do not matter; letters and digits of any script are kept. */
export function normalizeQuestion(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

import { isSalaryWording } from "./salary.ts";

export const STANDARD_FIELDS = [
  "name",
  "email",
  "phone",
  "resume",
  "cover_letter",
  "linkedin",
  "website",
  "location",
  "additional_info",
] as const;
export type StandardField = (typeof STANDARD_FIELDS)[number];

/** Exact normalized wordings of the fields every ATS form asks; they are filled from the profile, not the bank. */
const STANDARD_WORDINGS: Record<StandardField, readonly string[]> = {
  name: [
    "name",
    "full name",
    "your name",
    "your full name",
    "first name",
    "last name",
    "surname",
    "family name",
    "given name",
    "legal name",
    "preferred name",
  ],
  email: ["email", "e mail", "email address", "your email", "your email address", "e mail address"],
  phone: [
    "phone",
    "phone number",
    "mobile",
    "mobile phone",
    "mobile number",
    "telephone",
    "contact number",
    "your phone number",
  ],
  resume: [
    "resume",
    "cv",
    "resume cv",
    "cv resume",
    "resume or cv",
    "upload your resume",
    "attach your resume",
    "upload resume",
    "curriculum vitae",
  ],
  cover_letter: ["cover letter", "your cover letter", "upload cover letter", "attach cover letter"],
  linkedin: [
    "linkedin",
    "linkedin url",
    "linkedin profile",
    "linkedin profile url",
    "linkedin profile link",
    "your linkedin profile",
    "your linkedin url",
  ],
  website: [
    "website",
    "your website",
    "personal website",
    "website url",
    "website link",
    "portfolio",
    "portfolio url",
    "portfolio link",
    "portfolio website",
  ],
  location: [
    "location",
    "your location",
    "current location",
    "location city",
    "city",
    "current city",
    "city of residence",
  ],
  additional_info: [
    "additional information",
    "additional info",
    "anything else",
    "anything else we should know",
    "anything else you would like us to know",
    "anything else you would like to add",
    "anything else you would like to share",
    "anything else you d like us to know",
    "anything else you d like to add",
    "anything else you d like to share",
  ],
};

const STANDARD = new Map<string, StandardField>(
  STANDARD_FIELDS.flatMap((f) => STANDARD_WORDINGS[f].map((w) => [w, f] as const)),
);

export type QuestionMatch =
  { kind: "salary" } | { kind: "standard"; field: StandardField } | { kind: "answer"; key: string };

export interface BankWording {
  key: string;
  question: string | null;
  alternatives: string[] | null;
  approved: boolean;
}

/** normalized wording -> answer key, from approved answers only; a salary wording is never indexed. The first key (sorted) wins a shared wording. */
export type AnswerIndex = ReadonlyMap<string, string>;

export function buildAnswerIndex(bank: readonly BankWording[]): AnswerIndex {
  const index = new Map<string, string>();
  for (const e of [...bank].sort((a, b) => a.key.localeCompare(b.key))) {
    if (!e.approved) continue;
    for (const w of [e.question, ...(e.alternatives ?? [])]) {
      if (w === null || isSalaryWording(w)) continue;
      const n = normalizeQuestion(w);
      if (n !== "" && !index.has(n)) index.set(n, e.key);
    }
  }
  return index;
}

/** `normalized` is a `normalizeQuestion` result. Salary wins over standard fields, which win over the bank. */
export function matchQuestion(normalized: string, index: AnswerIndex): QuestionMatch | null {
  if (isSalaryWording(normalized)) return { kind: "salary" };
  const field = STANDARD.get(normalized);
  if (field !== undefined) return { kind: "standard", field };
  const key = index.get(normalized);
  return key === undefined ? null : { kind: "answer", key };
}

/** `posting_questions.matched_key` for a match: `salary`, `standard.<field>` or the answer-bank key. */
export function matchedKeyOf(m: QuestionMatch | null): string | null {
  if (m === null) return null;
  switch (m.kind) {
    case "salary":
      return "salary";
    case "standard":
      return `standard.${m.field}`;
    case "answer":
      return m.key;
  }
}
