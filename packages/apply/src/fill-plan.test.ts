import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { mappingId } from "./choice-coverage.ts";
import {
  MAX_RESUME_BYTES,
  planFill,
  probeResumeFile,
  salaryNumber,
  salaryText,
  splitName,
  type FillInput,
  type FormField,
  type PlanAnswer,
  type PlannedField,
  type TierAsk,
} from "./fill-plan.ts";

// Fake persona only.
const RESUME = "/fake/jane-doe-resume.pdf";
const ok = () => ({ ok: true as const });

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

const BANK: PlanAnswer[] = [
  ans("contact.full_name", "Jane Q Doe"),
  ans("contact.email", "jane.doe@example.test"),
  ans("contact.phone", "+1 555 0100 123"),
  ans("contact.linkedin", "https://www.example.test/in/jane-doe"),
  ans("contact.portfolio", "https://jane-doe.example.test"),
  ans("contact.location", "Springfield"),
  ans("profile.resume_file", RESUME),
  ans("work_setup.remote_only", "Yes", {
    type: "yes_no",
    question: "Are you comfortable working remotely?",
  }),
  ans("work_setup.notice_period", "30", { type: "number", question: "Notice period in days" }),
  ans("misc.open_to_crypto_web3", "I like the product.", {
    question: "Why do you want to work here?",
  }),
  ans("experience.current_role", "TypeScript", {
    question: "Which stack do you use most?",
    type: "choice",
    choices: ["TypeScript"],
  }),
  ans("experience.years_nodejs_backend", "Git", { question: "Which tools do you use?" }),
];

const ASK: TierAsk = { askIdrMonth: 30_000_000, askUsdYear: 24_000, askText: null };

let n = 0;
const field = (label: string, field_type = "text", extra: Partial<FormField> = {}): FormField => ({
  label,
  field_type,
  required: false,
  options: null,
  ats: { type: "greenhouse", id: `f${++n}` },
  ...extra,
});

const plan = (fields: FormField[], over: Partial<FillInput> = {}) =>
  planFill({
    fields,
    answers: BANK,
    choiceMappings: new Map(),
    ask: ASK,
    scamFlagged: false,
    probeResume: ok,
    ...over,
  });

function fillOf(p: ReturnType<typeof plan>): PlannedField[] {
  if (p.kind !== "fill") throw new Error(`expected fill, got stop ${p.reason}`);
  return p.fields;
}

describe("full fill", () => {
  it("fills every field with its value and source", () => {
    const tools = ["Git", "Docker", "Kubernetes"];
    const mappings = new Map([
      [
        mappingId("experience.years_nodejs_backend", "Which tools do you use?", tools),
        ["Git", "Docker"],
      ],
    ]);
    const p = plan(
      [
        field("First name"),
        field("Last name"),
        field("Email *"),
        field("Phone"),
        field("LinkedIn Profile"),
        field("Website"),
        field("Location (City)"),
        field("Resume/CV", "file"),
        field("Are you comfortable working remotely?", "yes_no", { options: ["No", "Yes"] }),
        field("Notice period in days", "number"),
        field("Why do you want to work here?", "long_text"),
        field("Which tools do you use?", "multi_choice", { options: tools }),
        field("Expected salary (USD per year)", "number"),
        field("Salary expectations", "long_text"),
      ],
      { choiceMappings: mappings },
    );
    expect(p).toMatchObject({ kind: "fill", status: "filled", needsInputReason: null });
    const rows = fillOf(p).map((f) =>
      f.filled
        ? [f.field.label, f.value, f.source, f.answerKey]
        : [f.field.label, "UNFILLED", f.detail],
    );
    expect(rows).toEqual([
      ["First name", "Jane", "standard", "contact.full_name"],
      ["Last name", "Q Doe", "standard", "contact.full_name"],
      ["Email *", "jane.doe@example.test", "standard", "contact.email"],
      ["Phone", "+1 555 0100 123", "standard", "contact.phone"],
      ["LinkedIn Profile", "https://www.example.test/in/jane-doe", "standard", "contact.linkedin"],
      ["Website", "https://jane-doe.example.test", "standard", "contact.portfolio"],
      ["Location (City)", "Springfield", "standard", "contact.location"],
      ["Resume/CV", RESUME, "resume", "profile.resume_file"],
      ["Are you comfortable working remotely?", "Yes", "answer", "work_setup.remote_only"],
      ["Notice period in days", "30", "answer", "work_setup.notice_period"],
      [
        "Why do you want to work here?",
        "I like the product.",
        "answer",
        "misc.open_to_crypto_web3",
      ],
      [
        "Which tools do you use?",
        ["Git", "Docker"],
        "choice_mapping",
        "experience.years_nodejs_backend",
      ],
      ["Expected salary (USD per year)", "24000", "tier_ask", null],
      ["Salary expectations", "24000 USD per year (30000000 IDR per month)", "tier_ask", null],
    ]);
  });

  it("is deterministic and keeps form order", () => {
    const fields = [field("Email"), field("Phone")];
    expect(plan(fields)).toEqual(plan(fields));
    expect(fillOf(plan(fields)).map((f) => f.field.label)).toEqual(["Email", "Phone"]);
  });

  it("a single-choice field gets exactly the form's option text", () => {
    const options = ["typescript", "Go"];
    const p = plan([field("Which stack do you use most?", "choice", { options })], {
      choiceMappings: new Map([
        [
          mappingId("experience.current_role", "Which stack do you use most?", options),
          ["TypeScript"],
        ],
      ]),
    });
    expect(fillOf(p)[0]).toMatchObject({
      filled: true,
      value: "typescript",
      source: "choice_mapping",
    });
  });
});

describe("needs input (partial plan)", () => {
  it("an uncovered field, required or optional, stays empty and the rest is filled", () => {
    const p = plan([
      field("Email", "text", { required: true }),
      field("Favourite colour", "text", { required: true }),
      field("Tell us about a hobby", "long_text"),
    ]);
    expect(p).toMatchObject({
      kind: "fill",
      status: "needs_input",
      needsInputReason: "uncovered_question",
    });
    const f = fillOf(p);
    expect(f[0]).toMatchObject({ filled: true, value: "jane.doe@example.test" });
    expect(f[1]).toMatchObject({ filled: false, reason: "uncovered_question", inbox: true });
    expect(f[2]).toMatchObject({ filled: false, reason: "uncovered_question", inbox: true });
  });

  it("an unapproved answer covers nothing", () => {
    const answers = BANK.map((a) =>
      a.key === "misc.open_to_crypto_web3" ? { ...a, approved: false } : a,
    );
    const f = fillOf(plan([field("Why do you want to work here?", "long_text")], { answers }));
    expect(f[0]).toMatchObject({ filled: false, reason: "uncovered_question", inbox: true });
  });

  it("an unapproved profile answer is missing, and is not an inbox item", () => {
    const answers = BANK.map((a) => (a.key === "contact.email" ? { ...a, approved: false } : a));
    const f = fillOf(plan([field("Email")], { answers }));
    expect(f[0]).toMatchObject({ filled: false, answerKey: "contact.email", inbox: false });
  });

  it("a choice field with no approved mapping is choice_unmapped", () => {
    const p = plan([
      field("Which tools do you use?", "multi_choice", { options: ["Git", "Docker"] }),
    ]);
    expect(p).toMatchObject({
      kind: "fill",
      status: "needs_input",
      needsInputReason: "choice_unmapped",
    });
    expect(fillOf(p)[0]).toMatchObject({
      filled: false,
      reason: "choice_unmapped",
      answerKey: "experience.years_nodejs_backend",
    });
  });

  it("a mapping for another option set does not cover the field", () => {
    const p = plan(
      [field("Which tools do you use?", "multi_choice", { options: ["Git", "Docker"] })],
      {
        choiceMappings: new Map([
          [
            mappingId("experience.years_nodejs_backend", "Which tools do you use?", ["Git", "Hg"]),
            ["Git"],
          ],
        ]),
      },
    );
    expect(fillOf(p)[0]).toMatchObject({ filled: false, reason: "choice_unmapped" });
  });

  it("a mapping that does not fit the options, or two picks for a single choice, is not used", () => {
    const options = ["TypeScript", "Go"];
    const id = mappingId("experience.current_role", "Which stack do you use most?", options);
    for (const chosen of [["Rust"], ["TypeScript", "Go"], []]) {
      const p = plan([field("Which stack do you use most?", "choice", { options })], {
        choiceMappings: new Map([[id, chosen]]),
      });
      expect(fillOf(p)[0]).toMatchObject({ filled: false, reason: "uncovered_question" });
    }
  });

  it("a choice field with no matching answer is uncovered, not unmapped", () => {
    const f = fillOf(plan([field("Favourite fruit", "choice", { options: ["Apple", "Pear"] })]));
    expect(f[0]).toMatchObject({ filled: false, reason: "uncovered_question", inbox: true });
  });

  it("mixed reasons report uncovered_question", () => {
    const p = plan([
      field("Which tools do you use?", "multi_choice", { options: ["Git"] }),
      field("Favourite colour"),
    ]);
    expect(p).toMatchObject({ status: "needs_input", needsInputReason: "uncovered_question" });
  });

  it("an answer that fails typed validation for the field is not filled", () => {
    const answers = [
      ans("work_setup.remote_only", "maybe", { question: "Remote ok?" }),
      ans("work_setup.notice_period", "thirty", { question: "Notice days" }),
    ];
    const f = fillOf(
      plan([field("Remote ok?", "yes_no"), field("Notice days", "number")], { answers }),
    );
    expect(f.map((x) => x.filled)).toEqual([false, false]);
  });

  it("a bad standard value is not filled (email, phone, url)", () => {
    const answers = [
      ans("contact.email", "not-an-email"),
      ans("contact.phone", "12"),
      ans("contact.linkedin", "linkedin.example.test/in/x"),
    ];
    const f = fillOf(plan([field("Email"), field("Phone"), field("LinkedIn")], { answers }));
    expect(f.map((x) => x.filled)).toEqual([false, false, false]);
  });

  it("a single-word name has no last name", () => {
    const answers = [ans("contact.full_name", "Jane")];
    const f = fillOf(plan([field("First name"), field("Last name")], { answers }));
    expect(f.map((x) => x.filled)).toEqual([true, false]);
  });

  it("a standard field of the wrong kind or a stray file field needs input", () => {
    const f = fillOf(
      plan([
        field("Email", "choice", { options: ["a"] }),
        field("Resume/CV", "text"),
        field("Portfolio sample", "file"),
        field("Why do you want to work here?", "file"),
      ]),
    );
    expect(f.map((x) => x.filled)).toEqual([false, false, false, false]);
  });
});

describe("salary", () => {
  it("never takes a bank answer", () => {
    const answers = [
      ...BANK,
      ans("pay.expected", "999", { question: "Expected salary", type: "number" }),
    ];
    const f = fillOf(plan([field("Expected salary", "number")], { answers }));
    expect(f[0]).toMatchObject({
      filled: true,
      value: "24000",
      source: "tier_ask",
      answerKey: null,
    });
  });

  it.each([
    ["Expected salary (USD per year)", "24000"],
    ["Annual salary expectation", "24000"],
    ["Expected salary", "24000"],
    ["Expected monthly salary (USD)", "2000"],
    ["Expected salary (IDR)", "30000000"],
    ["Gaji bulanan yang diharapkan (Rupiah)", "30000000"],
    ["Expected yearly salary in IDR", "360000000"],
  ])("number field %s -> %s", (label, value) => {
    expect(fillOf(plan([field(label, "number")]))[0]).toMatchObject({
      filled: true,
      value,
      source: "tier_ask",
    });
  });

  it("USD monthly rounds up so it never drops below the yearly ask", () => {
    const r = salaryNumber("Monthly salary USD", {
      askIdrMonth: 1,
      askUsdYear: 24_001,
      askText: null,
    });
    expect(r).toEqual({ ok: true, value: "2001" });
  });

  it.each([
    ["Expected salary in EUR"],
    ["Expected salary (MYR)"],
    ["Expected salary (JPY)"],
    ["Expected salary (myr)"],
    ["Expected salary (Myr)"],
    ["Salary in Singapore dollars"],
    ["Salary in Swiss francs"],
    ["Salary in Philippine pesos"],
    ["Salary in rupees"],
    ["Expected salary (€)"],
    ["Expected salary (£)"],
    ["Expected salary (¥)"],
    ["Expected salary (IDR/USD)"],
    ["Expected salary in USD or Rupiah"],
    ["Hourly rate"],
    ["Expected monthly or yearly salary"],
  ])("number field %s needs input", (label) => {
    expect(fillOf(plan([field(label, "number")]))[0]).toMatchObject({
      filled: false,
      reason: "uncovered_question",
    });
  });

  it("a text field gets the ask text, else both figures", () => {
    const withText: TierAsk = { ...ASK, askText: "Negotiable, around 30M IDR per month" };
    expect(fillOf(plan([field("Salary expectations")], { ask: withText }))[0]).toMatchObject({
      value: "Negotiable, around 30M IDR per month",
      source: "tier_ask",
    });
    expect(salaryText(ASK)).toBe("24000 USD per year (30000000 IDR per month)");
    expect(salaryText({ askIdrMonth: 5, askUsdYear: null, askText: null })).toBe("5 IDR per month");
    expect(salaryText(null)).toBeNull();
  });

  it("no ask -> needs input 'salary: no ask', for number and text", () => {
    for (const ask of [null, { askIdrMonth: null, askUsdYear: null, askText: null }]) {
      const f = fillOf(
        plan([field("Expected salary", "number"), field("Salary expectations")], { ask }),
      );
      for (const x of f)
        expect(x).toMatchObject({
          filled: false,
          reason: "uncovered_question",
          detail: "salary: no ask",
          inbox: false,
        });
    }
  });

  it("a salary choice / yes-no field is not filled", () => {
    const f = fillOf(plan([field("Salary range", "choice", { options: ["a", "b"] })]));
    expect(f[0]).toMatchObject({ filled: false, reason: "uncovered_question" });
  });
});

describe("resume", () => {
  const dir = mkdtempSync(join(tmpdir(), "fill-plan-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const make = (name: string, body: Buffer | string) => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };

  it("accepts a real PDF under 10 MB", () => {
    expect(probeResumeFile(make("a.pdf", "%PDF-1.4 fake"))).toEqual({ ok: true });
  });

  it.each([
    ["missing file", () => join(dir, "missing.pdf")],
    ["not a pdf header", () => make("b.pdf", "hello world")],
    ["wrong extension", () => make("c.txt", "%PDF-1.4")],
    ["empty", () => make("d.pdf", "")],
    [
      "too big",
      () => make("e.pdf", Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(MAX_RESUME_BYTES)])),
    ],
    ["relative path", () => "resume.pdf"],
    ["a directory", () => dir + ".pdf"],
  ])("rejects %s", (_name, path) => {
    expect(probeResumeFile(path()).ok).toBe(false);
  });

  it("the plan uses the probe: a bad resume needs input, a good one is filled with the path only", () => {
    const bad = plan([field("Resume/CV", "file")], {
      probeResume: () => ({ ok: false, detail: "resume file does not exist" }),
    });
    expect(fillOf(bad)[0]).toMatchObject({
      filled: false,
      reason: "uncovered_question",
      detail: "resume file does not exist",
    });
    const real = make("good.pdf", "%PDF-1.7");
    const good = plan([field("Resume/CV", "file")], {
      answers: [ans("profile.resume_file", real)],
      probeResume: probeResumeFile,
    });
    expect(fillOf(good)[0]).toMatchObject({ filled: true, value: real, source: "resume" });
  });

  it("a missing profile.resume_file needs input", () => {
    const answers = BANK.filter((a) => a.key !== "profile.resume_file");
    expect(fillOf(plan([field("Resume/CV", "file")], { answers }))[0]).toMatchObject({
      filled: false,
      answerKey: "profile.resume_file",
    });
  });
});

describe("full stops", () => {
  it.each(["date", "location_autocomplete", "signature", "other", ""])(
    "unsupported field type %j stops with unexpected_field and the labels",
    (type) => {
      const p = plan([field("Email"), field("Start date", type), field("Sign here", type)]);
      expect(p).toEqual({
        kind: "stop",
        reason: "unexpected_field",
        details: ["Start date", "Sign here"],
      });
    },
  );

  it("a stopping field with a DOM shape carries its label, type and shape in the detail", () => {
    const f = { ...field("Mobile phone", "other"), dom: "input:tel+input:tel" };
    expect(plan([field("Email"), f])).toEqual({
      kind: "stop",
      reason: "unexpected_field",
      details: ["Mobile phone (other, input:tel+input:tel)"],
    });
  });

  it("a scam-flagged posting is never planned", () => {
    expect(plan([field("Email")], { scamFlagged: true })).toEqual({
      kind: "stop",
      reason: "other",
      details: ["scam flagged"],
    });
  });

  it("a field that matches two approved answers stops, naming the label", () => {
    const answers = [
      ...BANK,
      ans("a.one", "x", { question: "Preferred tooling", alternatives: ["Dev setup"] }),
      ans("b.two", "y", { question: "Dev setup" }),
    ];
    expect(plan([field("Email"), field("Dev setup?", "text")], { answers })).toEqual({
      kind: "stop",
      reason: "other",
      details: ["ambiguous match", "Dev setup? (a.one, b.two)"],
    });
  });

  it("one key reached by the standard route, the bank question and an alternative fills", () => {
    const answers = [
      ...BANK.filter((a) => a.key !== "contact.email"),
      ans("contact.email", "jane.doe@example.test", {
        question: "Email",
        alternatives: ["E-mail address", "Email address"],
      }),
    ];
    const p = plan([field("Email"), field("Email address"), field("E-mail address")], { answers });
    expect(p).toMatchObject({ kind: "fill", status: "filled" });
  });

  it("the owner's five contact labels, each also carried by a second key, stop naming both keys", () => {
    const labels = ["Full name", "Email", "Phone", "Current location", "LinkedIn URL"];
    const std = [
      "contact.full_name",
      "contact.email",
      "contact.phone",
      "contact.location",
      "contact.linkedin",
    ];
    const twins = labels.map((l, i) => ans(`contact.f${i}`, "x", { question: l }));
    const r = plan(
      labels.map((l) => field(l)),
      { answers: [...BANK, ...twins] },
    );
    expect(r).toEqual({
      kind: "stop",
      reason: "other",
      details: [
        "ambiguous match",
        ...labels.map((l, i) => `${l} (${[`contact.f${i}`, std[i]].sort().join(", ")})`),
      ],
    });
  });

  it("a standard key with no approved answer is not a candidate: the other key alone fills", () => {
    const answers = [
      ...BANK.filter((a) => a.key !== "contact.email"),
      ans("contact.github", "other@example.test", { question: "Email address" }),
    ];
    // contact.email is absent from the bank: no phantom "contact.email" in the ambiguity list.
    const r = plan([field("Email address")], { answers });
    expect(r).not.toMatchObject({ kind: "stop", details: ["ambiguous match"] });
    expect(JSON.stringify(r)).not.toContain("ambiguous");
  });

  it("a bank shaped like the real one (contact.* + profile.resume_file) fills the five contact fields", () => {
    const real = [
      ans("contact.full_name", "Jane Q Doe"),
      ans("contact.email", "jane.doe@example.test"),
      ans("contact.phone", "+1 555 0100 123"),
      ans("contact.linkedin", "https://www.example.test/in/jane-doe"),
      ans("contact.location", "Springfield"),
      ans("profile.resume_file", RESUME),
    ];
    const p = plan(
      [
        field("Full name"),
        field("Email"),
        field("Phone"),
        field("LinkedIn URL"),
        field("Current location"),
      ],
      { answers: real },
    );
    expect(p).toMatchObject({ kind: "fill", status: "filled" });
    expect(fillOf(p).map((f) => (f.filled ? f.answerKey : null))).toEqual([
      "contact.full_name",
      "contact.email",
      "contact.phone",
      "contact.linkedin",
      "contact.location",
    ]);
  });

  it("two wordings of one answer are not ambiguous", () => {
    const answers = [
      ...BANK,
      ans("a.one", "x", { question: "Dev setup", alternatives: ["Dev setup?"] }),
    ];
    expect(plan([field("Dev setup")], { answers })).toMatchObject({
      kind: "fill",
      status: "filled",
    });
  });

  it("a standard wording also carried by another answer is ambiguous; an unapproved twin is not", () => {
    const twin = ans("contact.github", "other@example.test", { question: "Email address" });
    expect(plan([field("Email address")], { answers: [...BANK, twin] })).toMatchObject({
      kind: "stop",
      details: ["ambiguous match", "Email address (contact.email, contact.github)"],
    });
    expect(
      plan([field("Email address")], { answers: [...BANK, { ...twin, approved: false }] }),
    ).toMatchObject({
      kind: "fill",
      status: "filled",
    });
  });

  it("scam and unexpected type win over everything else", () => {
    expect(plan([field("Date", "date")], { scamFlagged: true })).toMatchObject({ reason: "other" });
  });
});

describe("helpers", () => {
  it("splitName", () => {
    expect(splitName(" Jane  Q Doe ", "full")).toBe("Jane Q Doe");
    expect(splitName("Jane Q Doe", "first")).toBe("Jane");
    expect(splitName("Jane Q Doe", "last")).toBe("Q Doe");
    expect(splitName("Jane", "last")).toBeNull();
    expect(splitName("  ", "full")).toBeNull();
  });
});
