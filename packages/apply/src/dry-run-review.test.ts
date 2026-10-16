import { beforeEach, describe, expect, it } from "vitest";
import { openDb, postings, type Db } from "@job-agent/core";
import { dryRunDoneWhen, reviewDryRun } from "./dry-run-review.ts";
import { recordDryRun } from "./dry-runs-store.ts";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
  db.insert(postings)
    .values({
      id: "p1",
      source: "greenhouse",
      external_id: "p1",
      url: "https://example.test/jobs/p1",
      title: "Engineer",
      company_name: "Acme",
      first_seen_at: "2026-10-13T00:00:00.000Z",
      last_seen_at: "2026-10-13T00:00:00.000Z",
      normalized_at: "2026-10-13T00:00:00.000Z",
    })
    .run();
});

function run(status: "filled" | "needs_input", fixture = false): string {
  return recordDryRun(db, {
    posting_id: "p1",
    ats_type: "greenhouse",
    started_at: "2026-10-16T08:00:00.000Z",
    finished_at: "2026-10-16T08:01:00.000Z",
    status,
    ...(status === "needs_input" ? { stop_reason: "uncovered_question" as const } : {}),
    fixture,
    fields: [],
  });
}

describe("dryRunDoneWhen", () => {
  it("starts at zero and not met", () => {
    expect(dryRunDoneWhen(db).line).toBe(
      "dry runs: 0 correct of 0 reviewed (0 full fills); done when 20 correct, at least 10 full fills: not met",
    );
  });

  it("fixture runs never count, reviewed or not", () => {
    for (let i = 0; i < 25; i++) reviewDryRun(db, run("filled", true), { review: "correct" });
    expect(dryRunDoneWhen(db)).toMatchObject({ correct: 0, reviewed: 0, fullFills: 0, met: false });
  });

  it("20 correct need at least 10 full fills; wrong and unreviewed runs do not count as correct", () => {
    for (let i = 0; i < 20; i++) reviewDryRun(db, run("needs_input"), { review: "correct" });
    reviewDryRun(db, run("filled"), { review: "wrong", reason: "wrong_value" });
    run("filled");
    // 20 correct, none full: not met.
    expect(dryRunDoneWhen(db)).toMatchObject({
      correct: 20,
      reviewed: 21,
      fullFills: 0,
      met: false,
    });
    for (let i = 0; i < 9; i++) reviewDryRun(db, run("filled"), { review: "correct" });
    expect(dryRunDoneWhen(db)).toMatchObject({ correct: 29, fullFills: 9, met: false });
    reviewDryRun(db, run("filled"), { review: "correct" });
    const done = dryRunDoneWhen(db);
    expect(done).toMatchObject({ correct: 30, reviewed: 31, fullFills: 10, met: true });
    expect(done.line).toBe(
      "dry runs: 30 correct of 31 reviewed (10 full fills); done when 20 correct, at least 10 full fills: met",
    );
  });

  it("19 correct with 10 full fills is not met", () => {
    for (let i = 0; i < 10; i++) reviewDryRun(db, run("filled"), { review: "correct" });
    for (let i = 0; i < 9; i++) reviewDryRun(db, run("needs_input"), { review: "correct" });
    expect(dryRunDoneWhen(db)).toMatchObject({ correct: 19, fullFills: 10, met: false });
  });

  it("changing a review from correct to wrong lowers the count", () => {
    const id = run("filled");
    reviewDryRun(db, id, { review: "correct" });
    reviewDryRun(db, id, { review: "wrong", reason: "page_broken" });
    expect(dryRunDoneWhen(db)).toMatchObject({ correct: 0, reviewed: 1 });
  });
});
