import { beforeEach, describe, expect, it } from "vitest";
import { matchQuestions, normalizeQuestion } from "@job-agent/apply";
import {
  answer_bank,
  choice_mappings,
  openDb,
  posting_questions,
  postings,
  type Db,
} from "@job-agent/core";
import { createApp } from "./app.ts";

const PORT = 4511;
const HOST = `127.0.0.1:${PORT}`;
const NOW = new Date("2026-10-16T09:30:00.000Z");
const LABEL = "What is your notice period?";
const OPTIONS = ["Immediately", "Within 1 month", "More than 1 month"];
const SECRET = "FAKE-SECRET-ANSWER-TEXT";

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
  for (const [key, question] of [
    ["work.notice", LABEL],
    ["pay.any", "Expected salary?"],
  ] as const) {
    db.insert(answer_bank)
      .values({
        id: key,
        key,
        group: key.split(".")[0] as string,
        question,
        answer: SECRET,
        approved: true,
        approved_at: "2026-10-13T00:00:00.000Z",
        source: "dashboard",
        updated_at: "2026-10-13T00:00:00.000Z",
      })
      .run();
  }
  const ask = (id: string, label: string, type: string, options: string[]) =>
    db
      .insert(posting_questions)
      .values({
        id,
        posting_id: "p1",
        ats_type: "greenhouse",
        question_id: id,
        label,
        required: false,
        type,
        options: JSON.stringify(options),
        normalized_label: normalizeQuestion(label),
        fetched_at: "2026-10-13T01:00:00.000Z",
      })
      .run();
  ask("q1", LABEL, "choice", OPTIONS);
  ask("q2", "Expected salary?", "choice", ["Low", "High"]);
  matchQuestions(db);
});

const app = () => createApp(db, { port: PORT, now: () => NOW, logError: () => {} });
const send = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app().request(`http://x${path}`, {
    method,
    headers: {
      Host: HOST,
      "Content-Type": "application/json",
      Origin: `http://${HOST}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
const post = (path: string, body: unknown) => send("POST", path, body);
const save = (over: Record<string, unknown> = {}) =>
  post("/api/choice-mappings", {
    answer_key: "work.notice",
    label: LABEL,
    options: OPTIONS,
    chosen: ["Within 1 month"],
    ...over,
  });
const get = (path: string) => app().request(`http://x${path}`, { headers: { Host: HOST } });

describe("choice mapping routes", () => {
  it("the inbox lists the choice question with its options and the approved answer text", async () => {
    const r = (await (await get("/api/inbox")).json()) as {
      items: unknown[];
      mappings: { label: string; options: string[]; answerText: string; answerKey: string }[];
    };
    expect(r.mappings).toHaveLength(1);
    expect(r.mappings[0]).toMatchObject({
      answerKey: "work.notice",
      label: LABEL,
      options: OPTIONS,
      answerText: SECRET,
    });
  });

  it("POST saves an approved mapping, re-matches, and the need leaves the inbox", async () => {
    const res = await save();
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      answerKey: "work.notice",
      chosen: ["Within 1 month"],
      approved: true,
    });
    const inbox = (await (await get("/api/inbox")).json()) as { mappings: unknown[] };
    expect(inbox.mappings).toEqual([]);
    const list = (await (await get("/api/choice-mappings")).json()) as {
      mappings: { chosen: string[]; options: string[] }[];
    };
    expect(list.mappings).toHaveLength(1);
    expect(list.mappings[0]?.options).toEqual(OPTIONS);
  });

  it("refuses an option the stored form does not list (400) without echoing it", async () => {
    const res = await save({ chosen: ["Tomorrow-FAKE"] });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain("Tomorrow-FAKE");
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toEqual({ error: "invalid request", issues: [{ path: "chosen" }] });
    expect(db.select().from(choice_mappings).all()).toHaveLength(0);
  });

  it("refuses a salary question with 400", async () => {
    const res = await save({
      answer_key: "pay.any",
      label: "Expected salary?",
      options: ["Low", "High"],
      chosen: ["Low"],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid request", issues: [{ path: "label" }] });
    expect(db.select().from(choice_mappings).all()).toHaveLength(0);
  });

  it("404 for a question no stored form asks, 400 for strict-body violations", async () => {
    expect((await save({ label: "Unknown?" })).status).toBe(404);
    expect((await save({ approved: true })).status).toBe(400);
    expect((await save({ chosen: [] })).status).toBe(400);
    expect((await save({ answer_key: "nodot" })).status).toBe(400);
    expect((await post("/api/choice-mappings", { chosen: ["x"] })).status).toBe(400);
  });

  it("keeps the same-origin and JSON guards", async () => {
    const body = {
      answer_key: "work.notice",
      label: LABEL,
      options: OPTIONS,
      chosen: [OPTIONS[0]],
    };
    expect(
      (await send("POST", "/api/choice-mappings", body, { Origin: "http://evil.test" })).status,
    ).toBe(403);
    expect(
      (await send("POST", "/api/choice-mappings", body, { "Content-Type": "text/plain" })).status,
    ).toBe(403);
    expect(
      (await send("POST", "/api/choice-mappings/remove", body, { Origin: "http://evil.test" }))
        .status,
    ).toBe(403);
    expect(db.select().from(choice_mappings).all()).toHaveLength(0);
  });

  it("remove deletes one mapping (404 when absent) and the question needs a mapping again", async () => {
    await save();
    const ref = { answer_key: "work.notice", label: LABEL, options: OPTIONS };
    expect((await post("/api/choice-mappings/remove", ref)).status).toBe(200);
    expect((await post("/api/choice-mappings/remove", ref)).status).toBe(404);
    expect((await post("/api/choice-mappings/remove", { ...ref, chosen: ["x"] })).status).toBe(400);
    const inbox = (await (await get("/api/inbox")).json()) as { mappings: unknown[] };
    expect(inbox.mappings).toHaveLength(1);
  });

  it("an answer edit that clears approval clears the mapping and the question needs one again", async () => {
    await save();
    const patch = await send("PATCH", "/api/answers/work.notice", { answer: "FAKE-NEW" });
    expect(patch.status).toBe(200);
    const list = (await (await get("/api/choice-mappings")).json()) as {
      mappings: { approved: boolean }[];
    };
    expect(list.mappings.map((m) => m.approved)).toEqual([false]);
    await send("PATCH", "/api/answers/work.notice", { approved: true });
    const inbox = (await (await get("/api/inbox")).json()) as {
      mappings: { picked: string[] | null }[];
    };
    expect(inbox.mappings).toHaveLength(1);
    expect(inbox.mappings[0]?.picked).toEqual(["Within 1 month"]);
  });
});
