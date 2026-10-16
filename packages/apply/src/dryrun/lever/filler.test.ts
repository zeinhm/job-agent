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
import type { FixtureServer } from "../greenhouse/fixture.ts";
import { dataDirOfDb } from "../output.ts";
import { HarnessRefusalError, type DryRunSession } from "../session.ts";
import { pageOf, resetRunLimit } from "../testing.ts";
import { loadStoredLeverQuestions, runLeverDryRun, type LeverRunSummary } from "./filler.ts";
import {
  LEVER_FIXTURE_CAPTCHA_PATH,
  LEVER_FIXTURE_CHANGED_PATH,
  LEVER_FIXTURE_DATE_PATH,
  LEVER_FIXTURE_FORM_PATH,
  LEVER_FIXTURE_LOCATION_PATH,
  LEVER_FIXTURE_POSTING_ID,
  leverFixtureContext,
  seedLeverFixture,
  startLeverFixtureServer,
} from "./fixture.ts";

const CARD = "cards[0b1c3f6e-5d3a-4f0e-9d51-2f0a6c1e7a01]";
const WHY = `${CARD}[field0]`;
const REMOTE = `${CARD}[field1]`;
const ZONE = `${CARD}[field2]`;
const TOOLS = `${CARD}[field3]`;
const STACK = `${CARD}[field4]`;
const REGIONS = `${CARD}[field5]`;
const SALARY = `${CARD}[field6]`;

let server: FixtureServer;
let dir: string;
let db: Db;
let dataDir: string;

beforeAll(async () => {
  server = await startLeverFixtureServer();
}, 60_000);
afterAll(async () => {
  await server?.close();
});
beforeEach(() => {
  resetRunLimit();
  server.requests.length = 0;
  dir = mkdtempSync(join(tmpdir(), "lever-filler-"));
  db = openDb(join(dir, "test.db"));
  dataDir = dataDirOfDb(join(dir, "test.db"));
  seedLeverFixture(db);
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
  untouched: { pronouns: number; survey: number; consent: number };
}

/** What the page really holds, read straight from the DOM (not through the filler's own read-back). */
async function readPage(session: DryRunSession): Promise<Seen> {
  return pageOf(session).evaluate<Seen>(`(() => {
    const form = document.getElementById("application-form");
    const els = (name) => [...form.elements].filter((e) => e.getAttribute("name") === name);
    const val = (name) => els(name)[0].value;
    const sel = (name) => [...els(name)[0].selectedOptions].filter((o) => o.value !== "").map((o) => o.value);
    const checked = (name) => els(name).filter((e) => e.checked).map((e) => e.value);
    const count = (prefix) => [...form.elements].filter((e) => (e.getAttribute("name") || "").startsWith(prefix) && e.checked).length;
    return {
      texts: Object.fromEntries(["name", "email", "phone", "org", "urls[LinkedIn]", ${JSON.stringify(WHY)}, ${JSON.stringify(SALARY)}].map((n) => [n, val(n)])),
      selected: { [${JSON.stringify(ZONE)}]: sel(${JSON.stringify(ZONE)}), [${JSON.stringify(REGIONS)}]: sel(${JSON.stringify(REGIONS)}) },
      checked: {
        [${JSON.stringify(REMOTE)}]: checked(${JSON.stringify(REMOTE)}),
        [${JSON.stringify(TOOLS)}]: checked(${JSON.stringify(TOOLS)}),
        [${JSON.stringify(STACK)}]: checked(${JSON.stringify(STACK)}),
      },
      files: [...els("resume")[0].files].map((f) => f.name),
      untouched: { pronouns: count("pronouns"), survey: count("surveysResponses["), consent: count("consent[") },
    };
  })()`);
}

interface Out {
  summary: LeverRunSummary;
  seen: Seen | null;
}

async function run(
  path: string = LEVER_FIXTURE_FORM_PATH,
  over: { context?: (c: PlanContext) => PlanContext | undefined } = {},
): Promise<Out> {
  let seen: Seen | null = null;
  const base = leverFixtureContext(dataDir);
  const context = over.context ? over.context(base) : base;
  const summary = await runLeverDryRun({
    db,
    dataDir,
    postingId: LEVER_FIXTURE_POSTING_ID,
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
    .where(eq(posting_questions.posting_id, LEVER_FIXTURE_POSTING_ID))
    .all();

const without = (key: string) => (c: PlanContext) => ({
  ...c,
  answers: c.answers.filter((a) => a.key !== key),
});

describe("full fill on the fixture", () => {
  it("fills every covered field: the DOM equals the plan, nothing non-GET reaches the server, nothing submits", async () => {
    const { summary, seen } = await run();
    expect(summary).toMatchObject({ status: "filled", stopReason: null, filled: 13, total: 13 });

    // The plan, computed separately from the questions the run stored, is what the page holds.
    const ctx = leverFixtureContext(dataDir);
    const plan = planFill({
      fields: loadStoredLeverQuestions(db, LEVER_FIXTURE_POSTING_ID),
      ...ctx,
    });
    if (plan.kind !== "fill") throw new Error("expected a fill plan");
    const value = (id: string) =>
      (plan.fields.find((f) => f.field.ats.id === id) as Extract<PlannedField, { filled: true }>)
        .value;
    const s = seen as unknown as Seen;
    expect(s.texts).toEqual({
      name: value("name"),
      email: value("email"),
      phone: value("phone"),
      org: value("org"),
      "urls[LinkedIn]": value("urls[LinkedIn]"),
      [WHY]: value(WHY),
      [SALARY]: value(SALARY),
    });
    expect(s.texts["name"]).toBe("Alex Example");
    expect(s.texts["org"]).toBe("Example Corp");
    expect(s.texts[SALARY]).toBe("24000 USD per year (30000000 IDR per month)");
    expect(s.checked[REMOTE]).toEqual(["Yes"]);
    expect(s.selected[ZONE]).toEqual(["UTC+7 (Jakarta)"]);
    expect(s.checked[TOOLS]).toEqual(["Git", "Docker"]);
    expect(s.checked[STACK]).toEqual(["TypeScript"]);
    expect(s.selected[REGIONS]).toEqual(["Asia", "Europe"]);
    expect(s.files).toEqual(["fixture-resume.pdf"]);
    // Pronouns, the EEO survey and the marketing consent are left alone.
    expect(s.untouched).toEqual({ pronouns: 0, survey: 0, consent: 0 });

    // One page load, and zero non-GET requests reached the server: the page's own POSTs were aborted in the browser.
    expect(server.requests.filter((r) => r.path === LEVER_FIXTURE_FORM_PATH)).toEqual([
      { method: "GET", path: LEVER_FIXTURE_FORM_PATH },
    ]);
    expect(server.nonGet()).toEqual([]);
    expect(server.requests.some((r) => r.path === "/parseResume" || r.path === "/apply")).toBe(
      false,
    );
    expect(summary.aborted.map((a) => a.path)).toEqual(
      expect.arrayContaining(["/collect/pageview", "/parseResume"]),
    );
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
    expect(by("Full name")).toMatchObject({ source: "standard", answer_key: "profile.name" });
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
      ats_type: "lever",
      fixture: true,
      stop_reason: null,
    });

    const shot = join(dataDir, summary.screenshotPath);
    expect(existsSync(shot)).toBe(true);
    expect(statSync(shot).mode & 0o777).toBe(0o600);
    expect(statSync(join(shot, "..")).mode & 0o777).toBe(0o700);
  }, 90_000);
});

describe("questions read from the page are stored and matched", () => {
  it("stores the page's fields as lever posting_questions with options, never the EEO / pronouns / consent controls", async () => {
    await run();
    const rows = storedRows();
    expect(rows).toHaveLength(13);
    expect(rows.every((r) => r.ats_type === "lever")).toBe(true);
    const by = (id: string) => rows.find((r) => r.question_id === id);
    expect(by("name")).toMatchObject({
      label: "Full name",
      required: true,
      type: "text",
      options: null,
      matched_key: "standard.name",
    });
    expect(by("resume")).toMatchObject({ label: "Resume/CV", type: "file" });
    expect(by("urls[LinkedIn]")).toMatchObject({
      required: false,
      matched_key: "standard.linkedin",
    });
    expect(by(WHY)).toMatchObject({ type: "long_text", required: true, matched_key: null });
    expect(by(REMOTE)).toMatchObject({
      type: "yes_no",
      options: JSON.stringify(["Yes", "No"]),
    });
    expect(by(ZONE)).toMatchObject({
      type: "choice",
      options: JSON.stringify(["UTC+7 (Jakarta)", "UTC+1 (Berlin)", "UTC-5 (New York)"]),
    });
    expect(by(TOOLS)).toMatchObject({ type: "multi_choice" });
    expect(by(REGIONS)).toMatchObject({ type: "multi_choice" });
    expect(by(SALARY)).toMatchObject({ matched_key: "salary" });
    expect(
      rows.some((r) => /pronouns|surveysResponses|consent|baseTemplate/.test(r.question_id)),
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
    add("profile.name", null, "Alex Example");
    add("work.stack", "Which stack do you use most?", "TypeScript");

    const { summary } = await run(LEVER_FIXTURE_FORM_PATH, { context: () => undefined });
    expect(summary).toMatchObject({ status: "needs_input", stopReason: "uncovered_question" });

    const inbox = db.select().from(unknown_questions).all();
    expect(inbox.map((q) => q.normalized_label)).toEqual(
      expect.arrayContaining(["why do you want to work here", "which tools do you use"]),
    );
    expect(inbox.every((q) => q.status === "open")).toBe(true);
    expect(storedRows().find((q) => q.question_id === STACK)?.matched_key).toBe("work.stack");
    // The stack question matched an approved answer but has no approved mapping for this option set yet.
    const need = listMappingNeeds(db).find((n) => n.answerKey === "work.stack");
    expect(need).toMatchObject({
      label: "Which stack do you use most?",
      options: ["TypeScript", "Go", "Python"],
      multi: false,
    });
    expect(
      questionCounts(db, [LEVER_FIXTURE_POSTING_ID]).get(LEVER_FIXTURE_POSTING_ID),
    ).toMatchObject({
      total: 13,
      needsMapping: 1,
    });
  }, 90_000);
});

describe("needs_input (owner answer on gate t_2c20b3fa, question 4)", () => {
  it("an uncovered question stays empty, the rest is filled, the label goes to the Inbox", async () => {
    const { summary, seen } = await run(LEVER_FIXTURE_FORM_PATH, {
      context: without("work.why"),
    });
    expect(summary).toMatchObject({
      status: "needs_input",
      stopReason: "uncovered_question",
      filled: 12,
      total: 13,
    });
    const s = seen as unknown as Seen;
    expect(s.texts[WHY]).toBe("");
    expect(s.texts["name"]).toBe("Alex Example");
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
    const { summary, seen } = await run(LEVER_FIXTURE_FORM_PATH, {
      context: (c) => ({ ...c, choiceMappings: new Map() }),
    });
    expect(summary).toMatchObject({ status: "needs_input", stopReason: "choice_unmapped" });
    const s = seen as unknown as Seen;
    expect(s.selected[ZONE]).toEqual([]);
    expect(s.selected[REGIONS]).toEqual([]);
    expect(s.checked[TOOLS]).toEqual([]);
    expect(s.checked[STACK]).toEqual([]);
    expect(s.checked[REMOTE]).toEqual(["Yes"]); // yes / no needs no mapping
    expect(s.texts["email"]).not.toBe("");
  }, 90_000);

  it("no tier ask: the salary field stays empty; a missing resume file leaves the upload empty", async () => {
    const { summary, seen } = await run(LEVER_FIXTURE_FORM_PATH, {
      context: (c) => ({ ...c, ask: null }),
    });
    expect(summary).toMatchObject({ status: "needs_input", stopReason: "uncovered_question" });
    expect((seen as unknown as Seen).texts[SALARY]).toBe("");

    resetRunLimit();
    const missing = await run(LEVER_FIXTURE_FORM_PATH, {
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
    const { summary } = await run(LEVER_FIXTURE_FORM_PATH, {
      context: (c) => ({
        ...c,
        answers: c.answers.map((a) =>
          a.key === "work.why" ? { ...a, answer: "x".repeat(600) } : a,
        ),
      }),
    });
    expect(summary).toMatchObject({ status: "needs_input", filled: 12, total: 13 });
    const row = fieldsOf(summary.runId).find((r) => r.label === "Why do you want to work here?");
    expect(row).toMatchObject({ filled: false, value: null, source: "answer" });
    expect(row?.note).toMatch(/page (kept a different value|refused the value)/);
    expect(runOf(summary.runId)?.stop_detail).toBe("1 field(s) need input; the page refused 1");
  }, 90_000);

  it("the location input clears itself without a picked suggestion (as on the real page): that field needs input", async () => {
    const { summary, seen } = await run(LEVER_FIXTURE_LOCATION_PATH);
    expect(summary).toMatchObject({ status: "needs_input", filled: 13, total: 14 });
    expect((seen as unknown as Seen).texts["name"]).toBe("Alex Example");
    const row = fieldsOf(summary.runId).find((r) => r.label === "Current location");
    expect(row).toMatchObject({ filled: false, value: null, source: "standard" });
    expect(row?.note).toBe("page kept a different value");
  }, 90_000);
});

describe("stops (nothing is filled)", () => {
  async function stopped(out: Promise<Out>, reason: string): Promise<Out> {
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
      run(LEVER_FIXTURE_FORM_PATH, { context: (c) => ({ ...c, scamFlagged: true }) }),
      "other",
    );
    expect(runOf(r.summary.runId)?.stop_detail).toBe("scam flagged");
  }, 90_000);

  it("an unsupported field type", async () => {
    const r = await stopped(run(LEVER_FIXTURE_DATE_PATH), "unexpected_field");
    expect(runOf(r.summary.runId)?.stop_detail).toBe("Available start date");
    expect(storedRows().find((q) => q.label === "Available start date")).toMatchObject({
      type: "other",
    });
  }, 90_000);

  it("a field that matches two answers", async () => {
    const r = await stopped(
      run(LEVER_FIXTURE_FORM_PATH, {
        context: (c) => ({
          ...c,
          answers: [
            ...c.answers,
            {
              key: "contact.mail",
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
    const r = await stopped(run(LEVER_FIXTURE_CAPTCHA_PATH), "captcha");
    expect(runOf(r.summary.runId)?.stop_detail).toBe("captcha script or widget on the page");
    expect(storedRows()).toEqual([]);
  }, 90_000);

  it("a page without the application form", async () => {
    const r = await run("/acme/nothing/apply");
    expect(r.summary).toMatchObject({ status: "error", stopReason: "page_error", filled: 0 });
    expect(r.seen).toBeNull();
    expect(storedRows()).toEqual([]);
  }, 90_000);

  it("a changed form: the page differs from the last stored fields; labels of the changes, no values; then the new set is stored", async () => {
    const first = await run();
    expect(first.summary.status).toBe("filled");
    const before = storedRows();
    expect(before).toHaveLength(13);

    resetRunLimit();
    const r = await stopped(run(LEVER_FIXTURE_CHANGED_PATH), "form_changed");
    const detail = runOf(r.summary.runId)?.stop_detail ?? "";
    expect(detail).toBe(
      "form changed (missing: Expected salary (USD per year); extra: Do you need visa sponsorship?; different: Preferred time zone, LinkedIn profile)",
    );
    expect(detail).not.toMatch(/Alex|example\.test/);

    // The changed set replaced the stored one (so its new question is matched and reaches the Inbox) and the next
    // run on that page is compared with it.
    const after = storedRows();
    expect(after.map((q) => q.question_id)).toContain(`${CARD}[field7]`);
    expect(after.map((q) => q.question_id)).not.toContain(SALARY);
    expect(
      db
        .select()
        .from(unknown_questions)
        .where(eq(unknown_questions.normalized_label, "do you need visa sponsorship"))
        .get(),
    ).toMatchObject({ status: "open" });
    resetRunLimit();
    const again = await runLeverDryRun({
      db,
      dataDir,
      postingId: LEVER_FIXTURE_POSTING_ID,
      url: `${server.origin}${LEVER_FIXTURE_CHANGED_PATH}`,
      fixture: true,
      context: leverFixtureContext(dataDir),
    });
    expect(again.status).toBe("needs_input"); // the visa question has no answer yet
    expect(again.stopReason).toBe("uncovered_question");
  }, 180_000);

  it("a changed required flag or option set alone is a change", async () => {
    await run();
    db.update(posting_questions)
      .set({ required: false })
      .where(
        and(
          eq(posting_questions.posting_id, LEVER_FIXTURE_POSTING_ID),
          eq(posting_questions.question_id, "email"),
        ),
      )
      .run();
    resetRunLimit();
    const r = await stopped(run(), "form_changed");
    expect(runOf(r.summary.runId)?.stop_detail).toBe("form changed (different: Email)");
  }, 120_000);
});

describe("refusals before a browser opens", () => {
  const base = () => ({ db, dataDir, postingId: LEVER_FIXTURE_POSTING_ID });
  it("fixture mode only opens 127.0.0.1; a real run only a Lever apply page over https", async () => {
    await expect(
      runLeverDryRun({
        ...base(),
        url: "https://jobs.lever.co/acme/1/apply",
        fixture: true,
      }),
    ).rejects.toThrow(HarnessRefusalError);
    for (const url of [
      `${server.origin}${LEVER_FIXTURE_FORM_PATH}`,
      "http://jobs.lever.co/acme/1/apply",
      "https://jobs.lever.co.example.test/acme/1/apply",
      "https://job-boards.greenhouse.io/acme/jobs/1001",
    ])
      await expect(runLeverDryRun({ ...base(), url, fixture: false })).rejects.toThrow(
        /not a Lever apply page/,
      );
    expect(server.requests).toEqual([]);
  });
});
