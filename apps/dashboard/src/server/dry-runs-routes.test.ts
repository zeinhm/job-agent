import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeQuestion, recordDryRun, type NewDryRunInput } from "@job-agent/apply";
import { openDb, postings, type Db } from "@job-agent/core";
import { createApp } from "./app.ts";

const PORT = 4512;
const HOST = `127.0.0.1:${PORT}`;
const NOW = new Date("2026-10-17T09:30:00.000Z");
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const FAKE_VALUE = "FAKE-FILLED-VALUE";

let db: Db;
let dataDir: string;
let outside: string;

function posting(id: string, title: string) {
  db.insert(postings)
    .values({
      id,
      source: "greenhouse",
      external_id: id,
      url: `https://example.test/jobs/${id}`,
      title,
      company_name: "Acme",
      first_seen_at: "2026-10-13T00:00:00.000Z",
      last_seen_at: "2026-10-13T00:00:00.000Z",
      normalized_at: "2026-10-13T00:00:00.000Z",
    })
    .run();
}

function run(over: Partial<NewDryRunInput> = {}): string {
  return recordDryRun(db, {
    posting_id: "p1",
    ats_type: "greenhouse",
    started_at: "2026-10-16T08:00:00.000Z",
    finished_at: "2026-10-16T08:01:00.000Z",
    status: "filled",
    fixture: false,
    fields: [
      {
        label: "Full name",
        field_type: "input_text",
        required: true,
        source: "answer",
        answer_key: "contact.full_name",
        value: FAKE_VALUE,
        filled: true,
      },
      { label: "Why us?", field_type: "textarea", required: false, source: "none", filled: false },
    ],
    ...over,
  });
}

const storePath = (id: string, path: string) =>
  db.$client.prepare("update dry_runs set screenshot_path = ? where id = ?").run(path, id);
const runRow = (id: string) =>
  db.$client.prepare("select * from dry_runs where id = ?").get(id) as Record<string, unknown>;

/** A run whose screenshot sits at dryruns/<date>/<id>/screenshot.png under the data dir. */
function runWithShot(): string {
  const id = run({ screenshot_path: "dryruns/2026-10-16/placeholder/screenshot.png" });
  const rel = `dryruns/2026-10-16/${id}/screenshot.png`;
  mkdirSync(join(dataDir, "dryruns/2026-10-16", id), { recursive: true });
  writeFileSync(join(dataDir, rel), PNG);
  storePath(id, rel);
  return id;
}

beforeEach(() => {
  db = openDb(":memory:");
  dataDir = mkdtempSync(join(tmpdir(), "dash-dry-"));
  outside = mkdtempSync(join(tmpdir(), "dash-out-"));
  posting("p1", "Engineer");
  posting("p2", "Designer");
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const app = (withDataDir = true) =>
  createApp(db, {
    port: PORT,
    now: () => NOW,
    logError: () => {},
    ...(withDataDir ? { dataDir } : {}),
  });
const get = (path: string, headers: Record<string, string> = {}) =>
  app().request(`http://x${path}`, { headers: { Host: HOST, ...headers } });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app().request(`http://x${path}`, {
    method: "POST",
    headers: {
      Host: HOST,
      "Content-Type": "application/json",
      Origin: `http://${HOST}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });

describe("dry run list and detail", () => {
  it("lists newest first with counts, never values", async () => {
    const older = run({
      started_at: "2026-10-15T08:00:00.000Z",
      finished_at: "2026-10-15T08:01:00.000Z",
    });
    const newer = run({ posting_id: "p2" });
    const res = await get("/api/dry-runs");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(FAKE_VALUE);
    const body = JSON.parse(text) as {
      runs: Record<string, unknown>[];
      doneWhen: { line: string };
    };
    expect(body.runs.map((r) => r.id)).toEqual([newer, older]);
    expect(body.runs[0]).toMatchObject({
      title: "Designer",
      company: "Acme",
      atsType: "greenhouse",
      status: "filled",
      fieldsFilled: 1,
      fieldsTotal: 2,
      review: null,
    });
    expect(body.doneWhen.line).toBe(
      "dry runs: 0 correct of 0 reviewed (0 full fills); done when 20 correct, at least 10 full fills: not met",
    );
  });

  it("detail has every field with label, value, source, key and filled", async () => {
    const id = run({ status: "stopped", stop_reason: "blocked_request", stop_detail: "blocked" });
    const d = (await (await get(`/api/dry-runs/${id}`)).json()) as {
      fields: Record<string, unknown>[];
      blockedRequestsRecorded: number;
      stopDetail: string;
      hasScreenshot: boolean;
    };
    expect(d.fields).toHaveLength(2);
    expect(d.fields[0]).toMatchObject({
      label: "Full name",
      value: FAKE_VALUE,
      source: "answer",
      answerKey: "contact.full_name",
      filled: true,
    });
    expect(d.blockedRequestsRecorded).toBe(1);
    expect(d.stopDetail).toBe("blocked");
    expect(d.hasScreenshot).toBe(false);
  });

  it("an unknown run id is 404", async () => {
    expect((await get("/api/dry-runs/nope")).status).toBe(404);
  });

  it("the Host guard applies", async () => {
    expect((await get("/api/dry-runs", { Host: "evil.example" })).status).toBe(421);
  });
});

describe("dry run review", () => {
  it("correct, then changed to wrong with a reason; the done-when line follows", async () => {
    const id = run();
    let r = await post(`/api/dry-runs/${id}/review`, { review: "correct" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { doneWhen: { line: string } }).doneWhen.line).toContain(
      "1 correct of 1 reviewed (1 full fills)",
    );
    r = await post(`/api/dry-runs/${id}/review`, {
      review: "wrong",
      reason: "wrong_value",
      note: "name has a typo",
    });
    expect(r.status).toBe(200);
    expect(runRow(id)).toMatchObject({
      review: "wrong",
      review_reason: "wrong_value",
      review_note: "name has a typo",
    });
    expect(((await r.json()) as { doneWhen: { line: string } }).doneWhen.line).toContain(
      "0 correct of 1 reviewed",
    );
  });

  it("rejects wrong without a reason, an unknown reason, a reason on correct and extra keys", async () => {
    const id = run();
    for (const body of [
      { review: "wrong" },
      { review: "wrong", reason: "because" },
      { review: "correct", reason: "other" },
      { review: "correct", extra: 1 },
      { review: "correct", missing_label: "X" },
      { review: "wrong", reason: "other", missing_label: "X" },
    ]) {
      expect((await post(`/api/dry-runs/${id}/review`, body)).status).toBe(400);
    }
    expect(runRow(id).review).toBeNull();
  });

  it("unknown run is 404; the mutation guard applies", async () => {
    const id = run();
    expect((await post("/api/dry-runs/nope/review", { review: "correct" })).status).toBe(404);
    expect(
      (
        await post(
          `/api/dry-runs/${id}/review`,
          { review: "correct" },
          { Origin: "http://evil.example" },
        )
      ).status,
    ).toBe(403);
  });

  it("missing_field upserts the typed label into the Inbox and it survives re-matching", async () => {
    const id = run();
    const label = "Do you hold a security clearance?";
    const r = await post(`/api/dry-runs/${id}/review`, {
      review: "wrong",
      reason: "missing_field",
      missing_label: label,
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { inboxOpen: boolean }).inboxOpen).toBe(true);
    // Saving the same review again changes nothing.
    await post(`/api/dry-runs/${id}/review`, {
      review: "wrong",
      reason: "missing_field",
      missing_label: label,
    });
    const rows = db.$client
      .prepare("select * from unknown_questions where normalized_label = ?")
      .all(normalizeQuestion(label));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label, status: "open", posting_count: 1 });
    const inbox = (await (await get("/api/inbox")).json()) as { items: { label: string }[] };
    expect(inbox.items.map((i) => i.label)).toContain(label);
  });
});

describe("dry run screenshot route", () => {
  it("serves the stored file as image/png with nosniff", async () => {
    const id = runWithShot();
    const res = await get(`/api/dry-runs/${id}/screenshot`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("an unknown run id is 404", async () => {
    runWithShot();
    expect((await get("/api/dry-runs/nope/screenshot")).status).toBe(404);
  });

  it("a run without a stored path is 404", async () => {
    const id = run();
    expect((await get(`/api/dry-runs/${id}/screenshot`)).status).toBe(404);
  });

  it("without a data dir nothing is served", async () => {
    const id = runWithShot();
    expect(
      (
        await app(false).request(`http://x/api/dry-runs/${id}/screenshot`, {
          headers: { Host: HOST },
        })
      ).status,
    ).toBe(404);
  });

  it("the Host guard applies", async () => {
    const id = runWithShot();
    expect((await get(`/api/dry-runs/${id}/screenshot`, { Host: "evil.example" })).status).toBe(
      421,
    );
  });

  const stored = storePath;

  it("a stored path with .. is 404 even when the target exists", async () => {
    const id = runWithShot();
    writeFileSync(join(dataDir, "secret.png"), PNG);
    stored(id, "dryruns/../secret.png");
    expect((await get(`/api/dry-runs/${id}/screenshot`)).status).toBe(404);
  });

  it("an absolute stored path is 404", async () => {
    const id = runWithShot();
    writeFileSync(join(outside, "x.png"), PNG);
    stored(id, join(outside, "x.png"));
    expect((await get(`/api/dry-runs/${id}/screenshot`)).status).toBe(404);
  });

  it("a path outside dryruns/ inside the data dir is 404", async () => {
    const id = runWithShot();
    writeFileSync(join(dataDir, "job-agent.png"), PNG);
    stored(id, "job-agent.png");
    expect((await get(`/api/dry-runs/${id}/screenshot`)).status).toBe(404);
  });

  it("a file symlinked out of dryruns/ is 404", async () => {
    const id = runWithShot();
    writeFileSync(join(outside, "stolen.png"), PNG);
    mkdirSync(join(dataDir, "dryruns/2026-10-16/link"), { recursive: true });
    symlinkSync(
      join(outside, "stolen.png"),
      join(dataDir, "dryruns/2026-10-16/link/screenshot.png"),
    );
    stored(id, "dryruns/2026-10-16/link/screenshot.png");
    expect((await get(`/api/dry-runs/${id}/screenshot`)).status).toBe(404);
  });

  it("a directory symlinked out of dryruns/ is 404", async () => {
    const id = runWithShot();
    writeFileSync(join(outside, "screenshot.png"), PNG);
    symlinkSync(outside, join(dataDir, "dryruns/2026-10-16/dirlink"));
    stored(id, "dryruns/2026-10-16/dirlink/screenshot.png");
    expect((await get(`/api/dry-runs/${id}/screenshot`)).status).toBe(404);
  });

  it("a non-png file name is 404", async () => {
    const id = runWithShot();
    writeFileSync(join(dataDir, "dryruns/2026-10-16/notes.txt"), "x");
    stored(id, "dryruns/2026-10-16/notes.txt");
    expect((await get(`/api/dry-runs/${id}/screenshot`)).status).toBe(404);
  });

  it("a directory or a missing file is 404", async () => {
    const id = runWithShot();
    stored(id, "dryruns/2026-10-16/missing.png");
    expect((await get(`/api/dry-runs/${id}/screenshot`)).status).toBe(404);
    mkdirSync(join(dataDir, "dryruns/2026-10-16/dir.png"), { recursive: true });
    stored(id, "dryruns/2026-10-16/dir.png");
    expect((await get(`/api/dry-runs/${id}/screenshot`)).status).toBe(404);
  });

  it("another run's id cannot reach a file that is not its own", async () => {
    const a = runWithShot();
    const b = run({ posting_id: "p2" });
    expect((await get(`/api/dry-runs/${b}/screenshot`)).status).toBe(404);
    expect((await get(`/api/dry-runs/${a}/screenshot`)).status).toBe(200);
  });

  it("the id in the URL is never a path: ../ in the id is 404", async () => {
    runWithShot();
    expect((await get("/api/dry-runs/..%2F..%2Fsecret/screenshot")).status).toBe(404);
  });
});
