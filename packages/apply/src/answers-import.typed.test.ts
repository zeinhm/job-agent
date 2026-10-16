import { openDb, answer_bank } from "@job-agent/core";
import { describe, expect, it } from "vitest";
import type { AnswerEntry } from "./answers.ts";
import { importAnswers } from "./answers-import.ts";

const T1 = new Date("2026-10-15T10:00:00Z");
const entry = (over: Partial<AnswerEntry> = {}): AnswerEntry => ({
  key: "g.k",
  group: "g",
  answer: "FAKE-banana",
  approved: false,
  question: null,
  alternatives: null,
  type: "text",
  choices: null,
  ...over,
});

describe("importAnswers typed validation", () => {
  const bad: [string, Partial<AnswerEntry>, string][] = [
    ["yes_no", { type: "yes_no" }, "yes_no"],
    ["number", { type: "number" }, "number"],
    ["choice", { type: "choice", choices: ["a", "b"] }, "choice_member"],
    ["text", { answer: "  " }, "non_empty"],
  ];
  it.each(bad)(
    "throws for a misfit %s entry naming key path and rule, writes nothing",
    (_t, o, rule) => {
      const db = openDb(":memory:");
      const lines: string[] = [];
      const run = () =>
        importAnswers(
          db,
          [entry({ key: "g.ok", answer: "fine" }), entry({ key: "g.bad", ...o })],
          (l) => lines.push(l),
          T1,
        );
      expect(run).toThrow(`Answer g.bad is invalid: g.bad.answer: ${rule}`);
      expect(run).not.toThrow(/FAKE-/);
      expect(db.select().from(answer_bank).all()).toHaveLength(0);
      expect(lines).toEqual([]);
    },
  );

  it("accepts fitting typed entries", () => {
    const db = openDb(":memory:");
    const s = importAnswers(
      db,
      [
        entry({ key: "g.a", type: "yes_no", answer: "Yes" }),
        entry({ key: "g.b", type: "number", answer: "4.5" }),
        entry({ key: "g.c", type: "choice", choices: ["X y"], answer: "x Y" }),
      ],
      () => undefined,
      T1,
    );
    expect(s.added).toBe(3);
  });
});
