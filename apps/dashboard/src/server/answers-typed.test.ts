import { beforeEach, describe, expect, it } from "vitest";
import { openDb, unknown_questions, type Db } from "@job-agent/core";
import { createApp } from "./app.ts";

const PORT = 4511;
const HOST = `127.0.0.1:${PORT}`;
const NOW = new Date("2026-10-16T09:30:00.000Z");

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

const mutate = (method: string, path: string, body?: unknown) =>
  createApp(db, { port: PORT, now: () => NOW, logError: () => undefined }).request(
    `http://x${path}`,
    {
      method,
      headers: { Host: HOST, "Content-Type": "application/json", Origin: `http://${HOST}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
  );

const BASE = { group: "work_setup", key: "notice_period", answer: "FAKE-two-weeks", type: "text" };
const create = (over: Record<string, unknown> = {}) =>
  mutate("POST", "/api/answers", { ...BASE, ...over });
const patch = (body: unknown) => mutate("PATCH", "/api/answers/work_setup.notice_period", body);
const rows = () => db.$client.prepare("select * from answer_bank").all();
const invalid = (rule: string, path = "answer") => ({
  error: "invalid request",
  issues: [{ path, rule }],
});

const MISFITS: [string, Record<string, unknown>, string][] = [
  ["yes_no", { type: "yes_no", answer: "banana" }, "yes_no"],
  ["number", { type: "number", answer: "banana" }, "number"],
  ["choice", { type: "choice", choices: ["a", "b"], answer: "banana" }, "choice_member"],
  ["text", { type: "text", answer: "   " }, "non_empty"],
  ["no type", { type: null, answer: "   " }, "non_empty"],
];

describe("POST /api/answers typed validation", () => {
  it.each(MISFITS)("refuses a misfit %s answer, naming field and rule", async (_t, o, rule) => {
    const res = await create({ ...o, approved: true });
    expect(res.status).toBe(400);
    const text = JSON.stringify(await res.json());
    expect(JSON.parse(text)).toEqual(invalid(rule));
    expect(text).not.toContain("banana");
    expect(rows()).toHaveLength(0);
  });

  it("stores fitting yes_no, number and choice answers", async () => {
    expect((await create({ key: "a", type: "yes_no", answer: "Yes" })).status).toBe(201);
    expect((await create({ key: "b", type: "number", answer: "4.5" })).status).toBe(201);
    const c = await create({ key: "c", type: "choice", choices: ["X y"], answer: "x Y" });
    expect(c.status).toBe(201);
  });
});

describe("PATCH /api/answers/:key typed validation", () => {
  it("refuses banana on a yes_no answer, also with approved:true; nothing changes", async () => {
    await create({ type: "yes_no", answer: "yes", approved: true });
    const before = rows();
    for (const body of [{ answer: "banana" }, { answer: "banana", approved: true }]) {
      const res = await patch(body);
      expect(res.status).toBe(400);
      const text = JSON.stringify(await res.json());
      expect(JSON.parse(text)).toEqual(invalid("yes_no"));
      expect(text).not.toContain("banana");
    }
    expect(rows()).toEqual(before);
  });

  it.each([
    ["yes_no", { type: "yes_no" }, "yes_no"],
    ["number", { type: "number" }, "number"],
    ["choice", { type: "choice", choices: ["a", "b"] }, "choice_member"],
  ])("refuses a type change to %s the stored answer does not fit", async (_t, change, rule) => {
    await create({ approved: true });
    const before = rows();
    const res = await patch(change);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(invalid(rule));
    expect(rows()).toEqual(before);
  });

  it("refuses choices that drop the stored answer, accepts ones that keep it", async () => {
    await create({ type: "choice", choices: ["a", "b"], answer: "a", approved: true });
    const before = rows();
    const res = await patch({ choices: ["b", "c"] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(invalid("choice_member"));
    expect(rows()).toEqual(before);
    expect((await patch({ choices: ["a", "c"] })).status).toBe(200);
  });

  it("never approves a misfit stored answer (approve action), while other edits still save", async () => {
    await create({ type: "yes_no", answer: "yes" });
    db.$client.prepare("update answer_bank set answer = 'banana'").run();
    const res = await patch({ approved: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(invalid("yes_no"));
    expect(rows()).toMatchObject([{ approved: 0, approved_at: null }]);
    expect((await patch({ question: "Notice?" })).status).toBe(200);
    expect(rows()).toMatchObject([{ approved: 0 }]);
    expect((await patch({ answer: "no" })).status).toBe(200);
    expect(await (await patch({ approved: true })).json()).toMatchObject({ approved: true });
  });
});

describe("inbox answer typed validation", () => {
  it("still refuses a misfit typed answer and stores nothing", async () => {
    db.insert(unknown_questions)
      .values({
        id: "q1",
        label: "Are you ok?",
        normalized_label: "are you ok",
        posting_count: 1,
        first_seen_at: NOW.toISOString(),
        last_seen_at: NOW.toISOString(),
      })
      .run();
    const res = await mutate("POST", "/api/inbox/q1/answer", {
      group: "g",
      key: "k",
      type: "yes_no",
      answer: "banana",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(invalid("yes_no"));
    expect(rows()).toHaveLength(0);
  });
});
