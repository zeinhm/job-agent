import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

  it("an edit plus approved:true in one request stores approved false; a separate approve sets it", async () => {
    await create({ approved: true });
    const edited = await patch({ alternatives: ["x?", "y?"], approved: true });
    expect(await edited.json()).toMatchObject({
      approved: false,
      approvedAt: null,
      alternatives: ["x?", "y?"],
    });
    const approved = await patch({ approved: true });
    expect(await approved.json()).toMatchObject({ approved: true, approvedAt: NOW.toISOString() });
  });

  // One case per approval-relevant field: each real change clears approval, also with approved:true.
  const FIELD_CHANGES: [string, Record<string, unknown>][] = [
    ["answer", { answer: "FAKE-ANSWER-one-month" }],
    ["question", { question: "New wording?" }],
    ["alternatives", { alternatives: ["When can you start?", "Another wording?"] }],
    ["type", { type: "long_text" }],
    ["choices", { type: "choice", choices: [NEW.answer, "b"] }],
  ];
  it.each(FIELD_CHANGES)("a real change to %s clears approval", async (_f, change) => {
    await create({ approved: true });
    const res = await patch(change);
    expect(await res.json()).toMatchObject({ approved: false, approvedAt: null });
  });
  it.each(FIELD_CHANGES)(
    "a real change to %s with approved:true still clears approval",
    async (_f, change) => {
      await create({ approved: true });
      const res = await patch({ ...change, approved: true });
      expect(await res.json()).toMatchObject({ approved: false, approvedAt: null });
    },
  );

  it("choices change alone on a choice answer clears approval", async () => {
    await create({
      approved: true,
      type: "choice",
      choices: ["a", "b"],
      answer: "a",
      alternatives: null,
    });
    expect(await (await patch({ choices: ["a", "b", "c"], approved: true })).json()).toMatchObject({
      approved: false,
    });
  });

  it("a no-op patch keeps approval; reordered or re-cased alternatives are unchanged", async () => {
    await create({ approved: true, alternatives: ["When can you start?", "Notice?"] });
    for (const noop of [
      { answer: NEW.answer },
      { question: NEW.question },
      { type: "text" },
      { alternatives: ["notice?", "When can you START?"] },
      { alternatives: ["When can you start?", "Notice?"], approved: true },
    ]) {
      expect(await (await patch(noop)).json()).toMatchObject({
        approved: true,
        approvedAt: NOW.toISOString(),
      });
    }
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
    await create({ answer: "a" });
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

  it("writes the file 0600, also over an existing 0644 file, and creates the dir 0700", async () => {
    await create({ approved: true });
    const exportsDir = join(dir, "exports");
    const file = join(exportsDir, "answers-2026-10-16.yaml");
    await mutate("POST", "/api/answers/export");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(exportsDir).mode & 0o777).toBe(0o700);
    writeFileSync(file, "old", { mode: 0o644 });
    chmodSync(file, 0o644);
    expect(statSync(file).mode & 0o777).toBe(0o644);
    await mutate("POST", "/api/answers/export");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain("notice_period");
    expect(readdirSync(exportsDir)).toEqual(["answers-2026-10-16.yaml"]);
  });

  it("the exported file loads back through the answers.yaml loader", async () => {
    await create({ approved: true });
    await create({
      key: "level",
      type: "choice",
      choices: ["a", "b"],
      answer: "a",
      alternatives: null,
    });
    await mutate("POST", "/api/answers/export");
    // loadAnswers reads <dir>/answers.yaml, so copy the export under that name.
    const loadDir = join(dir, "reload");
    mkdirSync(loadDir);
    copyFileSync(join(dir, "exports", "answers-2026-10-16.yaml"), join(loadDir, "answers.yaml"));
    expect(loadAnswers(loadDir, () => undefined)).toEqual([
      {
        key: "work_setup.level",
        group: "work_setup",
        answer: "a",
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
