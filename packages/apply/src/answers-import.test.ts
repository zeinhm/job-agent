import { eq } from "drizzle-orm";
import { answer_bank, openDb, type Db } from "@job-agent/core";
import { beforeEach, describe, expect, it } from "vitest";
import type { AnswerEntry } from "./answers.ts";
import { importAnswers } from "./answers-import.ts";
import { updateAnswer } from "./answers-store.ts";

const T1 = new Date("2026-10-15T10:00:00Z");
const T2 = new Date("2026-10-16T10:00:00Z");

const entry = (over: Partial<AnswerEntry> = {}): AnswerEntry => ({
  key: "work_setup.notice_period",
  group: "work_setup",
  answer: "FAKE-ANSWER-two-weeks",
  approved: true,
  question: "What is your notice period?",
  alternatives: ["When can you start?"],
  type: "text",
  choices: null,
  ...over,
});

let db: Db;
let lines: string[];
const out = (l: string): void => void lines.push(l);
const rows = () => db.select().from(answer_bank).all();

beforeEach(() => {
  db = openDb(":memory:");
  lines = [];
});

describe("importAnswers", () => {
  it("adds new entries as source config and prints the summary", () => {
    const s = importAnswers(
      db,
      [entry(), entry({ key: "g.k", group: "g", approved: false })],
      out,
      T1,
    );
    expect(s).toEqual({ added: 2, updated: 0, unchanged: 0, kept: 0 });
    expect(lines).toEqual(["answers import: 2 added, 0 updated, 0 unchanged, 0 kept"]);
    const row = rows().find((r) => r.key === "work_setup.notice_period");
    expect(row).toMatchObject({
      group: "work_setup",
      source: "config",
      approved: true,
      approved_at: T1.toISOString(),
      updated_at: T1.toISOString(),
      alternatives: '["When can you start?"]',
      choices: null,
    });
    expect(rows().find((r) => r.key === "g.k")?.approved_at).toBeNull();
  });

  it("is a no-op on a re-run with no change", () => {
    importAnswers(db, [entry()], out, T1);
    const before = rows();
    lines = [];
    const s = importAnswers(db, [entry()], out, T2);
    expect(s).toEqual({ added: 0, updated: 0, unchanged: 1, kept: 0 });
    expect(lines).toEqual(["answers import: 0 added, 0 updated, 1 unchanged, 0 kept"]);
    expect(rows()).toEqual(before);
  });

  it("updates a changed config row and keeps approved_at stable while approved", () => {
    importAnswers(db, [entry()], out, T1);
    lines = [];
    const s = importAnswers(db, [entry({ answer: "FAKE-ANSWER-four-weeks" })], out, T2);
    expect(s).toEqual({ added: 0, updated: 1, unchanged: 0, kept: 0 });
    expect(rows()[0]).toMatchObject({
      answer: "FAKE-ANSWER-four-weeks",
      approved_at: T1.toISOString(),
      updated_at: T2.toISOString(),
    });
  });

  it("sets approved_at when approval turns on and clears it when it turns off", () => {
    importAnswers(db, [entry({ approved: false })], out, T1);
    importAnswers(db, [entry({ approved: true })], out, T2);
    expect(rows()[0]).toMatchObject({ approved: true, approved_at: T2.toISOString() });
    importAnswers(db, [entry({ approved: false })], out, T2);
    expect(rows()[0]).toMatchObject({ approved: false, approved_at: null });
  });

  it("updates when only alternatives, choices or type change", () => {
    importAnswers(db, [entry()], out, T1);
    const s = importAnswers(
      db,
      [entry({ type: "choice", choices: ["a", "b"], alternatives: null })],
      out,
      T2,
    );
    expect(s.updated).toBe(1);
    expect(rows()[0]).toMatchObject({ type: "choice", choices: '["a","b"]', alternatives: null });
  });

  it("never overwrites a dashboard row and prints its key", () => {
    importAnswers(db, [entry()], out, T1);
    db.update(answer_bank)
      .set({ source: "dashboard", answer: "FAKE-DASHBOARD-EDIT" })
      .where(eq(answer_bank.key, "work_setup.notice_period"))
      .run();
    lines = [];
    const s = importAnswers(db, [entry({ answer: "FAKE-ANSWER-changed" })], out, T2);
    expect(s).toEqual({ added: 0, updated: 0, unchanged: 0, kept: 1 });
    expect(lines).toEqual([
      "kept dashboard version: work_setup.notice_period",
      "answers import: 0 added, 0 updated, 0 unchanged, 1 kept",
    ]);
    expect(rows()[0]).toMatchObject({ source: "dashboard", answer: "FAKE-DASHBOARD-EDIT" });
  });

  it("does not re-approve an approved answer the dashboard edited, even if the file says approved", () => {
    importAnswers(db, [entry()], out, T1);
    updateAnswer(db, "work_setup.notice_period", { alternatives: ["Notice?"] }, T1);
    expect(rows()[0]).toMatchObject({ approved: false, approved_at: null, source: "dashboard" });
    importAnswers(db, [entry({ approved: true })], out, T2);
    expect(rows()[0]).toMatchObject({
      approved: false,
      approved_at: null,
      alternatives: '["Notice?"]',
    });
  });

  it("leaves rows missing from the file alone", () => {
    importAnswers(db, [entry()], out, T1);
    importAnswers(db, [], out, T2);
    expect(rows()).toHaveLength(1);
  });

  it("prints no answer, question or alternative text", () => {
    importAnswers(db, [entry(), entry({ key: "g.k", group: "g", answer: "FAKE-OTHER" })], out, T1);
    importAnswers(db, [entry({ answer: "FAKE-ANSWER-changed" })], out, T2);
    db.update(answer_bank).set({ source: "dashboard" }).where(eq(answer_bank.key, "g.k")).run();
    importAnswers(db, [entry({ key: "g.k", group: "g", answer: "FAKE-NEW" })], out, T2);
    const all = lines.join("\n");
    expect(all).not.toMatch(/FAKE-|notice period|start\?/);
  });
});
