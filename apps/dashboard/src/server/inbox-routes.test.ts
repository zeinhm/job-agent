import { beforeEach, describe, expect, it } from "vitest";
import { matchQuestions } from "@job-agent/apply";
import { openDb, posting_questions, postings, unknown_questions, type Db } from "@job-agent/core";
import { createApp } from "./app.ts";

const PORT = 4510;
const HOST = `127.0.0.1:${PORT}`;
const NOW = new Date("2026-10-16T09:30:00.000Z");

let db: Db;
let n: number;
beforeEach(() => {
  db = openDb(":memory:");
  n = 0;
});

const app = () => createApp(db, { port: PORT, now: () => NOW, logError: () => {} });
const post = (path: string, body: unknown = {}) =>
  app().request(`http://x${path}`, {
    method: "POST",
    headers: { Host: HOST, "Content-Type": "application/json", Origin: `http://${HOST}` },
    body: JSON.stringify(body),
  });
const get = (path: string) => app().request(`http://x${path}`, { headers: { Host: HOST } });

function addPosting(): string {
  const id = `p${++n}`;
  db.insert(postings)
    .values({
      id,
      source: "greenhouse",
      external_id: id,
      url: `https://example.test/jobs/${id}`,
      title: `Engineer ${id}`,
      company_name: `Acme ${id}`,
      first_seen_at: "2026-10-13T00:00:00.000Z",
      last_seen_at: "2026-10-13T00:00:00.000Z",
      normalized_at: "2026-10-13T00:00:00.000Z",
    })
    .run();
  return id;
}

const matched = (key: string): number =>
  (
    db.$client
      .prepare("select count(*) as n from posting_questions where matched_key = ?")
      .get(key) as { n: number }
  ).n;

let q = 0;
function ask(postingId: string, label: string) {
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
      fetched_at: "2026-10-13T01:00:00.000Z",
    })
    .run();
}

interface Item {
  id: string;
  label: string;
  postingCount: number;
  salary: boolean;
  examples: { postingId: string }[];
}
async function inbox(): Promise<{ openCount: number; items: Item[] }> {
  return (await get("/api/inbox")).json() as Promise<{ openCount: number; items: Item[] }>;
}
const idOf = async (label: string) =>
  (await inbox()).items.find((i) => i.label === label)?.id ?? "";

/** Notice asked by 4 postings, remote by 2, visa by 1; one stored answer that "Work permit?" can link to. */
async function seed() {
  const ps = [addPosting(), addPosting(), addPosting(), addPosting()];
  for (const p of ps) ask(p, "What is your notice period?");
  for (const p of ps.slice(0, 2)) ask(p, "Open to remote work?");
  ask(ps[0] as string, "Work permit?");
  matchQuestions(db);
  const made = await post("/api/answers", {
    group: "legal",
    key: "visa",
    answer: "FAKE-ANSWER-no sponsorship needed",
    question: "Do you need visa sponsorship?",
    type: "text",
    approved: true,
  });
  expect(made.status).toBe(201);
}

describe("GET /api/inbox", () => {
  it("lists open wordings by posting count with up to 3 examples", async () => {
    await seed();
    const r = await inbox();
    expect(r.openCount).toBe(3);
    expect(r.items.map((i) => [i.label, i.postingCount])).toEqual([
      ["What is your notice period?", 4],
      ["Open to remote work?", 2],
      ["Work permit?", 1],
    ]);
    expect(r.items[0]?.examples).toHaveLength(3);
    expect(r.items[1]?.examples.map((e) => e.postingId).sort()).toEqual(["p1", "p2"]);
    expect(r.items.every((i) => !i.salary)).toBe(true);
  });

  it("is empty with no questions", async () => {
    expect(await inbox()).toEqual({ openCount: 0, items: [] });
  });
});

describe("POST /api/inbox/:id/answer", () => {
  const body = {
    group: "work_setup",
    key: "notice",
    answer: "30",
    type: "number",
  };

  it("creates a not-approved dashboard answer; wording stays uncovered but leaves the inbox", async () => {
    await seed();
    const id = await idOf("What is your notice period?");
    const res = await post(`/api/inbox/${id}/answer`, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ openCount: 2, key: "work_setup.notice" });
    const list = (await (await get("/api/answers")).json()) as {
      answers: { key: string; approved: boolean; question: string | null; source: string }[];
    };
    expect(list.answers.find((a) => a.key === "work_setup.notice")).toMatchObject({
      approved: false,
      question: "What is your notice period?",
      source: "dashboard",
    });
    expect(matched("work_setup.notice")).toBe(0);
  });

  it("approve: true covers every open posting that asks it, and the count drops", async () => {
    await seed();
    const id = await idOf("What is your notice period?");
    const res = await post(`/api/inbox/${id}/answer`, { ...body, answer: "30", approved: true });
    expect(await res.json()).toEqual({ openCount: 2, key: "work_setup.notice" });
    expect(matched("work_setup.notice")).toBe(4);
    expect((await inbox()).items.map((i) => i.label)).not.toContain("What is your notice period?");
  });

  it("rejects an answer that does not fit its type", async () => {
    await seed();
    const id = await idOf("What is your notice period?");
    const res = await post(`/api/inbox/${id}/answer`, { ...body, answer: "soon" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid request", issues: [{ path: "answer" }] });
    expect((await inbox()).openCount).toBe(3);
  });

  it("rejects a choice answer outside the choices and a missing type", async () => {
    await seed();
    const id = await idOf("Open to remote work?");
    const choice = {
      group: "g",
      key: "k",
      answer: "maybe",
      type: "choice",
      choices: ["yes", "no"],
    };
    expect((await post(`/api/inbox/${id}/answer`, choice)).status).toBe(400);
    expect(
      (await post(`/api/inbox/${id}/answer`, { group: "g", key: "k", answer: "x" })).status,
    ).toBe(400);
  });

  it("409 for a taken key leaves the wording open", async () => {
    await seed();
    const id = await idOf("Open to remote work?");
    const res = await post(`/api/inbox/${id}/answer`, {
      group: "legal",
      key: "visa",
      answer: "yes",
      type: "yes_no",
    });
    expect(res.status).toBe(409);
    expect((await inbox()).openCount).toBe(3);
  });

  it("404 for an unknown id, 409 once the wording was decided", async () => {
    await seed();
    expect((await post("/api/inbox/nope/answer", body)).status).toBe(404);
    const id = await idOf("What is your notice period?");
    expect((await post(`/api/inbox/${id}/answer`, body)).status).toBe(200);
    const again = await post(`/api/inbox/${id}/answer`, { ...body, key: "other" });
    expect(again.status).toBe(409);
  });

  it("refuses to answer a salary wording from the bank", async () => {
    const p = addPosting();
    ask(p, "Expected salary?");
    // matching files salary questions as `salary`; force the row an old build might have left behind.
    db.insert(unknown_questions)
      .values({
        id: "u-salary",
        normalized_label: "expected salary",
        label: "Expected salary?",
        posting_count: 1,
        first_seen_at: "2026-10-13T01:00:00.000Z",
        last_seen_at: "2026-10-13T01:00:00.000Z",
      })
      .run();
    expect((await inbox()).items[0]).toMatchObject({ salary: true });
    const res = await post("/api/inbox/u-salary/answer", {
      group: "pay",
      key: "ask",
      answer: "1",
      type: "number",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid request", issues: [{ path: "salary" }] });
    expect((await post("/api/inbox/u-salary/link", { key: "legal.visa" })).status).toBe(400);
  });
});

describe("salary wordings in the inbox", () => {
  const WORDINGS = [
    "How much do you expect to be paid?",
    "What is your expected base?",
    "Desired annual pay",
    "Berapa gaji yang Anda harapkan?",
    "Expected hourly rate",
    "Total cash expectation",
  ];

  it.each(WORDINGS)("400 salary for answer and link: %s", async (label) => {
    await seed();
    db.insert(unknown_questions)
      .values({
        id: "u-pay",
        normalized_label: label
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, " ")
          .trim(),
        label,
        posting_count: 1,
        first_seen_at: "2026-10-13T01:00:00.000Z",
        last_seen_at: "2026-10-13T01:00:00.000Z",
      })
      .run();
    expect((await inbox()).items.find((i) => i.id === "u-pay")?.salary).toBe(true);
    const answer = await post("/api/inbox/u-pay/answer", {
      group: "pay",
      key: "ask",
      answer: "1",
      type: "number",
    });
    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ error: "invalid request", issues: [{ path: "salary" }] });
    const link = await post("/api/inbox/u-pay/link", { key: "legal.visa" });
    expect(link.status).toBe(400);
    expect(await link.json()).toEqual({ error: "invalid request", issues: [{ path: "salary" }] });
  });
});

describe("POST /api/inbox/:id/link", () => {
  it("adds the wording as an alternative; an approved target then covers the postings", async () => {
    await seed();
    const id = await idOf("Work permit?");
    const res = await post(`/api/inbox/${id}/link`, { key: "legal.visa" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ openCount: 2, key: "legal.visa" });
    const answers = (await (await get("/api/answers")).json()) as {
      answers: { key: string; alternatives: string[] | null }[];
    };
    expect(answers.answers.find((a) => a.key === "legal.visa")?.alternatives).toEqual([
      "Work permit?",
    ]);
    expect(matched("legal.visa")).toBe(1);
  });

  it("does not duplicate a wording the answer already has", async () => {
    await seed();
    const id = await idOf("Work permit?");
    await app().request("http://x/api/answers/legal.visa", {
      method: "PATCH",
      headers: { Host: HOST, "Content-Type": "application/json", Origin: `http://${HOST}` },
      body: JSON.stringify({ alternatives: ["work permit"] }),
    });
    await post(`/api/inbox/${id}/link`, { key: "legal.visa" });
    const answers = (await (await get("/api/answers")).json()) as {
      answers: { key: string; alternatives: string[] | null }[];
    };
    expect(answers.answers.find((a) => a.key === "legal.visa")?.alternatives).toEqual([
      "work permit",
    ]);
  });

  it("404 for an unknown answer key, nothing decided", async () => {
    await seed();
    const id = await idOf("Work permit?");
    expect((await post(`/api/inbox/${id}/link`, { key: "no.such" })).status).toBe(404);
    expect((await inbox()).openCount).toBe(3);
  });

  it("400 for a body that is not just a key", async () => {
    await seed();
    const id = await idOf("Work permit?");
    expect((await post(`/api/inbox/${id}/link`, { key: "legal.visa", extra: 1 })).status).toBe(400);
  });
});

describe("POST /api/inbox/:id/dismiss", () => {
  it("removes the wording from the inbox for good, across a re-match", async () => {
    await seed();
    const id = await idOf("Open to remote work?");
    const res = await post(`/api/inbox/${id}/dismiss`);
    expect(await res.json()).toEqual({ openCount: 2, key: null });
    matchQuestions(db);
    expect((await inbox()).items.map((i) => i.label)).toEqual([
      "What is your notice period?",
      "Work permit?",
    ]);
    expect((await post(`/api/inbox/${id}/dismiss`)).status).toBe(409);
  });

  it("is blocked by the mutation guard without an Origin", async () => {
    await seed();
    const id = await idOf("Open to remote work?");
    const res = await app().request(`http://x/api/inbox/${id}/dismiss`, {
      method: "POST",
      headers: { Host: HOST, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });
});
