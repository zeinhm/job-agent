import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dry_run_fields,
  dry_runs,
  openDb,
  posting_questions,
  unknown_questions,
  type Db,
} from "@job-agent/core";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mappingId } from "../../choice-coverage.ts";
import { planFill, type PlannedField } from "../../fill-plan.ts";
import { normalizeQuestion } from "../../match.ts";
import {
  embeddedFormUrl,
  EXTRA_QUESTION_NOTE,
  loadStoredQuestions,
  runGreenhouseDryRun,
  UPLOAD_NOT_KEPT_NOTE,
  type GreenhouseRunSummary,
} from "./filler.ts";
import {
  FIXTURES_DIR,
  startFixtureServer,
  FIXTURE_CAPTCHA_PATH,
  FIXTURE_CHECKBOX_CLASSIC_PATH,
  FIXTURE_CHECKBOX_FIELDSET_PATH,
  FIXTURE_CHECKBOX_LONE_PATH,
  FIXTURE_CHANGED_PATH,
  FIXTURE_CLOSED_PATH,
  FIXTURE_FORM_PATH,
  FIXTURE_LATE_FORM_PATH,
  FIXTURE_UNDERSCORE_FORM_PATH,
  FIXTURE_LATE_CLEAR_PATH,
  FIXTURE_LATE_RESTORE_PATH,
  FIXTURE_LOCATION_PATH,
  FIXTURE_EDUCATION_PATH,
  FIXTURE_LOCATION_QUESTION,
  FIXTURE_POSTING_ID,
  FIXTURE_DEMOGRAPHICS_PATH,
  FIXTURE_UNKNOWN_EXTRA_PATH,
  FIXTURE_UPLOAD_BUSY_CANCEL_PATH,
  FIXTURE_UPLOAD_CHIP_RENAMED_PATH,
  FIXTURE_UPLOAD_CHOOSER_PATH,
  FIXTURE_UPLOAD_DROPPED_PATH,
  FIXTURE_UPLOAD_LATE_GONE_PATH,
  FIXTURE_UPLOAD_LATE_SHORTENED_PATH,
  FIXTURE_UPLOAD_SWAP_PATH,
  FIXTURE_WIDGETS_PATH,
  fixtureContext,
  seedGreenhouseFixture,
  startGreenhouseFixtureServer,
  type GreenhouseFixtureServer,
} from "./fixture.ts";
import type { PlanContext } from "./filler.ts";
import { dataDirOfDb } from "../output.ts";
import { HarnessRefusalError, type DryRunSession } from "../session.ts";
import { pageOf, resetRunLimit } from "../testing.ts";

let server: GreenhouseFixtureServer;
let dir: string;
let db: Db;
let dataDir: string;

beforeAll(async () => {
  server = await startGreenhouseFixtureServer();
}, 60_000);
afterAll(async () => {
  await server?.close();
});
beforeEach(() => {
  resetRunLimit();
  server.requests.length = 0;
  dir = mkdtempSync(join(tmpdir(), "gh-filler-"));
  db = openDb(join(dir, "test.db"));
  dataDir = dataDirOfDb(join(dir, "test.db"));
  seedGreenhouseFixture(db);
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Seen {
  texts: Record<string, string>;
  selected: Record<string, string[]>;
  checked: string[];
  picked: Record<string, string>;
  files: string[];
  eeocPicked: number;
}

/** What the page really holds, read straight from the DOM (not through the filler's own read-back). */
async function readPage(session: DryRunSession): Promise<Seen> {
  return pageOf(session).evaluate<Seen>(`(() => {
    const val = (id) => document.getElementById(id).value;
    const sel = (id) => [...document.getElementById(id).selectedOptions].filter((o) => o.value !== "").map((o) => o.textContent.trim());
    const picked = (id) => document.getElementById(id).closest(".select__container").querySelector(".select__single-value")?.textContent ?? "";
    return {
      texts: Object.fromEntries(["first_name", "last_name", "email", "phone", "question_1001", "question_1002", "question_1008"].map((id) => [id, val(id)])),
      selected: { question_1004: sel("question_1004"), question_1005: sel("question_1005") },
      checked: [...document.querySelectorAll("input[type=radio]:checked, input[type=checkbox]:checked")].map((b) => b.id),
      picked: { question_1003: picked("question_1003") },
      files: [...(document.getElementById("resume")?.files ?? [])].map((f) => f.name),
      eeocPicked: document.querySelectorAll(".eeoc__container .select__single-value").length +
        document.querySelectorAll(".phone-input__country .select__single-value").length,
    };
  })()`);
}

interface Out {
  summary: GreenhouseRunSummary;
  seen: Seen | null;
}

async function run(
  path: string = FIXTURE_FORM_PATH,
  over: { context?: (c: PlanContext) => PlanContext } = {},
): Promise<Out> {
  let seen: Seen | null = null;
  const base = fixtureContext(dataDir);
  const summary = await runGreenhouseDryRun({
    db,
    dataDir,
    postingId: FIXTURE_POSTING_ID,
    url: `${server.origin}${path}`,
    fixture: true,
    context: over.context ? over.context(base) : base,
    beforeFinish: async (s) => {
      seen = await readPage(s);
    },
  });
  return { summary, seen };
}

const fieldsOf = (runId: string) =>
  db.select().from(dry_run_fields).where(eq(dry_run_fields.dry_run_id, runId)).all();
const runOf = (runId: string) => db.select().from(dry_runs).where(eq(dry_runs.id, runId)).get();

const without = (key: string) => (c: PlanContext) => ({
  ...c,
  answers: c.answers.filter((a) => a.key !== key),
});

describe("full fill on the fixture", () => {
  it("fills every covered field: the DOM equals the plan, nothing non-GET reaches the server, nothing submits", async () => {
    const { summary, seen } = await run();
    expect(summary).toMatchObject({ status: "filled", stopReason: null, filled: 13, total: 13 });

    // The plan, computed separately from the same inputs, is what the page holds.
    const ctx = fixtureContext(dataDir);
    const plan = planFill({ fields: loadStoredQuestions(db, FIXTURE_POSTING_ID), ...ctx });
    if (plan.kind !== "fill") throw new Error("expected a fill plan");
    const value = (id: string) =>
      (plan.fields.find((f) => f.field.ats.id === id) as Extract<PlannedField, { filled: true }>)
        .value;
    expect(seen).not.toBeNull();
    const s = seen as unknown as Seen;
    expect(s.texts).toEqual({
      first_name: value("first_name"),
      last_name: value("last_name"),
      email: value("email"),
      phone: value("phone"),
      question_1001: value("question_1001"),
      question_1002: value("question_1002"),
      question_1008: value("question_1008"),
    });
    expect(s.texts["first_name"]).toBe("Alex");
    expect(s.texts["last_name"]).toBe("Example");
    expect(s.texts["question_1008"]).toBe("24000 USD per year (30000000 IDR per month)");
    expect(s.picked["question_1003"]).toBe("Yes");
    expect(s.selected["question_1004"]).toEqual(["UTC+7 (Jakarta)"]);
    expect(s.selected["question_1005"]).toEqual(["Git", "Docker"]);
    expect(s.checked.sort()).toEqual(["question_1006_1", "question_1007_1", "question_1007_2"]);
    expect(s.files).toEqual(["fixture-resume.pdf"]);
    // The EEO block and the phone country are left alone.
    expect(s.eeocPicked).toBe(0);

    // Zero non-GET requests reached the server; the page's POSTs and beacon were stopped.
    expect(server.nonGet()).toEqual([]);
    expect(server.requests.some((r) => r.path.startsWith("/collect") || r.path === "/apply")).toBe(
      false,
    );
    expect(summary.aborted.map((a) => a.path)).toEqual(
      expect.arrayContaining(["/collect/pageview", "/collect/change"]),
    );
    expect(summary.attempts.some((a) => a.kind === "send_beacon")).toBe(true);
    expect(summary.attempts.map((a) => a.kind)).not.toContain("submit_event");
    expect(summary.attempts.map((a) => a.kind)).not.toContain("form_submit_call");
    expect(summary.attempts.map((a) => a.kind)).not.toContain("form_request_submit_call");
  }, 90_000);

  it("records the run, every field with filled true and where it came from, and a private screenshot", async () => {
    const { summary } = await run();
    const rows = fieldsOf(summary.runId);
    expect(rows).toHaveLength(13);
    expect(rows.every((r) => r.filled && r.note === null)).toBe(true);
    const by = (label: string) => rows.find((r) => r.label === label);
    expect(by("First Name")).toMatchObject({ source: "standard", answer_key: "contact.full_name" });
    expect(by("Resume/CV")).toMatchObject({ source: "resume", value: "fixture-resume.pdf" });
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
      ats_type: "greenhouse",
      fixture: true,
      stop_reason: null,
    });

    const shot = join(dataDir, summary.screenshotPath);
    expect(existsSync(shot)).toBe(true);
    expect(statSync(shot).mode & 0o777).toBe(0o600);
    expect(statSync(join(shot, "..")).mode & 0o777).toBe(0o700);
  }, 90_000);
});

describe("needs_input (owner answer on gate t_2c20b3fa, question 4)", () => {
  it("an uncovered question stays empty, the rest is filled, the label goes to the Inbox", async () => {
    const { summary, seen } = await run(FIXTURE_FORM_PATH, {
      context: (c) => without("misc.open_to_crypto_web3")(c),
    });
    expect(summary).toMatchObject({
      status: "needs_input",
      stopReason: "uncovered_question",
      filled: 12,
      total: 13,
    });
    const s = seen as unknown as Seen;
    expect(s.texts["question_1002"]).toBe("");
    expect(s.texts["first_name"]).toBe("Alex");
    const open = fieldsOf(summary.runId).filter((r) => !r.filled);
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
    expect(server.nonGet()).toEqual([]);
  }, 90_000);

  it("an unmapped choice is left empty and the run is choice_unmapped", async () => {
    const { summary, seen } = await run(FIXTURE_FORM_PATH, {
      context: (c) => ({ ...c, choiceMappings: new Map() }),
    });
    expect(summary).toMatchObject({ status: "needs_input", stopReason: "choice_unmapped" });
    const s = seen as unknown as Seen;
    expect(s.selected["question_1004"]).toEqual([]);
    expect(s.selected["question_1005"]).toEqual([]);
    expect(s.checked).toEqual([]);
    expect(s.picked["question_1003"]).toBe("Yes"); // yes / no needs no mapping
    expect(s.texts["email"]).not.toBe("");
  }, 90_000);

  it("no tier ask: the salary field stays empty; a missing resume file leaves the upload empty", async () => {
    const { summary, seen } = await run(FIXTURE_FORM_PATH, {
      context: (c) => ({ ...c, ask: null }),
    });
    expect(summary).toMatchObject({ status: "needs_input", stopReason: "uncovered_question" });
    expect((seen as unknown as Seen).texts["question_1008"]).toBe("");

    resetRunLimit();
    const missing = await run(FIXTURE_FORM_PATH, {
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
    const long = "x".repeat(600);
    const { summary } = await run(FIXTURE_FORM_PATH, {
      context: (c) => ({
        ...c,
        answers: c.answers.map((a) =>
          a.key === "misc.open_to_crypto_web3" ? { ...a, answer: long } : a,
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

describe("readback after a late re-render (intermittent per page)", () => {
  it("a field the page blanks after the write is written again and counted as filled", async () => {
    const { summary, seen } = await run(FIXTURE_LATE_CLEAR_PATH);
    expect(summary).toMatchObject({ status: "filled", filled: 13, total: 13 });
    const rows = fieldsOf(summary.runId);
    for (const label of ["First Name", "Email"])
      expect(rows.find((r) => r.label === label)).toMatchObject({ filled: true, note: null });
    expect(rows.find((r) => r.field_type === "file")).toMatchObject({ filled: true, note: null });
    const s = seen as unknown as Seen;
    expect(s.texts["first_name"]).toBe("Alex");
    expect(s.texts["email"]).not.toBe("");
    expect(s.files).toEqual(["fixture-resume.pdf"]);
  }, 90_000);

  it("a value the page blanks and then puts back is read once settled, not reported as different", async () => {
    const { summary, seen } = await run(FIXTURE_LATE_RESTORE_PATH);
    expect(summary).toMatchObject({ status: "filled", filled: 13, total: 13 });
    const rows = fieldsOf(summary.runId);
    for (const label of ["First Name", "Last Name"])
      expect(rows.find((r) => r.label === label)).toMatchObject({ filled: true, note: null });
    expect((seen as unknown as Seen).texts["last_name"]).toBe("Example");
  }, 90_000);

  it("an upload the page completes late (input swapped for a file-name line) is filled, not refused", async () => {
    const { summary } = await run(FIXTURE_UPLOAD_SWAP_PATH);
    expect(summary).toMatchObject({ status: "filled", filled: 13, total: 13 });
    expect(fieldsOf(summary.runId).find((r) => r.field_type === "file")).toMatchObject({
      source: "resume",
      filled: true,
      note: null,
    });
  }, 90_000);

  it("a widget that drops a programmatic attach but keeps a file picked through its chooser is filled on the second attempt", async () => {
    const { summary } = await run(FIXTURE_UPLOAD_CHOOSER_PATH);
    expect(summary).toMatchObject({ status: "filled", filled: 13, total: 13 });
    expect(fieldsOf(summary.runId).find((r) => r.field_type === "file")).toMatchObject({
      source: "resume",
      filled: true,
      note: null,
    });
  }, 90_000);

  describe.each([
    ["required", true],
    ["optional", false],
  ])("a %s resume field", (_name, required) => {
    const setRequired = () =>
      db
        .update(posting_questions)
        .set({ required })
        .where(
          and(
            eq(posting_questions.posting_id, FIXTURE_POSTING_ID),
            eq(posting_questions.question_id, "resume"),
          ),
        )
        .run();

    it.each([
      ["a plain attach", FIXTURE_FORM_PATH],
      ["a late input swap", FIXTURE_UPLOAD_SWAP_PATH],
      ["a chooser-only widget", FIXTURE_UPLOAD_CHOOSER_PATH],
      ["a slow upload that removes its input", FIXTURE_UPLOAD_LATE_GONE_PATH],
      ["a 12 s upload that shows a shortened name", FIXTURE_UPLOAD_LATE_SHORTENED_PATH],
      ["a 13 s upload that a second attach cancels", FIXTURE_UPLOAD_BUSY_CANCEL_PATH],
      ["a chip with a renamed name, a size and a remove button", FIXTURE_UPLOAD_CHIP_RENAMED_PATH],
    ])(
      "is kept on %s",
      async (_widget, path) => {
        setRequired();
        const { summary } = await run(path);
        expect(summary).toMatchObject({ status: "filled", filled: 13, total: 13 });
        expect(fieldsOf(summary.runId).find((r) => r.field_type === "file")).toMatchObject({
          required,
          source: "resume",
          filled: true,
          note: null,
        });
      },
      90_000,
    );
  });

  it("an upload the page drops names the upload as the cause, not a generic refusal", async () => {
    const { summary } = await run(FIXTURE_UPLOAD_DROPPED_PATH);
    expect(summary).toMatchObject({ status: "needs_input", filled: 12, total: 13 });
    expect(fieldsOf(summary.runId).find((r) => r.field_type === "file")).toMatchObject({
      source: "resume",
      filled: false,
      value: null,
      note: UPLOAD_NOT_KEPT_NOTE,
    });
    // The report carries the control's markup without any value, so the next operator run can show the widget.
    const detail = runOf(summary.runId)?.stop_detail ?? "";
    expect(detail).toMatch(/; upload: input=(yes|no) div/);
    expect(detail).not.toContain("fixture-resume");
  }, 90_000);
});

describe("location autocomplete (the stored Location question: the owner picks)", () => {
  const seedLocation = () =>
    db
      .insert(posting_questions)
      .values({
        id: randomUUID(),
        posting_id: FIXTURE_POSTING_ID,
        ats_type: "greenhouse",
        question_id: FIXTURE_LOCATION_QUESTION.id,
        label: FIXTURE_LOCATION_QUESTION.label,
        required: false,
        type: FIXTURE_LOCATION_QUESTION.type,
        options: null,
        normalized_label: normalizeQuestion(FIXTURE_LOCATION_QUESTION.label),
        matched_key: null,
        fetched_at: new Date().toISOString(),
      })
      .run();

  const withLocation = (answer: string) => (c: PlanContext) => ({
    ...c,
    answers: [
      ...c.answers,
      {
        key: "contact.location",
        question: "Location",
        alternatives: null,
        answer,
        type: null,
        choices: null,
        approved: true,
      },
    ],
  });
  const locationState = async (context: (c: PlanContext) => PlanContext) => {
    let page: { typed: string[]; shown: string } = { typed: [], shown: "" };
    const summary = await runGreenhouseDryRun({
      db,
      dataDir,
      postingId: FIXTURE_POSTING_ID,
      url: `${server.origin}${FIXTURE_LOCATION_PATH}`,
      fixture: true,
      context: context(fixtureContext(dataDir)),
      beforeFinish: async (s) => {
        page = await pageOf(s).evaluate(`(() => ({
          typed: ["candidate-location", "candidate-location-search", "candidate-location-filter"].map((id) => document.getElementById(id).value),
          shown: document.querySelector("#candidate-location").closest(".select__container").querySelector(".select__single-value")?.textContent ?? "",
        }))()`);
      },
    });
    return { summary, page };
  };

  it("one matching suggestion is picked: the row shows it with the source autocomplete, the run is filled", async () => {
    seedLocation();
    const { summary, page } = await locationState(withLocation("Jakarta"));
    expect(summary).toMatchObject({ status: "filled", filled: 14, total: 14 });
    expect(fieldsOf(summary.runId).find((r) => r.label === "Location")).toMatchObject({
      filled: true,
      value: "Jakarta, Indonesia",
      source: "autocomplete",
      answer_key: "contact.location",
      note: null,
    });
    expect(page.shown).toBe("Jakarta, Indonesia");
    expect(page.typed).toEqual(["", "", ""]);
    expect(server.nonGet()).toEqual([]);
  }, 90_000);

  it("all words of the answer must be present: two cities share a word, the second word picks one", async () => {
    seedLocation();
    const { summary, page } = await locationState(withLocation("springfield ILLINOIS"));
    expect(summary).toMatchObject({ status: "filled" });
    expect(fieldsOf(summary.runId).find((r) => r.label === "Location")).toMatchObject({
      filled: true,
      value: "Springfield, Illinois, United States",
      source: "autocomplete",
    });
    expect(page.shown).toBe("Springfield, Illinois, United States");
  }, 90_000);

  it("no matching suggestion: needs_input, nothing picked, the typed text is cleared", async () => {
    seedLocation();
    const { summary, page } = await locationState(withLocation("Atlantis"));
    expect(summary).toMatchObject({ status: "needs_input", filled: 13, total: 14 });
    expect(runOf(summary.runId)).toMatchObject({
      stop_reason: "uncovered_question",
      stop_detail: "1 field(s) need input",
    });
    expect(fieldsOf(summary.runId).find((r) => r.label === "Location")).toMatchObject({
      filled: false,
      value: null,
      source: "none",
      note: "location autocomplete: no suggestion matches the answer",
    });
    expect(page).toEqual({ typed: ["", "", ""], shown: "" });
  }, 90_000);

  it("two matching suggestions: needs_input, nothing picked", async () => {
    seedLocation();
    const { summary, page } = await locationState(withLocation("Springfield"));
    expect(summary).toMatchObject({ status: "needs_input", filled: 13, total: 14 });
    expect(fieldsOf(summary.runId).find((r) => r.label === "Location")).toMatchObject({
      filled: false,
      source: "none",
      note: "location autocomplete: several suggestions match the answer",
    });
    expect(page).toEqual({ typed: ["", "", ""], shown: "" });
  }, 90_000);

  it("a suggestion that only partly matches the answer is not picked", async () => {
    seedLocation();
    const { summary } = await locationState(withLocation("Jakarta Narnia"));
    expect(fieldsOf(summary.runId).find((r) => r.label === "Location")).toMatchObject({
      filled: false,
      note: "location autocomplete: no suggestion matches the answer",
    });
  }, 90_000);

  it("no approved location answer: nothing is typed, the row says so", async () => {
    seedLocation();
    const { summary, page } = await locationState((c) => ({
      ...c,
      answers: c.answers.filter((a) => a.key !== "contact.location"),
    }));
    expect(summary).toMatchObject({ status: "needs_input", filled: 13, total: 14 });
    expect(fieldsOf(summary.runId).find((r) => r.label === "Location")).toMatchObject({
      filled: false,
      note: "location autocomplete: no approved location answer",
    });
    expect(page).toEqual({ typed: ["", "", ""], shown: "" });
  }, 90_000);

  it("regression: the widget's helper Search inputs (inside and beside it) are not extra questions", async () => {
    seedLocation();
    const { summary } = await locationState(withLocation("Atlantis"));
    expect(summary.status).toBe("needs_input");
    expect(summary.stopReason).not.toBe("form_changed");
    expect(fieldsOf(summary.runId).some((r) => r.label === "Search")).toBe(false);
  }, 90_000);

  it("without the stored Location question the control is an extra question: listed as needing input, not form_changed", async () => {
    const { summary } = await run(FIXTURE_LOCATION_PATH);
    expect(summary).toMatchObject({ status: "needs_input", stopReason: "uncovered_question" });
    expect(fieldsOf(summary.runId).find((r) => r.label === "Location (City)")).toMatchObject({
      filled: false,
      source: "none",
      note: EXTRA_QUESTION_NOTE,
    });
  }, 90_000);

  it("the Location question on a form that has no location control: form_changed", async () => {
    seedLocation();
    const { summary } = await run();
    expect(summary).toMatchObject({ status: "stopped", stopReason: "form_changed" });
    expect(runOf(summary.runId)?.stop_detail).toBe("form changed (missing: Location)");
  }, 90_000);
});

describe("locating the application form (t_c0c2b45a)", () => {
  it("a form rendered after the load event is waited for: the run fills as on the plain form", async () => {
    const { summary } = await run(FIXTURE_LATE_FORM_PATH);
    expect(summary).toMatchObject({ status: "filled", stopReason: null, filled: 13, total: 13 });
  }, 90_000);

  it("the older embed's form#application_form is found", async () => {
    const { summary } = await run(FIXTURE_UNDERSCORE_FORM_PATH);
    expect(summary).toMatchObject({ status: "filled", stopReason: null, filled: 13, total: 13 });
  }, 90_000);

  it("a closed posting stops with its own detail, not form_changed", async () => {
    const { summary } = await run(FIXTURE_CLOSED_PATH);
    expect(summary).toMatchObject({ status: "stopped", stopReason: "page_error", filled: 0 });
    expect(runOf(summary.runId)?.stop_detail).toBe(
      "posting closed: the page has no application form",
    );
  }, 90_000);
});

describe("widget helper inputs and the education block are known fields (t_28f6e353)", () => {
  it("combobox filter boxes and a react-select internal input are not extra questions: the run fills as on the plain form", async () => {
    const { summary } = await run(FIXTURE_WIDGETS_PATH);
    expect(summary).toMatchObject({ status: "filled", stopReason: null, filled: 13, total: 13 });
    expect(fieldsOf(summary.runId).some((r) => /search|filter/i.test(r.label))).toBe(false);
  }, 90_000);

  it("the education block is not form_changed: required controls are listed as needing input, optional ones are skipped", async () => {
    const { summary, seen } = await run(FIXTURE_EDUCATION_PATH);
    expect(summary).toMatchObject({ status: "needs_input", filled: 13, total: 15 });
    expect(summary.stopReason).not.toBe("form_changed");
    const rows = fieldsOf(summary.runId);
    expect(
      rows.filter((r) => !r.filled).map((r) => [r.label, r.required, r.source, r.value]),
    ).toEqual([
      ["School", true, "none", null],
      ["Degree", true, "none", null],
    ]);
    expect(rows.some((r) => /Discipline|date|Search/.test(r.label))).toBe(false);
    // Nothing was typed into the education controls.
    expect(seen).not.toBeNull();
  }, 90_000);

  it("several extra self-identification questions: the stored fields are filled, the extras are listed unmatched, nothing is typed into them", async () => {
    const { summary } = await run(FIXTURE_DEMOGRAPHICS_PATH);
    expect(summary).toMatchObject({
      status: "needs_input",
      stopReason: "uncovered_question",
      filled: 13,
      total: 16,
    });
    const open = fieldsOf(summary.runId).filter((r) => !r.filled);
    const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);
    expect(
      [...open]
        .sort(byLabel)
        .map((r) => [r.label, r.field_type, r.required, r.source, r.value, r.note]),
    ).toEqual([
      [
        "Do you identify as a fictional species?",
        "choice",
        false,
        "none",
        null,
        EXTRA_QUESTION_NOTE,
      ],
      ["How old are you?", "text", false, "none", null, EXTRA_QUESTION_NOTE],
      ["Which era do you prefer?", "choice", false, "none", null, EXTRA_QUESTION_NOTE],
    ]);
  }, 90_000);

  it("an extra question next to a renamed (missing) stored question is still form_changed", async () => {
    const { summary } = await run(FIXTURE_CHANGED_PATH);
    expect(summary).toMatchObject({ status: "stopped", stopReason: "form_changed", filled: 0 });
  }, 90_000);

  it("a really unknown extra question is listed as needing input (the stored fields are still filled), and the helper next to it is not named", async () => {
    const { summary } = await run(FIXTURE_UNKNOWN_EXTRA_PATH);
    expect(summary).toMatchObject({
      status: "needs_input",
      stopReason: "uncovered_question",
      filled: 13,
      total: 14,
    });
    const rows = fieldsOf(summary.runId);
    expect(rows.filter((r) => !r.filled).map((r) => [r.label, r.source, r.value, r.note])).toEqual([
      ["Favourite database", "none", null, EXTRA_QUESTION_NOTE],
    ]);
    expect(rows.some((r) => /search|filter/i.test(r.label))).toBe(false);
  }, 90_000);
});

describe("a hosted job page that sends the visitor to another host", () => {
  const movedTo = (target: string) => (req: { url: URL }) =>
    req.url.pathname === "/acme/jobs/1005" || req.url.pathname === "/embed/job_app"
      ? {
          status: 302,
          contentType: "text/plain",
          body: "",
          headers: { location: `${target}/acme/jobs/1001` },
        }
      : undefined;

  it("opens the embedded application form of the same board instead and fills it", async () => {
    // Only the job page redirects; the embed path is a static page on the same (redirecting) host.
    const board = await startFixtureServer(
      FIXTURES_DIR,
      { "/embed/job_app": "form.html" },
      (req) => (req.url.pathname === "/acme/jobs/1005" ? movedTo(server.origin)(req) : undefined),
    );
    try {
      const summary = await runGreenhouseDryRun({
        db,
        dataDir,
        postingId: FIXTURE_POSTING_ID,
        url: `${board.origin}/acme/jobs/1005`,
        fixture: true,
        context: fixtureContext(dataDir),
      });
      expect(summary).toMatchObject({ status: "filled", filled: 13, total: 13 });
      expect(board.requests.map((r) => `${r.method} ${r.path}`)).toEqual(
        expect.arrayContaining(["GET /acme/jobs/1005", "GET /embed/job_app"]),
      );
      expect(board.nonGet()).toEqual([]);
    } finally {
      await board.close();
    }
  }, 90_000);

  it("a redirect from the embedded form too still stops: redirected to another host", async () => {
    const board = await startFixtureServer(FIXTURES_DIR, {}, movedTo(server.origin));
    try {
      const summary = await runGreenhouseDryRun({
        db,
        dataDir,
        postingId: FIXTURE_POSTING_ID,
        url: `${board.origin}/acme/jobs/1005`,
        fixture: true,
        context: fixtureContext(dataDir),
      });
      expect(summary).toMatchObject({ status: "stopped", stopReason: "other", filled: 0 });
      expect(runOf(summary.runId)?.stop_detail).toBe("redirected to another host");
    } finally {
      await board.close();
    }
  }, 90_000);

  it("the embedded form URL is derived from /<board>/jobs/<id> only", () => {
    expect(embeddedFormUrl("https://job-boards.greenhouse.io/acme/jobs/1005")).toBe(
      "https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1005",
    );
    expect(embeddedFormUrl("https://job-boards.eu.greenhouse.io/acme/jobs/7/")).toBe(
      "https://job-boards.eu.greenhouse.io/embed/job_app?for=acme&token=7",
    );
    expect(embeddedFormUrl("https://job-boards.greenhouse.io/acme")).toBeNull();
    expect(embeddedFormUrl("https://example.test/acme/jobs/abc")).toBeNull();
  });
});

describe("stops (nothing is filled)", () => {
  async function stopped(
    out: Promise<Out>,
    reason: string,
  ): Promise<{ summary: GreenhouseRunSummary; seen: Seen | null }> {
    const r = await out;
    expect(r.summary).toMatchObject({ status: "stopped", stopReason: reason, filled: 0, total: 0 });
    expect(r.seen).toBeNull(); // never reached the filling step
    expect(fieldsOf(r.summary.runId)).toEqual([]);
    expect(existsSync(join(dataDir, r.summary.screenshotPath))).toBe(true);
    expect(server.nonGet()).toEqual([]);
    return r;
  }

  it("a scam-flagged posting", async () => {
    const r = await stopped(
      run(FIXTURE_FORM_PATH, { context: (c) => ({ ...c, scamFlagged: true }) }),
      "other",
    );
    expect(runOf(r.summary.runId)?.stop_detail).toBe("scam flagged");
  }, 90_000);

  it("an unsupported field type", async () => {
    db.update(posting_questions)
      .set({ type: "other" })
      .where(
        and(
          eq(posting_questions.posting_id, FIXTURE_POSTING_ID),
          eq(posting_questions.question_id, "question_1005"),
        ),
      )
      .run();
    const r = await stopped(run(), "unexpected_field");
    expect(runOf(r.summary.runId)?.stop_detail).toBe("Which tools do you use?");
  }, 90_000);

  it("a field that matches two answers", async () => {
    const r = await stopped(
      run(FIXTURE_FORM_PATH, {
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

  it("the CAPTCHA page", async () => {
    const r = await stopped(run(FIXTURE_CAPTCHA_PATH), "captcha");
    expect(runOf(r.summary.runId)?.stop_detail).toBe("visible captcha challenge on the page");
  }, 90_000);

  it("a changed form: labels of the missing, extra and different fields, no values", async () => {
    const r = await stopped(run(FIXTURE_CHANGED_PATH), "form_changed");
    const detail = runOf(r.summary.runId)?.stop_detail ?? "";
    expect(detail).toBe(
      "form changed (missing: Expected salary (USD per year); extra: Do you need visa sponsorship?; different: LinkedIn Profile)",
    );
    expect(detail).not.toMatch(/Alex|example\.test/);
  }, 90_000);
});

describe("refusals before a browser opens", () => {
  const base = () => ({ db, dataDir, postingId: FIXTURE_POSTING_ID });
  it("fixture mode only opens 127.0.0.1; a real run only a Greenhouse job-boards page", async () => {
    await expect(
      runGreenhouseDryRun({
        ...base(),
        url: "https://job-boards.greenhouse.io/acme/jobs/1001",
        fixture: true,
      }),
    ).rejects.toThrow(HarnessRefusalError);
    await expect(
      runGreenhouseDryRun({ ...base(), url: `${server.origin}/acme/jobs/1001`, fixture: false }),
    ).rejects.toThrow(/not a Greenhouse job-boards page/);
    await expect(
      runGreenhouseDryRun({
        ...base(),
        url: "http://job-boards.greenhouse.io/acme/jobs/1001",
        fixture: false,
      }),
    ).rejects.toThrow(/not a Greenhouse job-boards page/);
    expect(server.requests).toEqual([]);
  });

  it("a posting without stored Greenhouse questions", async () => {
    await expect(
      runGreenhouseDryRun({
        ...base(),
        postingId: "unknown",
        url: `${server.origin}${FIXTURE_FORM_PATH}`,
        fixture: true,
      }),
    ).rejects.toThrow(/no stored Greenhouse questions/);
    expect(server.requests).toEqual([]);
  });
});

describe("a multi-select question shown as checkboxes is one question", () => {
  const LABEL = "Do you have experience with the following stack:";
  const OPTIONS = ["JS", "Vue", "Some of the above", "None of the above"];
  const KEY = "experience.years_react";

  const addQuestion = (questionId: string) =>
    db
      .insert(posting_questions)
      .values({
        id: randomUUID(),
        posting_id: FIXTURE_POSTING_ID,
        ats_type: "greenhouse",
        question_id: questionId,
        label: LABEL,
        required: false,
        type: "multi_choice",
        options: JSON.stringify(OPTIONS),
        normalized_label: normalizeQuestion(LABEL),
        matched_key: null,
        fetched_at: new Date().toISOString(),
      })
      .run();
  const withAnswer = (c: PlanContext): PlanContext => ({
    ...c,
    answers: [
      ...c.answers,
      {
        key: KEY,
        question: LABEL,
        alternatives: null,
        answer: "JS, Vue",
        type: null,
        choices: null,
        approved: true,
      },
    ],
    choiceMappings: new Map([...c.choiceMappings, [mappingId(KEY, LABEL, OPTIONS), ["JS", "Vue"]]]),
  });
  const checkedWith = (s: Seen | null, prefix: string) =>
    (s as Seen).checked.filter((id) => id.startsWith(prefix)).sort();

  it("job-boards fieldset without a group id: the compare matches and the mapped options are checked", async () => {
    addQuestion("question_2001");
    const { summary, seen } = await run(FIXTURE_CHECKBOX_FIELDSET_PATH, { context: withAnswer });
    expect(summary).toMatchObject({ status: "filled", stopReason: null, filled: 14, total: 14 });
    expect(checkedWith(seen, "question_2001_")).toEqual(["question_2001_0", "question_2001_1"]);
    expect(fieldsOf(summary.runId).find((r) => r.label === LABEL)).toMatchObject({
      filled: true,
      source: "choice_mapping",
      value: "JS; Vue",
    });
    expect(server.nonGet()).toEqual([]);
  }, 90_000);

  it("classic list of wrapped labels, stored id with the `[]` suffix", async () => {
    addQuestion("question_2002[]");
    const { summary, seen } = await run(FIXTURE_CHECKBOX_CLASSIC_PATH, { context: withAnswer });
    expect(summary).toMatchObject({ status: "filled", stopReason: null, filled: 14, total: 14 });
    expect(checkedWith(seen, "question_2002_")).toEqual(["question_2002_a", "question_2002_b"]);
  }, 90_000);

  it("not covered by the answer bank: needs_input with a note, never form_changed", async () => {
    addQuestion("question_2001");
    const { summary, seen } = await run(FIXTURE_CHECKBOX_FIELDSET_PATH);
    expect(summary.status).toBe("needs_input");
    expect(summary.stopReason).not.toBe("form_changed");
    expect(checkedWith(seen, "question_2001_")).toEqual([]);
    expect(fieldsOf(summary.runId).find((r) => r.label === LABEL)).toMatchObject({
      filled: false,
    });
  }, 90_000);

  it("a group whose options differ from the stored ones still stops form_changed", async () => {
    addQuestion("question_2001");
    db.update(posting_questions)
      .set({ options: JSON.stringify([...OPTIONS, "Svelte"]) })
      .where(eq(posting_questions.question_id, "question_2001"))
      .run();
    const { summary } = await run(FIXTURE_CHECKBOX_FIELDSET_PATH);
    expect(summary).toMatchObject({ status: "stopped", stopReason: "form_changed" });
    expect(runOf(summary.runId)?.stop_detail).toBe(`form changed (different: ${LABEL})`);
  }, 90_000);

  it("a lone checkbox in a plain field wrapper keeps its own id: the compare matches, never form_changed", async () => {
    const label = "I agree to the data policy";
    db.insert(posting_questions)
      .values({
        id: randomUUID(),
        posting_id: FIXTURE_POSTING_ID,
        ats_type: "greenhouse",
        question_id: "question_3001",
        label,
        required: false,
        type: "other",
        options: null,
        normalized_label: normalizeQuestion(label),
        matched_key: null,
        fetched_at: new Date().toISOString(),
      })
      .run();
    const { summary } = await run(FIXTURE_CHECKBOX_LONE_PATH);
    expect(summary.stopReason).not.toBe("form_changed");
    expect(runOf(summary.runId)?.stop_detail ?? "").not.toContain("form changed");
  }, 90_000);
});
