import { eq } from "drizzle-orm";
import { openDb, posting_questions, postings, unknown_questions, type Db } from "@job-agent/core";
import { beforeEach, describe, expect, it } from "vitest";
import { listInbox } from "./inbox.ts";
import { matchQuestions, questionCounts } from "./match-questions.ts";

let db: Db;

function addPosting(id: string, canonical: string | null): void {
  db.insert(postings)
    .values({
      id,
      source: "recruitee",
      external_id: id,
      url: `https://example.test/o/${id}`,
      title: "Product Lead",
      company_name: "Acme",
      canonical_posting_id: canonical,
      first_seen_at: "2026-10-13T00:00:00.000Z",
      last_seen_at: "2026-10-13T00:00:00.000Z",
      normalized_at: "2026-10-13T00:00:00.000Z",
    })
    .run();
}

function addQuestion(postingId: string, label: string, n: number): void {
  db.insert(posting_questions)
    .values({
      id: `${postingId}-q${n}`,
      posting_id: postingId,
      ats_type: "recruitee",
      question_id: `q${n}`,
      label,
      required: false,
      type: "text",
      normalized_label: label.toLowerCase(),
      fetched_at: "2026-10-13T01:00:00.000Z",
    })
    .run();
}

beforeEach(() => {
  db = openDb(":memory:");
  addPosting("main", null);
  for (const v of ["uk", "india", "spain"]) addPosting(v, "main");
  for (const p of ["main", "uk", "india", "spain"]) {
    addQuestion(p, "favourite editor", 1);
    addQuestion(p, "favourite shell", 2);
  }
});

describe("questions of linked variants", () => {
  it("count once: only the canonical posting's rows are matched and inboxed", () => {
    const summary = matchQuestions(db);
    expect(summary).toMatchObject({ questions: 2, unknown: 2, unknownWordings: 2 });
    const open = db.select().from(unknown_questions).all();
    expect(open.map((r) => r.posting_count)).toEqual([1, 1]);
  });

  it("leaves the variants' own rows untouched", () => {
    matchQuestions(db);
    const variantRows = db
      .select()
      .from(posting_questions)
      .where(eq(posting_questions.posting_id, "uk"))
      .all();
    expect(variantRows).toHaveLength(2);
    expect(variantRows.every((r) => r.matched_key === null)).toBe(true);
  });

  it("inbox examples list the canonical posting, never a variant", () => {
    matchQuestions(db);
    const inbox = listInbox(db);
    expect(inbox.openCount).toBe(2);
    for (const item of inbox.items) {
      expect(item.postingCount).toBe(1);
      expect(item.examples.map((e) => e.postingId)).toEqual(["main"]);
    }
  });

  it("per-posting counts for the canonical posting are its own", () => {
    expect(questionCounts(db, ["main"]).get("main")?.total).toBe(2);
  });
});
