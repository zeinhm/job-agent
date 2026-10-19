import { describe, expect, it } from "vitest";
import {
  buildAnswerIndex,
  matchedKeyOf,
  matchQuestion,
  normalizeQuestion,
  type BankWording,
} from "./match.ts";

const bank: BankWording[] = [
  {
    key: "work_setup.notice_period",
    question: "What is your notice period?",
    alternatives: ["When can you start?", "Earliest start date"],
    approved: true,
  },
  {
    key: "work_setup.work_authorization",
    question: "Are you legally authorized to work in this country?",
    alternatives: null,
    approved: true,
  },
  {
    key: "misc.open_to_crypto_web3",
    question: "What are your pronouns?",
    alternatives: ["Preferred pronouns"],
    approved: false,
  },
  {
    key: "work_setup.willing_to_relocate",
    question: "Are you willing to relocate?",
    alternatives: null,
    approved: true,
  },
  // A bank entry worded like a salary question must never be used.
  {
    key: "money.expectation",
    question: "What are your salary expectations?",
    alternatives: null,
    approved: true,
  },
];
const index = buildAnswerIndex(bank);
const keyFor = (label: string): string | null =>
  matchedKeyOf(matchQuestion(normalizeQuestion(label), index));

describe("normalizeQuestion", () => {
  it.each([
    ["What is your notice period?", "what is your notice period"],
    ["  WHAT  is your\tnotice period ?? ", "what is your notice period"],
    ["Email address *", "email address"],
    ["First name*", "first name"],
    ["LinkedIn Profile (URL):", "linkedin profile url"],
    ["Résumé / CV", "résumé cv"],
    ["Why do you want to join us?!", "why do you want to join us"],
    ["***", ""],
  ])("%j -> %j", (input, expected) => {
    expect(normalizeQuestion(input)).toBe(expected);
  });

  it("is idempotent", () => {
    const once = normalizeQuestion("  Are you OK with 3-day onsite weeks? *");
    expect(normalizeQuestion(once)).toBe(once);
  });
});

describe("matchQuestion golden table", () => {
  // [wording, expected matched key]
  const table: [string, string | null][] = [
    // answer bank: canonical, alternatives, case, punctuation, markers
    ["What is your notice period?", "work_setup.notice_period"],
    ["what is your notice period", "work_setup.notice_period"],
    ["WHAT IS YOUR NOTICE PERIOD?", "work_setup.notice_period"],
    ["What is your notice period? *", "work_setup.notice_period"],
    ["What is your notice period??", "work_setup.notice_period"],
    ["  What   is your   notice period  ", "work_setup.notice_period"],
    ["What is your notice period.", "work_setup.notice_period"],
    ["When can you start?", "work_setup.notice_period"],
    ["when can you start *", "work_setup.notice_period"],
    ["Earliest start date", "work_setup.notice_period"],
    ["Earliest start date:", "work_setup.notice_period"],
    ["Are you legally authorized to work in this country?", "work_setup.work_authorization"],
    ["Are you legally authorized to work in this country? *", "work_setup.work_authorization"],
    ["Are you willing to relocate?", "work_setup.willing_to_relocate"],
    ["Are you willing to relocate", "work_setup.willing_to_relocate"],
    // standard ATS fields
    ["First Name", "standard.name"],
    ["Last name *", "standard.name"],
    ["Full name", "standard.name"],
    ["Name", "standard.name"],
    ["Email", "standard.email"],
    ["Email address *", "standard.email"],
    ["E-mail", "standard.email"],
    ["Phone", "standard.phone"],
    ["Phone number", "standard.phone"],
    ["Mobile phone *", "standard.phone"],
    ["Resume", "standard.resume"],
    ["Resume/CV", "standard.resume"],
    ["Upload your resume *", "standard.resume"],
    ["CV", "standard.resume"],
    ["Cover letter", "standard.cover_letter"],
    ["Cover Letter *", "standard.cover_letter"],
    ["Additional information", "standard.additional_info"],
    ["Anything else?", "standard.additional_info"],
    ["LinkedIn", "standard.linkedin"],
    ["LinkedIn Profile", "standard.linkedin"],
    ["LinkedIn URL *", "standard.linkedin"],
    ["Your LinkedIn profile", "standard.linkedin"],
    // salary: always `salary`, never an answer-bank key (even when the bank has an approved salary answer)
    ["What are your salary expectations?", "salary"],
    ["Salary expectations *", "salary"],
    ["Expected salary (USD)", "salary"],
    ["What is your expected monthly salary?", "salary"],
    ["Desired compensation", "salary"],
    ["What are your pay expectations?", "salary"],
    ["Hourly rate", "salary"],
    ["Current salary", "salary"],
    // unapproved answer does not cover
    ["What are your pronouns?", null],
    ["Preferred pronouns", null],
    // near-misses that must NOT match
    ["What is your notice period for your current employer and your manager?", null],
    ["Notice period", null],
    ["Why do you want to work here?", null],
    ["Are you willing to relocate to Singapore?", null],
    ["Are you legally authorized to work in the United States?", null],
    ["Name of your current employer", null],
    ["Phone interview availability", null],
    ["Do you have a cover letter template?", null],
    ["Email preferences", null],
    ["LinkedIn recommendations", null],
    ["Resume parsing consent", null],
    ["What is your start date preference and visa status?", null],
    ["", null],
  ];

  it("has at least 40 wordings", () => {
    expect(table.length).toBeGreaterThanOrEqual(40);
  });

  it.each(table)("%j -> %j", (label, expected) => {
    expect(keyFor(label)).toBe(expected);
  });

  it("never returns an answer-bank key for a salary question", () => {
    // The index itself refuses to hold a salary wording, so the bank cannot cover it even if matching changes.
    expect(index.get(normalizeQuestion("What are your salary expectations?"))).toBeUndefined();
    expect(matchQuestion(normalizeQuestion("What are your salary expectations?"), index)).toEqual({
      kind: "salary",
    });
  });
});

describe("buildAnswerIndex", () => {
  it("skips unapproved answers and gives a shared wording to the first key", () => {
    const i = buildAnswerIndex([
      { key: "b.y", question: "Same?", alternatives: null, approved: true },
      { key: "a.x", question: "Same?", alternatives: null, approved: true },
      { key: "c.z", question: "Hidden?", alternatives: ["Other"], approved: false },
    ]);
    expect(i.get("same")).toBe("a.x");
    expect(i.has("hidden")).toBe(false);
    expect(i.has("other")).toBe(false);
  });
});
