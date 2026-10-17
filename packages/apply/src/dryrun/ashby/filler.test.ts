import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  answer_bank,
  dry_run_fields,
  dry_runs,
  openDb,
  posting_questions,
  unknown_questions,
  type Db,
} from "@job-agent/core";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listMappingNeeds } from "../../choice-mapping.ts";
import { planFill, type PlannedField } from "../../fill-plan.ts";
import { questionCounts } from "../../match-questions.ts";
import type { PlanContext } from "../greenhouse/filler.ts";
import { dataDirOfDb } from "../output.ts";
import { ASHBY_READ_ONLY_OPERATIONS } from "../request-guard.ts";
import { HarnessRefusalError, type DryRunSession } from "../session.ts";
import { pageOf, resetRunLimit } from "../testing.ts";
import { describeComparison } from "../greenhouse/form.ts";
import { kept, phoneKept } from "../lever/filler.ts";
import { compareQuestions, fieldsFromControls, type LeverControl } from "../lever/form.ts";
import { loadStoredAshbyQuestions, runAshbyDryRun, type AshbyRunSummary } from "./filler.ts";
import { missingFromTable } from "./form.ts";
import {
  AI_OPTIONS,
  AI_QUESTION,
  ASHBY_FIXTURE_CAPTCHA_PATH,
  ASHBY_FIXTURE_CHANGED_PATH,
  ASHBY_FIXTURE_DATE_PATH,
  ASHBY_FIXTURE_FORM_PATH,
  ASHBY_FIXTURE_ORPHAN_PATH,
  ASHBY_FIXTURE_PHONE_FORMAT_PATH,
  ASHBY_FIXTURE_PHONE_PAIR_PATH,
  ASHBY_FIXTURE_POSTING_ID,
  ASHBY_FIXTURE_REALSHAPE_PATH,
  FAMILIAL_QUESTION,
  SPONSORSHIP_QUESTION,
  WORK_AUTH_QUESTION,
  ashbyFixtureContext,
  ashbyRealShapeContext,
  seedAshbyFixture,
  startAshbyFixtureServer,
  type AshbyFixtureServer,
} from "./fixture.ts";

const PATH = (n: string) => `4a1f0c52-7e1d-4b8a-9a31-0c2d5e6f7a${n}`;
const NAME = "_systemfield_name";
const EMAIL = "_systemfield_email";
const RESUME = "_systemfield_resume";
const PHONE = PATH("01");
const COMPANY = PATH("02");
const LINKEDIN = PATH("03");
const WHY = PATH("04");
const REMOTE = PATH("05");
const ZONE = PATH("06");
const TOOLS = PATH("07");
const STACK = PATH("08");
const REGIONS = PATH("09");
const SALARY = PATH("0a");
const GRAPHQL = "/api/non-user-graphql";

let server: AshbyFixtureServer;
let dir: string;
let db: Db;
let dataDir: string;

beforeAll(async () => {
  server = await startAshbyFixtureServer();
}, 60_000);
afterAll(async () => {
  await server?.close();
});
beforeEach(() => {
  resetRunLimit();
  server.requests.length = 0;
  server.graphql.length = 0;
  dir = mkdtempSync(join(tmpdir(), "ashby-filler-"));
  db = openDb(join(dir, "test.db"));
  dataDir = dataDirOfDb(join(dir, "test.db"));
  seedAshbyFixture(db);
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Seen {
  texts: Record<string, string>;
  selected: Record<string, string[]>;
  checked: Record<string, string[]>;
  files: string[];
  untouched: {
    consent: number;
    survey: number;
    autofill: number;
    phoneCountry: string;
    phoneTexting: number;
    textingQuestion: number;
  };
}

/** What the page really holds, read straight from the DOM (not through the filler's own read-back). */
async function readPage(session: DryRunSession): Promise<Seen> {
  return pageOf(session).evaluate<Seen>(`(() => {
    const form = document.querySelector(".ashby-application-form-container");
    const els = (name) => [...form.elements].filter((e) => e.getAttribute("name") === name);
    const text = (el) => el.textContent.replace(/\\s+/g, " ").trim();
    const val = (name) => els(name)[0].value;
    const sel = (name) => [...els(name)[0].selectedOptions].filter((o) => o.value !== "").map(text);
    const checked = (name) => els(name).filter((e) => e.checked).map((e) => text(e.closest("label")));
    return {
      texts: Object.fromEntries(
        [${[NAME, EMAIL, PHONE, COMPANY, LINKEDIN, WHY, SALARY].map((n) => JSON.stringify(n)).join(", ")}].map((n) => [n, val(n)]),
      ),
      selected: { [${JSON.stringify(ZONE)}]: sel(${JSON.stringify(ZONE)}), [${JSON.stringify(REGIONS)}]: sel(${JSON.stringify(REGIONS)}) },
      checked: {
        [${JSON.stringify(REMOTE)}]: checked(${JSON.stringify(REMOTE)}),
        [${JSON.stringify(TOOLS)}]: checked(${JSON.stringify(TOOLS)}),
        [${JSON.stringify(STACK)}]: checked(${JSON.stringify(STACK)}),
      },
      files: [...els(${JSON.stringify(RESUME)})[0].files].map((f) => f.name),
      untouched: {
        consent: els("_systemfield_texting_consent").filter((e) => e.checked).length,
        survey: [...document.querySelectorAll(".ashby-survey-container input")].filter((e) => e.checked).length,
        autofill: els("autofill-resume")[0].files.length,
        phoneCountry: els(${JSON.stringify(PHONE + "-country")})[0].value,
        phoneTexting: els(${JSON.stringify(PHONE + "-texting")}).filter((e) => e.checked).length,
        textingQuestion: els(${JSON.stringify(PATH("0b"))}).filter((e) => e.checked).length,
      },
    };
  })()`);
}

interface Out {
  summary: AshbyRunSummary;
  seen: Seen | null;
}

async function run(
  path: string = ASHBY_FIXTURE_FORM_PATH,
  over: { context?: (c: PlanContext) => PlanContext | undefined } = {},
): Promise<Out> {
  let seen: Seen | null = null;
  const base = ashbyFixtureContext(dataDir);
  const context = over.context ? over.context(base) : base;
  const summary = await runAshbyDryRun({
    db,
    dataDir,
    postingId: ASHBY_FIXTURE_POSTING_ID,
    url: `${server.origin}${path}`,
    fixture: true,
    ...(context !== undefined ? { context } : {}),
    beforeFinish: async (s) => {
      seen = await readPage(s);
    },
  });
  return { summary, seen };
}

const fieldsOf = (runId: string) =>
  db.select().from(dry_run_fields).where(eq(dry_run_fields.dry_run_id, runId)).all();
const runOf = (runId: string) => db.select().from(dry_runs).where(eq(dry_runs.id, runId)).get();
const storedRows = () =>
  db
    .select()
    .from(posting_questions)
    .where(eq(posting_questions.posting_id, ASHBY_FIXTURE_POSTING_ID))
    .all();

const without = (key: string) => (c: PlanContext) => ({
  ...c,
  answers: c.answers.filter((a) => a.key !== key),
});

describe("full fill on the fixture", () => {
  it("fills every covered field: the DOM equals the plan; the page's query reaches the server, no mutation does", async () => {
    const { summary, seen } = await run();
    expect(summary).toMatchObject({ status: "filled", stopReason: null, filled: 13, total: 13 });

    // The plan, computed separately from the questions the run stored, is what the page holds.
    const plan = planFill({
      fields: loadStoredAshbyQuestions(db, ASHBY_FIXTURE_POSTING_ID),
      ...ashbyFixtureContext(dataDir),
    });
    if (plan.kind !== "fill") throw new Error("expected a fill plan");
    const value = (id: string) =>
      (plan.fields.find((f) => f.field.ats.id === id) as Extract<PlannedField, { filled: true }>)
        .value;
    const s = seen as unknown as Seen;
    expect(s.texts).toEqual({
      [NAME]: value(NAME),
      [EMAIL]: value(EMAIL),
      [PHONE]: value(PHONE),
      [COMPANY]: value(COMPANY),
      [LINKEDIN]: value(LINKEDIN),
      [WHY]: value(WHY),
      [SALARY]: value(SALARY),
    });
    expect(s.texts[NAME]).toBe("Alex Example");
    expect(s.texts[COMPANY]).toBe("Example Corp");
    expect(s.texts[SALARY]).toBe("24000 USD per year (30000000 IDR per month)");
    expect(s.checked[REMOTE]).toEqual(["Yes"]);
    expect(s.selected[ZONE]).toEqual(["UTC+7 (Jakarta)"]);
    expect(s.checked[TOOLS]).toEqual(["Git", "Docker"]);
    expect(s.checked[STACK]).toEqual(["TypeScript"]);
    expect(s.selected[REGIONS]).toEqual(["Asia", "Europe"]);
    expect(s.files).toEqual(["fixture-resume.pdf"]);
    // Texting consent, the survey and the autofill drop zone are left alone.
    expect(s.untouched).toEqual({
      consent: 0,
      survey: 0,
      autofill: 0,
      phoneCountry: "ID",
      phoneTexting: 0,
      textingQuestion: 0,
    });
    // The phone field ("Phone Number", a country selector + tel input) takes contact.phone.
    expect(s.texts[PHONE]).not.toBe("");
    const phone = storedRows().find((q) => q.question_id === PHONE);
    expect(phone).toMatchObject({ label: "Phone Number", type: "text" });
    expect(storedRows().some((q) => q.question_id === PATH("0b"))).toBe(false);
  }, 90_000);

  it("the page sends the allowed query and the submit mutation; the server receives the query only", async () => {
    const { summary } = await run();
    expect(summary.status).toBe("filled");

    // The page asked for its form once, through the read-only query on the allowlist.
    expect(server.graphql).toEqual([{ op: "ApiJobPostingForApplicationRequest", kind: "query" }]);
    expect(ASHBY_READ_ONLY_OPERATIONS.has("ApiJobPostingForApplicationRequest")).toBe(true);
    // Zero non-allowlisted non-GET requests: the only non-GET the server saw is that query.
    expect(server.nonGet()).toEqual([
      { method: "POST", path: GRAPHQL, op: "ApiJobPostingForApplicationRequest" },
    ]);
    expect(server.requests.filter((r) => r.path === "/app.js")).toHaveLength(1);

    // What the page also tried, and the browser aborted before it left: the submit mutation, a mutation hidden under a
    // read-only operation name, the draft write of every filled field and the resume upload handle.
    expect(summary.aborted.length).toBeGreaterThanOrEqual(2 + 12 + 1);
    expect(
      summary.aborted.every(
        (a) => a.method === "POST" && a.host.startsWith("127.0.0.1") && a.path === GRAPHQL,
      ),
    ).toBe(true);
    expect(summary.aborted.every((a) => a.reason === "method")).toBe(true);
    expect(summary.attempts.map((a) => a.kind)).not.toContain("submit_event");
    expect(summary.attempts.map((a) => a.kind)).not.toContain("form_submit_call");
    expect(summary.attempts.map((a) => a.kind)).not.toContain("form_request_submit_call");
  }, 90_000);

  it("records the run, every field with filled true and where it came from, and a private screenshot", async () => {
    const { summary } = await run();
    const rows = fieldsOf(summary.runId);
    // 13 questions plus the 4 untouched blocks, listed as skipped (never filled, never counted).
    expect(rows).toHaveLength(17);
    const questions = rows.filter((r) => !r.note?.startsWith("skipped: "));
    expect(questions).toHaveLength(13);
    expect(questions.every((r) => r.filled && r.note === null)).toBe(true);
    expect(rows.filter((r) => r.note?.startsWith("skipped: ")).map((r) => r.label)).toEqual([
      "Phone Number: text message consent",
      "I agree to receive text messages about my application",
      "Can we send you text messages about your application?",
      "Gender",
    ]);
    const by = (label: string) => rows.find((r) => r.label === label);
    expect(by("Name")).toMatchObject({ source: "standard", answer_key: "contact.full_name" });
    expect(by("Resume")).toMatchObject({ source: "resume", value: "fixture-resume.pdf" });
    expect(by("Expected salary (USD per year)")).toMatchObject({
      source: "tier_ask",
      answer_key: null,
    });
    expect(by("Which tools do you use?")).toMatchObject({
      source: "choice_mapping",
      value: "Git; Docker",
    });
    expect(runOf(summary.runId)).toMatchObject({
      status: "filled",
      ats_type: "ashby",
      fixture: true,
      stop_reason: null,
    });

    const shot = join(dataDir, summary.screenshotPath);
    expect(existsSync(shot)).toBe(true);
    expect(statSync(shot).mode & 0o777).toBe(0o600);
    expect(statSync(join(shot, "..")).mode & 0o777).toBe(0o700);
  }, 90_000);
});

describe("questions read from the rendered page are stored and matched", () => {
  it("stores the page's fields as ashby posting_questions with options, never the survey / consent / autofill controls", async () => {
    await run();
    const rows = storedRows();
    expect(rows).toHaveLength(13);
    expect(rows.every((r) => r.ats_type === "ashby")).toBe(true);
    const by = (id: string) => rows.find((r) => r.question_id === id);
    expect(by(NAME)).toMatchObject({
      label: "Name",
      required: true,
      type: "text",
      options: null,
      matched_key: "standard.name",
    });
    expect(by(RESUME)).toMatchObject({ label: "Resume", type: "file", required: true });
    expect(by(LINKEDIN)).toMatchObject({ required: false, matched_key: "standard.linkedin" });
    expect(by(WHY)).toMatchObject({ type: "long_text", required: true, matched_key: null });
    expect(by(REMOTE)).toMatchObject({ type: "yes_no", options: JSON.stringify(["Yes", "No"]) });
    expect(by(ZONE)).toMatchObject({
      type: "choice",
      options: JSON.stringify(["UTC+7 (Jakarta)", "UTC+1 (Berlin)", "UTC-5 (New York)"]),
    });
    expect(by(TOOLS)).toMatchObject({ type: "multi_choice" });
    expect(by(STACK)).toMatchObject({ type: "choice" });
    expect(by(REGIONS)).toMatchObject({ type: "multi_choice" });
    expect(by(SALARY)).toMatchObject({ matched_key: "salary" });
    expect(
      rows.some((r) => /consent|survey|autofill/.test(r.question_id) || r.label === "Gender"),
    ).toBe(false);
  }, 90_000);

  it("a second run on the same page keeps the stored rows (same ids) and is not a change", async () => {
    await run();
    const before = storedRows()
      .map((r) => r.id)
      .sort();
    resetRunLimit();
    const second = await run();
    expect(second.summary.status).toBe("filled");
    expect(
      storedRows()
        .map((r) => r.id)
        .sort(),
    ).toEqual(before);
  }, 120_000);

  it("uncovered questions reach the Inbox and a choice question gets a mapping request (database answers, no override)", async () => {
    const T = "2026-10-13T00:00:00.000Z";
    const add = (key: string, question: string | null, answer: string) =>
      db
        .insert(answer_bank)
        .values({
          id: key,
          key,
          group: key.split(".")[0] ?? "g",
          question,
          answer,
          approved: true,
          source: "config",
          updated_at: T,
        })
        .run();
    add("contact.full_name", null, "Alex Example");
    add("experience.current_role", "Which stack do you use most?", "TypeScript");

    const { summary } = await run(ASHBY_FIXTURE_FORM_PATH, { context: () => undefined });
    expect(summary).toMatchObject({ status: "needs_input", stopReason: "uncovered_question" });

    const inbox = db.select().from(unknown_questions).all();
    expect(inbox.map((q) => q.normalized_label)).toEqual(
      expect.arrayContaining(["why do you want to work here", "which tools do you use"]),
    );
    expect(inbox.every((q) => q.status === "open")).toBe(true);
    expect(storedRows().find((q) => q.question_id === STACK)?.matched_key).toBe(
      "experience.current_role",
    );
    const need = listMappingNeeds(db).find((n) => n.answerKey === "experience.current_role");
    expect(need).toMatchObject({
      label: "Which stack do you use most?",
      options: ["TypeScript", "Go", "Python"],
      multi: false,
    });
    expect(
      questionCounts(db, [ASHBY_FIXTURE_POSTING_ID]).get(ASHBY_FIXTURE_POSTING_ID),
    ).toMatchObject({ total: 13, needsMapping: 1 });
  }, 90_000);
});

describe("needs_input (owner answer on gate t_2c20b3fa, question 4)", () => {
  it("an uncovered question stays empty, the rest is filled, the label goes to the Inbox", async () => {
    const { summary, seen } = await run(ASHBY_FIXTURE_FORM_PATH, {
      context: without("misc.open_to_crypto_web3"),
    });
    expect(summary).toMatchObject({
      status: "needs_input",
      stopReason: "uncovered_question",
      filled: 12,
      total: 13,
    });
    const s = seen as unknown as Seen;
    expect(s.texts[WHY]).toBe("");
    expect(s.texts[NAME]).toBe("Alex Example");
    const open = fieldsOf(summary.runId).filter(
      (r) => !r.filled && !r.note?.startsWith("skipped: "),
    );
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      label: "Why do you want to work here?",
      source: "none",
      value: null,
    });
    expect(
      db
        .select()
        .from(unknown_questions)
        .where(eq(unknown_questions.normalized_label, "why do you want to work here"))
        .get(),
    ).toMatchObject({ label: "Why do you want to work here?", status: "open" });
    expect(server.graphql.every((g) => g.kind === "query")).toBe(true);
  }, 90_000);

  it("an unmapped choice is left empty and the run is choice_unmapped", async () => {
    const { summary, seen } = await run(ASHBY_FIXTURE_FORM_PATH, {
      context: (c) => ({ ...c, choiceMappings: new Map() }),
    });
    expect(summary).toMatchObject({ status: "needs_input", stopReason: "choice_unmapped" });
    const s = seen as unknown as Seen;
    expect(s.selected[ZONE]).toEqual([]);
    expect(s.selected[REGIONS]).toEqual([]);
    expect(s.checked[TOOLS]).toEqual([]);
    expect(s.checked[STACK]).toEqual([]);
    expect(s.checked[REMOTE]).toEqual(["Yes"]); // yes / no needs no mapping
    expect(s.texts[EMAIL]).not.toBe("");
  }, 90_000);

  it("no tier ask: the salary field stays empty; a missing resume file leaves the upload empty", async () => {
    const { summary, seen } = await run(ASHBY_FIXTURE_FORM_PATH, {
      context: (c) => ({ ...c, ask: null }),
    });
    expect(summary).toMatchObject({ status: "needs_input", stopReason: "uncovered_question" });
    expect((seen as unknown as Seen).texts[SALARY]).toBe("");

    resetRunLimit();
    const missing = await run(ASHBY_FIXTURE_FORM_PATH, {
      context: (c) => ({
        ...c,
        answers: c.answers.map((a) =>
          a.key === "profile.resume_file" ? { ...a, answer: join(dir, "nope.pdf") } : a,
        ),
      }),
    });
    expect(missing.summary).toMatchObject({ status: "needs_input", filled: 12 });
    expect((missing.seen as unknown as Seen).files).toEqual([]);
  }, 120_000);

  it("a value the page does not keep is recorded as not filled with a note and no value", async () => {
    // The textarea holds 400 characters at most: a longer approved answer is cut by the page.
    const { summary } = await run(ASHBY_FIXTURE_FORM_PATH, {
      context: (c) => ({
        ...c,
        answers: c.answers.map((a) =>
          a.key === "misc.open_to_crypto_web3" ? { ...a, answer: "x".repeat(600) } : a,
        ),
      }),
    });
    expect(summary).toMatchObject({ status: "needs_input", filled: 12, total: 13 });
    const row = fieldsOf(summary.runId).find((r) => r.label === "Why do you want to work here?");
    expect(row).toMatchObject({ filled: false, value: null, source: "answer" });
    expect(row?.note).toMatch(/page (kept a different value|refused the value)/);
    expect(runOf(summary.runId)?.stop_detail).toBe("1 field(s) need input; the page refused 1");
  }, 90_000);
});

describe("stops (nothing is filled)", () => {
  async function stopped(out: Promise<Out>, reason: string): Promise<Out> {
    const r = await out;
    expect(r.summary).toMatchObject({ status: "stopped", stopReason: reason, filled: 0, total: 0 });
    expect(r.seen).toBeNull(); // never reached the filling step
    expect(fieldsOf(r.summary.runId)).toEqual([]);
    expect(existsSync(join(dataDir, r.summary.screenshotPath))).toBe(true);
    // Only the page's own read-only query reached the server, whatever the stop.
    expect(server.graphql.every((g) => g.kind === "query")).toBe(true);
    expect(server.nonGet().every((r2) => r2.path === GRAPHQL && r2.op !== undefined)).toBe(true);
    expect(server.nonGet().every((r2) => ASHBY_READ_ONLY_OPERATIONS.has(r2.op as string))).toBe(
      true,
    );
    return r;
  }

  it("a scam-flagged posting", async () => {
    const r = await stopped(
      run(ASHBY_FIXTURE_FORM_PATH, { context: (c) => ({ ...c, scamFlagged: true }) }),
      "other",
    );
    expect(runOf(r.summary.runId)?.stop_detail).toBe("scam flagged");
  }, 90_000);

  it("an unsupported field type", async () => {
    const r = await stopped(run(ASHBY_FIXTURE_DATE_PATH), "unexpected_field");
    expect(runOf(r.summary.runId)?.stop_detail).toBe("Available start date (other, input:date)");
    expect(storedRows().find((q) => q.label === "Available start date")).toMatchObject({
      type: "other",
    });
  }, 90_000);

  it("a phone field that is not understood stops with its label and DOM kinds, never a value", async () => {
    const r = await stopped(run(ASHBY_FIXTURE_PHONE_PAIR_PATH), "unexpected_field");
    expect(runOf(r.summary.runId)?.stop_detail).toBe("Mobile phone (other, input:tel+input:tel)");
  }, 90_000);

  it("a field that matches two answers", async () => {
    const r = await stopped(
      run(ASHBY_FIXTURE_FORM_PATH, {
        context: (c) => ({
          ...c,
          answers: [
            ...c.answers,
            {
              key: "contact.github",
              question: "Email",
              alternatives: null,
              answer: "other@example.test",
              type: null,
              choices: null,
              approved: true,
            },
          ],
        }),
      }),
      "other",
    );
    expect(runOf(r.summary.runId)?.stop_detail).toContain("ambiguous match");
  }, 90_000);

  it("the CAPTCHA page: nothing is read, nothing is stored", async () => {
    const r = await stopped(run(ASHBY_FIXTURE_CAPTCHA_PATH), "captcha");
    expect(runOf(r.summary.runId)?.stop_detail).toBe("visible captcha challenge on the page");
    expect(storedRows()).toEqual([]);
  }, 90_000);

  it("a page without the application form (not found)", async () => {
    const r = await run("/acme/nothing/application");
    expect(r.summary).toMatchObject({ status: "error", stopReason: "page_error", filled: 0 });
    expect(r.seen).toBeNull();
    expect(storedRows()).toEqual([]);
  }, 90_000);

  it("a changed form: the page differs from the last stored fields; labels of the changes, no values; then the new set is stored", async () => {
    const first = await run();
    expect(first.summary.status).toBe("filled");
    expect(storedRows()).toHaveLength(13);

    resetRunLimit();
    const r = await stopped(run(ASHBY_FIXTURE_CHANGED_PATH), "form_changed");
    const detail = runOf(r.summary.runId)?.stop_detail ?? "";
    expect(detail).toBe(
      "form changed (missing: Expected salary (USD per year); extra: Do you need visa sponsorship?; different: LinkedIn profile, Preferred time zone)",
    );
    expect(detail).not.toMatch(/Alex|example\.test/);

    // The changed set replaced the stored one (so its new question reaches the Inbox) and the next run on that page
    // is compared with it.
    const after = storedRows();
    expect(after.map((q) => q.question_id)).toContain("4a1f0c52-7e1d-4b8a-9a31-0c2d5e6f7b01");
    expect(after.map((q) => q.question_id)).not.toContain(SALARY);
    expect(
      db
        .select()
        .from(unknown_questions)
        .where(eq(unknown_questions.normalized_label, "do you need visa sponsorship"))
        .get(),
    ).toMatchObject({ status: "open" });
    resetRunLimit();
    const again = await runAshbyDryRun({
      db,
      dataDir,
      postingId: ASHBY_FIXTURE_POSTING_ID,
      url: `${server.origin}${ASHBY_FIXTURE_CHANGED_PATH}`,
      fixture: true,
      context: ashbyFixtureContext(dataDir),
    });
    expect(again.status).toBe("needs_input"); // the visa question has no answer yet
    expect(again.stopReason).toBe("uncovered_question");
  }, 180_000);

  it("a changed required flag alone is a change", async () => {
    await run();
    db.update(posting_questions)
      .set({ required: false })
      .where(
        and(
          eq(posting_questions.posting_id, ASHBY_FIXTURE_POSTING_ID),
          eq(posting_questions.question_id, EMAIL),
        ),
      )
      .run();
    resetRunLimit();
    const r = await stopped(run(), "form_changed");
    expect(runOf(r.summary.runId)?.stop_detail).toBe("form changed (different: Email)");
  }, 120_000);
});

describe("every question on the page reaches the table (t_c7d6e06d)", () => {
  const P = (n: string) => `4a1f0c52-7e1d-4b8a-9a31-0c2d5e6f7c${n}`;

  async function runReal(opts: { mapAi?: boolean } = {}) {
    let checked: Record<string, string[]> = {};
    let location = "";
    const summary = await runAshbyDryRun({
      db,
      dataDir,
      postingId: ASHBY_FIXTURE_POSTING_ID,
      url: `${server.origin}${ASHBY_FIXTURE_REALSHAPE_PATH}`,
      fixture: true,
      context: ashbyRealShapeContext(dataDir, opts),
      beforeFinish: async (s) => {
        const seen = await pageOf(s).evaluate<{
          checked: Record<string, string[]>;
          location: string;
        }>(`(() => {
          const text = (el) => el.textContent.replace(/\\s+/g, " ").trim();
          const checked = (name) =>
            [...document.querySelectorAll('input[name="' + name + '"]')]
              .filter((e) => e.checked)
              .map((e) => text(e.closest("label")));
          return {
            checked: Object.fromEntries(
              ${JSON.stringify([P("02"), P("03"), P("04"), P("05"), "survey-veteran", "survey-race"])}.map((n) => [n, checked(n)]),
            ),
            location: document.getElementById(${JSON.stringify(P("01"))}).value,
          };
        })()`);
        checked = seen.checked;
        location = seen.location;
      },
    });
    return { summary, checked, location };
  }

  it("lists radio groups, the combobox and the untouched blocks; radios are mapped, the combobox and the unanswered radio stay open", async () => {
    const { summary, checked, location } = await runReal();
    // Never a full fill while a combobox and an unanswered question are open.
    expect(summary).toMatchObject({ status: "needs_input", stopReason: "uncovered_question" });
    expect(summary).toMatchObject({ filled: 16, total: 18 });
    const rows = fieldsOf(summary.runId);
    const by = (label: string) => rows.find((r) => r.label === label);

    // Table = 18 questions + 6 skipped blocks (the base form's 4, plus veteran status and race).
    expect(rows.filter((r) => !r.note?.startsWith("skipped: "))).toHaveLength(18);
    expect(rows.filter((r) => r.note?.startsWith("skipped: ")).map((r) => r.label)).toEqual([
      "Phone Number: text message consent",
      "I agree to receive text messages about my application",
      "Can we send you text messages about your application?",
      "Gender",
      "Veteran status",
      "Race",
    ]);
    expect(by("Gender")).toMatchObject({ filled: false, source: "none", value: null });

    // Location: a combobox, listed, never typed into.
    expect(by("Location")).toMatchObject({
      field_type: "text",
      required: true,
      filled: false,
      source: "none",
      note: "combobox / autocomplete: the owner picks the suggestion",
    });
    expect(location).toBe("");

    // Radio groups go through the plan: yes/no from the bank, the 4-option group through its approved mapping.
    expect(by(AI_QUESTION)).toMatchObject({
      field_type: "choice",
      source: "choice_mapping",
      value: "I use AI tools daily",
      filled: true,
    });
    expect(by(WORK_AUTH_QUESTION)).toMatchObject({
      field_type: "yes_no",
      value: "No",
      filled: true,
    });
    expect(by(SPONSORSHIP_QUESTION)).toMatchObject({ field_type: "yes_no", value: "Yes" });
    expect(by(FAMILIAL_QUESTION)).toMatchObject({
      field_type: "yes_no",
      filled: false,
      source: "none",
    });
    expect(checked[P("02")]).toEqual(["I use AI tools daily"]);
    expect(checked[P("03")]).toEqual(["No"]);
    expect(checked[P("04")]).toEqual(["Yes"]);
    expect(checked[P("05")]).toEqual([]); // no answer: left empty
    // EEO and veteran blocks are untouched.
    expect(checked["survey-veteran"]).toEqual([]);
    expect(checked["survey-race"]).toEqual([]);

    // The stored table has the new questions with their types and options; skipped blocks are not stored.
    const stored = storedRows();
    expect(stored.find((q) => q.question_id === P("02"))).toMatchObject({
      type: "choice",
      options: JSON.stringify(AI_OPTIONS),
    });
    expect(stored.find((q) => q.question_id === P("03"))).toMatchObject({ type: "yes_no" });
    expect(stored.find((q) => q.question_id === P("01"))).toMatchObject({ label: "Location" });
    expect(stored.some((q) => q.label === "Race" || q.label === "Veteran status")).toBe(false);
    // The unanswered radio question reaches the Inbox.
    expect(
      db
        .select()
        .from(unknown_questions)
        .where(eq(unknown_questions.label, FAMILIAL_QUESTION))
        .get(),
    ).toMatchObject({ status: "open" });
    expect(server.graphql.every((g) => g.kind === "query")).toBe(true);
  }, 90_000);

  it("an unmapped radio group is left empty and listed as needing input", async () => {
    const { summary, checked } = await runReal({ mapAi: false });
    expect(summary.status).toBe("needs_input");
    expect(checked[P("02")]).toEqual([]);
    const row = fieldsOf(summary.runId).find((r) => r.label === AI_QUESTION);
    expect(row).toMatchObject({
      filled: false,
      source: "none",
      note: "no approved choice mapping",
    });
  }, 90_000);

  it("a second run on the same real-shape page is not a form change", async () => {
    await runReal();
    resetRunLimit();
    const second = await runReal();
    expect(second.summary.status).toBe("needs_input");
    expect(second.summary.stopReason).toBe("uncovered_question");
  }, 120_000);

  it("a question on the page that the table would not list stops the run form_changed, nothing is filled", async () => {
    const out = await run(ASHBY_FIXTURE_ORPHAN_PATH);
    expect(out.summary).toMatchObject({
      status: "stopped",
      stopReason: "form_changed",
      filled: 0,
      total: 0,
    });
    expect(out.seen).toBeNull();
    expect(fieldsOf(out.summary.runId)).toEqual([]);
    expect(runOf(out.summary.runId)?.stop_detail).toBe(
      "question(s) on the page missing from the field table: Do you need an accommodation?",
    );
    expect(storedRows()).toEqual([]);
  }, 90_000);

  it("missingFromTable compares titles seen with controls and skipped blocks, ignoring case and spacing", () => {
    const control = (label: string): LeverControl => ({
      name: label,
      kind: "text",
      label,
      required: false,
      options: null,
      optionValues: [],
    });
    expect(
      missingFromTable({
        controls: [control("Name"), control("Why  here?")],
        skipped: [{ label: "Race", reason: "x" }],
        seen: ["name", "Why here?", "RACE", "Pronouns", "Pronouns"],
      }),
    ).toEqual(["Pronouns"]);
  });
});

describe("phone readback by digits (t_73f3d2e8)", () => {
  const phoneRow = () => storedRows().find((q) => q.question_id === PHONE);
  const setPhoneRow = (patch: Partial<typeof posting_questions.$inferInsert>) =>
    db
      .update(posting_questions)
      .set(patch)
      .where(
        and(
          eq(posting_questions.posting_id, ASHBY_FIXTURE_POSTING_ID),
          eq(posting_questions.question_id, PHONE),
        ),
      )
      .run();

  it("a phone the page reformats on input is accepted: the run is filled like the plain fixture", async () => {
    const { summary, seen } = await run(ASHBY_FIXTURE_PHONE_FORMAT_PATH);
    expect(summary).toMatchObject({ status: "filled", stopReason: null, filled: 13, total: 13 });
    const plain = planFill({
      fields: loadStoredAshbyQuestions(db, ASHBY_FIXTURE_POSTING_ID),
      ...ashbyFixtureContext(dataDir),
    });
    if (plain.kind !== "fill") throw new Error("expected a fill plan");
    const typed = (
      plain.fields.find((f) => f.field.ats.id === PHONE) as Extract<PlannedField, { filled: true }>
    ).value as string;
    const shown = (seen as unknown as Seen).texts[PHONE] as string;
    // The page rewrote the value (so an exact compare could not pass) and kept every typed digit.
    expect(shown).not.toBe(typed);
    expect(shown.startsWith("+1 ")).toBe(true);
    expect(shown.replace(/\D/g, "").endsWith(typed.replace(/\D/g, ""))).toBe(true);
    expect(fieldsOf(summary.runId).find((r) => r.label === "Phone Number")).toMatchObject({
      filled: true,
      note: null,
      source: "standard",
      answer_key: "contact.phone",
    });
  }, 90_000);

  it("a stored phone row written by an older reader (other) is a reader change: no form_changed, the row is refreshed", async () => {
    await run();
    // What the run before the phone widget was understood stored: type other (and a different required reading).
    setPhoneRow({ type: "other", required: false });
    // The old comparison reported exactly this on the owner's run.
    const page = fieldsFromControls(
      [
        {
          name: PHONE,
          kind: "text",
          label: "Phone Number",
          required: true,
          options: null,
          optionValues: [],
        },
      ],
      "ashby",
    );
    const stored = loadStoredAshbyQuestions(db, ASHBY_FIXTURE_POSTING_ID).filter(
      (f) => f.ats.id === PHONE,
    );
    expect(describeComparison(compareQuestions(stored, page))).toBe(
      "form changed (different: Phone Number)",
    );
    expect(compareQuestions(stored, page, { upgradeOther: true }).ok).toBe(true);

    resetRunLimit();
    const { summary } = await run();
    expect(summary).toMatchObject({ status: "filled", filled: 13, total: 13 });
    expect(phoneRow()).toMatchObject({ type: "text", required: true, label: "Phone Number" });
  }, 120_000);

  it("a real label change on a row stored as other still stops form_changed", async () => {
    await run();
    setPhoneRow({ type: "other", label: "Mobile number" });
    resetRunLimit();
    const r = await run();
    expect(r.summary).toMatchObject({ status: "stopped", stopReason: "form_changed" });
    expect(runOf(r.summary.runId)?.stop_detail).toBe("form changed (different: Phone Number)");
  }, 120_000);

  it("a real required or option change on a known type still stops form_changed", async () => {
    await run();
    setPhoneRow({ required: false });
    resetRunLimit();
    const r = await run();
    expect(runOf(r.summary.runId)?.stop_detail).toBe("form changed (different: Phone Number)");
    const a = compareQuestions(
      [
        {
          label: "X",
          field_type: "other",
          required: true,
          options: ["a"],
          ats: { type: "ashby", id: "x" },
        },
      ],
      [
        {
          label: "X",
          field_type: "choice",
          required: false,
          options: ["b"],
          ats: { type: "ashby", id: "x" },
        },
      ],
      { upgradeOther: true },
    );
    expect(a.ok).toBe(true); // other -> known: only name and label are compared
    const b = compareQuestions(
      [
        {
          label: "X",
          field_type: "choice",
          required: true,
          options: ["a"],
          ats: { type: "ashby", id: "x" },
        },
      ],
      [
        {
          label: "X",
          field_type: "choice",
          required: true,
          options: ["b"],
          ats: { type: "ashby", id: "x" },
        },
      ],
      { upgradeOther: true },
    );
    expect(b.different).toEqual(["X"]);
  }, 120_000);

  it("the rule: digits only, the typed digits are the end of the kept digits; any other text stays exact", () => {
    const text: LeverControl = {
      name: "n",
      kind: "text",
      label: "L",
      required: false,
      options: null,
      optionValues: [],
    };
    expect(phoneKept("+62 812-3456-7890", ["+62 812 3456 7890"])).toBe(true);
    expect(phoneKept("08123456", ["+1 081-234-56"])).toBe(true);
    expect(phoneKept("5550100123", ["+1 555-0100-123"])).toBe(true);
    expect(phoneKept("5550100123", ["+1 555-0100-124"])).toBe(false);
    expect(phoneKept("5550100123", ["0100123"])).toBe(false); // the page lost digits
    expect(phoneKept("5550100123", [])).toBe(false);
    expect(phoneKept("no digits", ["no digits"])).toBe(false);
    expect(kept(text, "5550100123", ["+1 555-0100-123"], true)).toBe(true);
    // Not a phone: the reformatted value is a different value.
    expect(kept(text, "5550100123", ["+1 555-0100-123"])).toBe(false);
    expect(kept(text, "Example Corp", ["Example  Corp"])).toBe(false);
    expect(kept(text, "Example Corp", ["Example Corp"])).toBe(true);
  });
});

describe("refusals before a browser opens", () => {
  const base = () => ({ db, dataDir, postingId: ASHBY_FIXTURE_POSTING_ID });
  it("fixture mode only opens 127.0.0.1; a real run only a jobs.ashbyhq.com page over https", async () => {
    await expect(
      runAshbyDryRun({
        ...base(),
        url: "https://jobs.ashbyhq.com/acme/1/application",
        fixture: true,
      }),
    ).rejects.toThrow(HarnessRefusalError);
    for (const url of [
      `${server.origin}${ASHBY_FIXTURE_FORM_PATH}`,
      "http://jobs.ashbyhq.com/acme/1/application",
      "https://jobs.ashbyhq.com.example.test/acme/1/application",
      "https://jobs.lever.co/acme/1/apply",
    ])
      await expect(runAshbyDryRun({ ...base(), url, fixture: false })).rejects.toThrow(
        /not an Ashby application page/,
      );
    expect(server.requests).toEqual([]);
  });
});
