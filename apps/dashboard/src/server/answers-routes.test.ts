import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAnswers } from "@job-agent/apply";
import { openDb, type Db } from "@job-agent/core";
import { createApp } from "./app.ts";

const PORT = 4510;
const HOST = `127.0.0.1:${PORT}`;
const NOW = new Date("2026-10-16T09:30:00.000Z");

let db: Db;
let dir: string;
let logs: string[];
beforeEach(() => {
  db = openDb(":memory:");
  dir = mkdtempSync(join(tmpdir(), "answers-export-"));
  logs = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const app = (exportsDir: string | null = join(dir, "exports")) =>
  createApp(db, {
    port: PORT,
    now: () => NOW,
    ...(exportsDir !== null ? { exportsDir } : {}),
    logError: (l) => logs.push(l),
  });
const mutate = (method: string, path: string, body?: unknown, a = app()) =>
  a.request(`http://x${path}`, {
    method,
    headers: { Host: HOST, "Content-Type": "application/json", Origin: `http://${HOST}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const get = (path: string) => app().request(`http://x${path}`, { headers: { Host: HOST } });

const NEW = {
  group: "work_setup",
  key: "notice_period",
  answer: "FAKE-ANSWER-two-weeks",
  question: "What is your notice period?",
  alternatives: ["When can you start?"],
  type: "text",
};
const create = (over: Record<string, unknown> = {}) =>
  mutate("POST", "/api/answers", { ...NEW, ...over });
const patch = (body: unknown, key = "work_setup.notice_period") =>
  mutate("PATCH", `/api/answers/${key}`, body);

describe("POST /api/answers", () => {
  it("creates a dashboard answer, not approved by default", async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      key: "work_setup.notice_period",
      group: "work_setup",
      answer: "FAKE-ANSWER-two-weeks",
      alternatives: ["When can you start?"],
      approved: false,
      approvedAt: null,
      source: "dashboard",
    });
  });

  it("approves on creation only when the request says so", async () => {
    const res = await create({ approved: true });
    expect(await res.json()).toMatchObject({ approved: true, approvedAt: NOW.toISOString() });
  });

  it("409 for an existing key, 400 for bad bodies without echoing values", async () => {
    await create();
    expect((await create()).status).toBe(409);
    const bad = await create({ group: "a.b", key: "SECRET-VALUE", extra: 1 });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).not.toContain("SECRET-VALUE");
    expect((await create({ key: "k2", type: "choice" })).status).toBe(400); // choice needs choices
    expect((await create({ key: "k3", choices: ["a"] })).status).toBe(400); // choices need type choice
    expect((await create({ key: "k4", answer: "" })).status).toBe(400);
  });

  it("rejects a mutation without the same-origin header", async () => {
    const res = await app().request("http://x/api/answers", {
      method: "POST",
      headers: { Host: HOST, "Content-Type": "application/json" },
      body: JSON.stringify(NEW),
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/answers", () => {
  it("lists answers sorted by group then key", async () => {
    await create({ group: "z", key: "a" });
    await create({ group: "a", key: "b" });
    await create({ group: "a", key: "a" });
    const res = await get("/api/answers");
    const body = (await res.json()) as { answers: { key: string }[] };
    expect(body.answers.map((a) => a.key)).toEqual(["a.a", "a.b", "z.a"]);
  });
});

describe("PATCH /api/answers/:key", () => {
  it("any edit sets source to dashboard", async () => {
    // A config row, as `answers import` would write it.
    await create();
    db.$client.prepare("update answer_bank set source = 'config'").run();
    const res = await patch({ question: "New wording?" });
    expect(await res.json()).toMatchObject({ source: "dashboard", question: "New wording?" });
  });

  it("changing the answer text clears approved", async () => {
    await create({ approved: true });
    const res = await patch({ answer: "FAKE-ANSWER-one-month" });
    expect(await res.json()).toMatchObject({
      answer: "FAKE-ANSWER-one-month",
      approved: false,
      approvedAt: null,
    });
  });

  it("changing the answer text and approving in the same request keeps it approved", async () => {
    await create();
    const res = await patch({ answer: "FAKE-ANSWER-one-month", approved: true });
    expect(await res.json()).toMatchObject({ approved: true, approvedAt: NOW.toISOString() });
  });

  it("re-sending the same text keeps approval; other fields keep it too", async () => {
    await create({ approved: true });
    expect(await (await patch({ answer: NEW.answer })).json()).toMatchObject({ approved: true });
    expect(await (await patch({ alternatives: ["x?", "y?"] })).json()).toMatchObject({
      approved: true,
      alternatives: ["x?", "y?"],
    });
  });

  it("toggles approval off and on", async () => {
    await create({ approved: true });
    expect(await (await patch({ approved: false })).json()).toMatchObject({
      approved: false,
      approvedAt: null,
    });
    expect(await (await patch({ approved: true })).json()).toMatchObject({ approved: true });
  });

  it("edits type and choices together, validating the combination", async () => {
    await create();
    const ok = await patch({ type: "choice", choices: ["a", "b"] });
    expect(await ok.json()).toMatchObject({ type: "choice", choices: ["a", "b"] });
    expect((await patch({ choices: null })).status).toBe(400);
    const back = await patch({ type: "text", choices: null });
    expect(await back.json()).toMatchObject({ type: "text", choices: null });
    expect((await patch({ type: "choice" })).status).toBe(400);
  });

  it("404 for an unknown key, 400 for an unknown field or malformed key", async () => {
    expect((await patch({ answer: "x" }, "no.such")).status).toBe(404);
    await create();
    expect((await patch({ source: "config" })).status).toBe(400);
    expect((await patch({ answer: "" })).status).toBe(400);
    expect((await patch({ answer: "x" }, "nodot")).status).toBe(400);
  });
});

describe("POST /api/answers/export", () => {
  it("writes answers-<date>.yaml into the exports dir and returns only path and count", async () => {
    await create({ approved: true });
    await create({ group: "links", key: "site", answer: "https://example.com", question: null });
    const exportsDir = join(dir, "exports");
    const res = await mutate("POST", "/api/answers/export");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ path: join(exportsDir, "answers-2026-10-16.yaml"), count: 2 });
    expect(readdirSync(exportsDir)).toEqual(["answers-2026-10-16.yaml"]);
    const text = readFileSync(join(exportsDir, "answers-2026-10-16.yaml"), "utf8");
    expect(text).toContain("work_setup:\n  notice_period:\n    answer: FAKE-ANSWER-two-weeks");
  });

  it("the exported file loads back through the answers.yaml loader", async () => {
    await create({ approved: true });
    await create({ key: "level", type: "choice", choices: ["a", "b"], alternatives: null });
    await mutate("POST", "/api/answers/export");
    // loadAnswers reads <dir>/answers.yaml, so copy the export under that name.
    const loadDir = join(dir, "reload");
    mkdirSync(loadDir);
    copyFileSync(join(dir, "exports", "answers-2026-10-16.yaml"), join(loadDir, "answers.yaml"));
    expect(loadAnswers(loadDir, () => undefined)).toEqual([
      {
        key: "work_setup.level",
        group: "work_setup",
        answer: NEW.answer,
        approved: false,
        question: NEW.question,
        alternatives: null,
        type: "choice",
        choices: ["a", "b"],
      },
      {
        key: "work_setup.notice_period",
        group: "work_setup",
        answer: NEW.answer,
        approved: true,
        question: NEW.question,
        alternatives: ["When can you start?"],
        type: "text",
        choices: null,
      },
    ]);
  });

  it("never writes inside config/: the path is under the exports dir, outside any config dir", async () => {
    await create();
    const res = await mutate("POST", "/api/answers/export");
    const { path } = (await res.json()) as { path: string };
    expect(resolve(path).startsWith(resolve(dir) + sep)).toBe(true);
    expect(resolve(path).split(sep)).not.toContain("config");
    expect(logs).toEqual([]);
  });

  it("500 and a route-only log line when no exports dir is configured", async () => {
    const res = await mutate("POST", "/api/answers/export", undefined, app(null));
    expect(res.status).toBe(500);
    expect(logs).toEqual(["dashboard error /api/answers/export 500"]);
  });
});
