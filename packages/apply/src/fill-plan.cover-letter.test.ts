import { describe, expect, it } from "vitest";
import {
  COVER_LETTER_TEXT_KEY,
  planFill,
  renderCoverLetter,
  type FillInput,
  type FormField,
  type PlanAnswer,
  type PlannedField,
} from "./fill-plan.ts";

// Fake persona only. t_8ff8aff5: cover letter text with {company} / {role}, and the contractor note.
const ans = (key: string, answer: string, extra: Partial<PlanAnswer> = {}): PlanAnswer => ({
  key,
  question: null,
  alternatives: null,
  answer,
  type: null,
  choices: null,
  approved: true,
  ...extra,
});

let n = 0;
const field = (
  label: string,
  field_type = "long_text",
  extra: Partial<FormField> = {},
): FormField => ({
  label,
  field_type,
  required: false,
  options: null,
  ats: { type: "greenhouse", id: `c${++n}` },
  ...extra,
});

const TEXT = "Dear {company} team, I want the {role} role at {company}.";
const POSTING = { company: "Acme Labs", title: "Staff Engineer" };

const plan = (fields: FormField[], over: Partial<FillInput> = {}) =>
  planFill({
    fields,
    answers: [],
    choiceMappings: new Map(),
    ask: null,
    scamFlagged: false,
    posting: POSTING,
    ...over,
  });

const first = (p: ReturnType<typeof plan>): PlannedField => {
  if (p.kind !== "fill") throw new Error("expected a fill plan");
  return p.fields[0] as PlannedField;
};

describe("renderCoverLetter", () => {
  it("replaces every {company} and {role}", () => {
    expect(renderCoverLetter(TEXT, POSTING)).toEqual({
      ok: true,
      text: "Dear Acme Labs team, I want the Staff Engineer role at Acme Labs.",
    });
  });

  it("replaces once: a name that looks like a placeholder or a `$&` pattern is kept as written", () => {
    expect(renderCoverLetter("{company} / {role}", { company: "{role}", title: "$& Dev" })).toEqual(
      {
        ok: true,
        text: "{role} / $& Dev",
      },
    );
  });

  it("collapses whitespace in the names and leaves a text without placeholders alone", () => {
    expect(renderCoverLetter("At {company}", { company: " Acme \n Labs ", title: null })).toEqual({
      ok: true,
      text: "At Acme Labs",
    });
    expect(renderCoverLetter("Plain.", null)).toEqual({ ok: true, text: "Plain." });
  });
});

describe("a cover letter text field", () => {
  it("is filled from misc.cover_letter_text with source answer", () => {
    const p = plan([field("Cover letter")], { answers: [ans(COVER_LETTER_TEXT_KEY, TEXT)] });
    expect(first(p)).toMatchObject({
      filled: true,
      source: "answer",
      answerKey: "misc.cover_letter_text",
      value: "Dear Acme Labs team, I want the Staff Engineer role at Acme Labs.",
    });
  });

  it("a plain text field takes it too", () => {
    const p = plan([field("Cover Letter *", "text")], {
      answers: [ans(COVER_LETTER_TEXT_KEY, TEXT)],
    });
    expect(first(p)).toMatchObject({ filled: true });
  });

  it.each([
    ["an unknown placeholder", "Hello {name}", POSTING, "unknown placeholder"],
    ["a placeholder in another case", "Hello {Company}", POSTING, "unknown placeholder"],
    ["a placeholder with spaces", "Hello { company }", POSTING, "unknown placeholder"],
    ["an object-member name", "Hello {constructor}", POSTING, "unknown placeholder"],
    ["no company", "Hello {company}", { company: "", title: "Dev" }, "company name"],
    ["a blank title", "As {role}", { company: "Acme", title: "  " }, "title"],
    ["no posting at all", "As {role}", null, "title"],
  ])("%s -> needs input and the field stays empty", (_name, text, posting, detail) => {
    const p = plan([field("Cover letter")], {
      answers: [ans(COVER_LETTER_TEXT_KEY, text)],
      posting,
    });
    const f = first(p);
    expect(f.filled).toBe(false);
    if (!f.filled) {
      expect(f.detail).toContain(detail);
      expect(f.answerKey).toBe("misc.cover_letter_text");
      expect(f.detail).not.toContain(text);
    }
    if (p.kind === "fill") expect(p.status).toBe("needs_input");
  });

  it("a text without placeholders needs no posting names", () => {
    const p = plan([field("Cover letter")], {
      answers: [ans(COVER_LETTER_TEXT_KEY, "Plain letter.")],
      posting: null,
    });
    expect(first(p)).toMatchObject({ filled: true, value: "Plain letter." });
  });

  it("a missing or unapproved cover letter text covers nothing", () => {
    expect(first(plan([field("Cover letter")]))).toMatchObject({
      filled: false,
      answerKey: "misc.cover_letter_text",
    });
    const unapproved = plan([field("Cover letter")], {
      answers: [ans(COVER_LETTER_TEXT_KEY, TEXT, { approved: false })],
    });
    expect(first(unapproved)).toMatchObject({ filled: false });
  });

  it("a cover letter FILE field stays needs_input even with an approved text", () => {
    const p = plan([field("Cover letter", "file")], {
      answers: [ans(COVER_LETTER_TEXT_KEY, TEXT)],
    });
    expect(first(p)).toMatchObject({ filled: false, source: "none" });
  });
});

describe("an additional information field", () => {
  const note = ans("misc.contractor_note", "Contractor, invoices monthly.");

  it.each([
    "Additional information",
    "Additional Info",
    "Anything else?",
    "Anything else you'd like us to know",
  ])("%s is filled from misc.contractor_note as written", (label) => {
    const p = plan([field(label)], { answers: [note] });
    expect(first(p)).toMatchObject({
      filled: true,
      source: "answer",
      answerKey: "misc.contractor_note",
      value: "Contractor, invoices monthly.",
    });
  });

  it("is not run through the cover letter replacement", () => {
    const p = plan([field("Additional information")], {
      answers: [ans("misc.contractor_note", "Note for {company}.")],
    });
    expect(first(p)).toMatchObject({ value: "Note for {company}." });
  });

  it("without an approved note, or as a choice field, needs input", () => {
    expect(first(plan([field("Additional information")]))).toMatchObject({
      filled: false,
      answerKey: "misc.contractor_note",
    });
    const choice = plan([field("Additional information", "choice", { options: ["a", "b"] })], {
      answers: [note],
    });
    expect(first(choice)).toMatchObject({ filled: false });
  });
});
