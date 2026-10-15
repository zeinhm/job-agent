import { eq } from "drizzle-orm";
import {
  answer_bank,
  openDb,
  posting_questions,
  postings,
  unknown_questions,
  type Db,
} from "@job-agent/core";
import { beforeEach, describe, expect, it } from "vitest";
import { matchQuestions, questionCounts } from "./match-questions.ts";

let db: Db;
let n: number;

beforeEach(() => {
  db = openDb(":memory:");
  n = 0;
});

function addPosting(): string {
  const id = `p${++n}`;
  db.insert(postings)
    .values({
      id,
      source: "greenhouse",
      external_id: id,
      url: `https://example.test/jobs/${id}`,
      title: `Engineer ${id}`,
      company_name: "Acme",
      first_seen_at: "2026-10-13T00:00:00.000Z",
      last_seen_at: "2026-10-13T00:00:00.000Z",
      normalized_at: "2026-10-13T00:00:00.000Z",
    })
    .run();
  return id;
}

let q = 0;
function addQuestion(postingId: string, label: string, fetchedAt = "2026-10-13T01:00:00.000Z") {
  const id = `q${++q}`;
  db.insert(posting_questions)
    .values({
      id,
      posting_id: postingId,
      ats_type: "greenhouse",
      question_id: id,
      label,
      required: false,
      type: "text",
      normalized_label: label
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim(),
      fetched_at: fetchedAt,
    })
    .run();
  return id;
}

function addAnswer(key: string, question: string, approved: boolean) {
  db.insert(answer_bank)
    .values({
      id: key,
      key,
      group: key.split(".")[0] ?? "g",
      question,
      answer: "FAKE-ANSWER",
      approved,
      source: "config",
      updated_at: "2026-10-13T00:00:00.000Z",
    })
    .run();
}

const keys = () =>
  Object.fromEntries(
    db
      .select()
      .from(posting_questions)
      .all()
      .map((r) => [r.question_id, r.matched_key]),
  );

describe("matchQuestions", () => {
  it("covers approved answers and standard fields, flags salary, inboxes the rest", () => {
    addAnswer("work.notice", "What is your notice period?", true);
    const a = addPosting();
    const b = addPosting();
    const q1 = addQuestion(a, "What is your notice period? *");
    const q2 = addQuestion(a, "Email");
    const q3 = addQuestion(a, "Salary expectations");
    const q4 = addQuestion(a, "Favourite editor?");
    const q5 = addQuestion(b, "Favourite editor");
    const summary = matchQuestions(db);
    expect(summary).toMatchObject({
      questions: 5,
      covered: 2,
      salary: 1,
      unknown: 2,
      unknownWordings: 1,
    });
    expect(keys()).toEqual({
      [q1]: "work.notice",
      [q2]: "standard.email",
      [q3]: "salary",
      [q4]: null,
      [q5]: null,
    });
    expect(questionCounts(db, [a, b, "none"])).toEqual(
      new Map([
        [a, { total: 4, covered: 2, unknown: 1, salary: 1 }],
        [b, { total: 1, covered: 0, unknown: 1, salary: 0 }],
        ["none", { total: 0, covered: 0, unknown: 0, salary: 0 }],
      ]),
    );
    const inbox = db.select().from(unknown_questions).all();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      normalized_label: "favourite editor",
      label: "Favourite editor?",
      posting_count: 2,
      status: "open",
    });
  });

  it("does not cover a question with an unapproved answer", () => {
    addAnswer("work.notice", "What is your notice period?", false);
    const q1 = addQuestion(addPosting(), "What is your notice period?");
    matchQuestions(db);
    expect(keys()[q1]).toBeNull();
    expect(db.select().from(unknown_questions).all()).toHaveLength(1);
  });

  it("never answers a salary question from the bank", () => {
    addAnswer("money.pay", "What are your salary expectations?", true);
    const q1 = addQuestion(addPosting(), "What are your salary expectations?");
    matchQuestions(db);
    expect(keys()[q1]).toBe("salary");
    expect(db.select().from(unknown_questions).all()).toHaveLength(0);
  });

  it("is idempotent: a second run changes nothing", () => {
    addAnswer("work.notice", "What is your notice period?", true);
    const a = addPosting();
    addQuestion(a, "What is your notice period?");
    addQuestion(a, "Favourite editor?");
    matchQuestions(db);
    const before = {
      pq: db.select().from(posting_questions).all(),
      uq: db.select().from(unknown_questions).all(),
    };
    const again = matchQuestions(db);
    expect(again.changed).toBe(0);
    expect(db.select().from(posting_questions).all()).toEqual(before.pq);
    expect(db.select().from(unknown_questions).all()).toEqual(before.uq);
  });

  it("un-covers questions when their answer becomes unapproved", () => {
    addAnswer("work.notice", "What is your notice period?", true);
    const a = addPosting();
    const q1 = addQuestion(a, "What is your notice period?");
    matchQuestions(db);
    expect(keys()[q1]).toBe("work.notice");
    expect(questionCounts(db, [a]).get(a)).toMatchObject({ covered: 1, unknown: 0 });
    expect(db.select().from(unknown_questions).all()).toHaveLength(0);

    db.update(answer_bank).set({ approved: false }).where(eq(answer_bank.key, "work.notice")).run();
    const s = matchQuestions(db);
    expect(s.changed).toBe(1);
    expect(keys()[q1]).toBeNull();
    expect(questionCounts(db, [a]).get(a)).toMatchObject({ covered: 0, unknown: 1 });
    expect(db.select().from(unknown_questions).all()).toHaveLength(1);
  });

  it("drops an open inbox row once approved, but keeps a dismissed one with a zero count", () => {
    const a = addPosting();
    addQuestion(a, "Notice period?");
    addQuestion(a, "Pronouns?");
    matchQuestions(db);
    db.update(unknown_questions)
      .set({ status: "dismissed" })
      .where(eq(unknown_questions.normalized_label, "pronouns"))
      .run();
    addAnswer("work.notice", "Notice period?", true);
    addAnswer("misc.pronouns", "Pronouns?", true);
    matchQuestions(db);
    const rows = db.select().from(unknown_questions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      normalized_label: "pronouns",
      status: "dismissed",
      posting_count: 0,
    });
  });

  it("tracks first and last seen from fetched_at and keeps the earliest first seen", () => {
    const a = addPosting();
    const b = addPosting();
    addQuestion(a, "Favourite editor?", "2026-10-13T01:00:00.000Z");
    matchQuestions(db);
    addQuestion(b, "Favourite editor?", "2026-10-15T01:00:00.000Z");
    matchQuestions(db);
    expect(db.select().from(unknown_questions).get()).toMatchObject({
      posting_count: 2,
      first_seen_at: "2026-10-13T01:00:00.000Z",
      last_seen_at: "2026-10-15T01:00:00.000Z",
    });
  });
});
