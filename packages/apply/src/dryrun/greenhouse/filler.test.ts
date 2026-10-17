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
import { planFill, type PlannedField } from "../../fill-plan.ts";
import { loadStoredQuestions, runGreenhouseDryRun, type GreenhouseRunSummary } from "./filler.ts";
import {
  FIXTURE_CAPTCHA_PATH,
  FIXTURE_CHANGED_PATH,
  FIXTURE_FORM_PATH,
  FIXTURE_POSTING_ID,
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
      files: [...document.getElementById("resume").files].map((f) => f.name),
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
    expect(by("First Name")).toMatchObject({ source: "standard", answer_key: "profile.name" });
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
      context: (c) => without("work.why")(c),
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
        answers: c.answers.map((a) => (a.key === "work.why" ? { ...a, answer: long } : a)),
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
