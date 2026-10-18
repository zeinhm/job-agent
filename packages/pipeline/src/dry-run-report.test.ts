import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dry_runs, openDb, openDbReadonly, postings, type Db } from "@job-agent/core";
import { recordDryRun, type DryRunFieldInput, type NewDryRunInput } from "@job-agent/apply";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "./cli.ts";
import { KNOWN_FIELD_NOTES, printableNote, regressionReasons } from "./dry-run-report.ts";

/** Every fake personal value carries a marker; none may reach stdout or stderr. */
const MV = "QZVALUE7";
const MN = "QZNOTE7";
const MR = "QZREVIEW7";
const MS = "QZSHOT7";
const MARKERS = [MV, MN, MR, MS];

let dir: string;
let dbPath: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dry-run-report-"));
  dbPath = join(dir, "scratch.db");
  db = openDb(dbPath);
  process.env["JOB_AGENT_DB"] = dbPath;
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env["JOB_AGENT_DB"];
});

async function report(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(["dry-run-report", ...args], {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  return { code, out: out.join(""), err: err.join("") };
}

function expectValueFree(r: { out: string; err: string }) {
  for (const m of MARKERS) {
    expect(r.out).not.toContain(m);
    expect(r.err).not.toContain(m);
  }
}

const T0 = "2026-10-10T10:00:00.000Z";
function addPosting(id: string) {
  db.insert(postings)
    .values({
      id,
      source: "greenhouse",
      external_id: id,
      url: "https://fake.example/jobs/1",
      title: "Fake title",
      company_name: "Fake Co",
      description_text: "Fake description",
      first_seen_at: T0,
      last_seen_at: T0,
    })
    .run();
}

function field(label: string, over: Partial<DryRunFieldInput> = {}): DryRunFieldInput {
  return {
    label,
    field_type: "text",
    required: true,
    source: "answer",
    answer_key: "contact.full_name",
    value: `${MV} value`,
    filled: true,
    note: null,
    ...over,
  };
}

function addRun(posting: string, startedAt: string, over: Partial<NewDryRunInput> = {}): string {
  return recordDryRun(db, {
    posting_id: posting,
    ats_type: "greenhouse",
    started_at: startedAt,
    finished_at: startedAt,
    status: "filled",
    stop_reason: null,
    stop_detail: null,
    screenshot_path: `dryruns/${MS}/screenshot.png`,
    fixture: false,
    fields: [field("Full name"), field("Email", { answer_key: "contact.email" })],
    ...over,
  });
}

describe("dry-run-report", () => {
  it("prints runs, fields and a REGRESSION flag against the previous run, value-free", async () => {
    addPosting("p1");
    const good = addRun("p1", "2026-10-10T10:00:00.000Z");
    const bad = addRun("p1", "2026-10-11T10:00:00.000Z", {
      status: "stopped",
      stop_reason: "captcha",
      stop_detail: "captcha seen",
      fields: [
        field("Full name"),
        field("Email", { answer_key: "contact.email", filled: false, source: "none", note: MN }),
      ],
    });
    db.update(dry_runs)
      .set({ review: "wrong", review_reason: "stopped_wrongly", review_note: `${MR} note` })
      .where(sqlId(bad))
      .run();
    const r = await report();
    expect(r.code).toBe(0);
    expectValueFree(r);
    expect(r.err).toBe("");
    const lines = r.out.split("\n");
    const head = lines.find((l) => l.startsWith(`run "${bad}"`)) ?? "";
    expect(head).toContain(
      "status=stopped reason=captcha filled=1/2 review=wrong review_reason=stopped_wrongly",
    );
    expect(r.out).toContain(`previous: run "${good}" status=filled reason=- filled=2/2`);
    expect(r.out).toContain("REGRESSION: status,fewer_filled,field_lost");
    // the older run has no previous run and no flag
    const olderBlock = r.out.slice(r.out.indexOf(`run "${good}" posting`));
    expect(olderBlock).toContain("previous: none");
    expect(olderBlock).not.toContain("REGRESSION");
    expect(r.out).toContain(
      'field "Email" type="text" required=yes filled=no source=none key="contact.email" note: other',
    );
  });

  it("flags nothing when the new run is as good", async () => {
    addPosting("p1");
    addRun("p1", "2026-10-10T10:00:00.000Z");
    addRun("p1", "2026-10-11T10:00:00.000Z");
    const r = await report();
    expect(r.out).not.toContain("REGRESSION");
  });

  it("prints a known filler note exactly and any other note as 'other'", () => {
    expect(printableNote(KNOWN_FIELD_NOTES[0] ?? "")).toBe(KNOWN_FIELD_NOTES[0]);
    expect(printableNote(`${KNOWN_FIELD_NOTES[0]} `)).toBe("other");
    expect(printableNote(`${MN} text`)).toBe("other");
    expect(printableNote(null)).toBeNull();
    // what the Ashby filler stores for a skipped block
    const skipped = "skipped: text message consent, never touched";
    expect(printableNote(skipped)).toBe(skipped);
  });

  it("regressionReasons: status, fewer filled, lost field, none", () => {
    const f = (label: string, filled: boolean) => ({
      label,
      field_type: "text",
      required: true,
      source: "answer" as const,
      answer_key: null,
      filled,
      note: null,
    });
    const two = [f("A", true), f("B", true)];
    expect(
      regressionReasons({ status: "filled", fields: two }, { status: "error", fields: two }),
    ).toEqual(["status"]);
    expect(
      regressionReasons(
        { status: "filled", fields: two },
        { status: "filled", fields: [f("A", true), f("B", false)] },
      ),
    ).toEqual(["fewer_filled", "field_lost"]);
    expect(
      regressionReasons(
        { status: "filled", fields: two },
        { status: "filled", fields: [f("A", true), f("C", true)] },
      ),
    ).toEqual(["field_lost"]);
    expect(
      regressionReasons({ status: "stopped", fields: two }, { status: "stopped", fields: two }),
    ).toEqual([]);
    expect(
      regressionReasons({ status: "stopped", fields: [] }, { status: "filled", fields: two }),
    ).toEqual([]);
  });

  it("marks fixture runs and compares a fixture run only with fixture runs", async () => {
    addPosting("p1");
    addRun("p1", "2026-10-10T10:00:00.000Z");
    addRun("p1", "2026-10-11T10:00:00.000Z", {
      fixture: true,
      status: "stopped",
      stop_reason: "other",
    });
    const r = await report();
    expect(r.out).toMatch(/started="2026-10-11T10:00:00.000Z" fixture status=stopped/);
    expect(r.out).not.toContain("REGRESSION");
  });

  it("filters by posting, since and last; default is the last 10", async () => {
    addPosting("p1");
    addPosting("p2");
    for (let i = 0; i < 12; i++)
      addRun("p1", `2026-10-${String(10 + i).padStart(2, "0")}T10:00:00.000Z`);
    addRun("p2", "2026-10-05T10:00:00.000Z");
    const count = (s: string) => s.split("\n").filter((l) => l.startsWith("run ")).length;
    expect(count((await report()).out)).toBe(10);
    expect(count((await report("--last", "3")).out)).toBe(3);
    expect(count((await report("--posting", "p2")).out)).toBe(1);
    expect(count((await report("--since", "2026-10-20")).out)).toBe(2);
    expect(count((await report("--since", "2026-10-20T00:00:00Z", "--last", "1")).out)).toBe(1);
  });

  it("a known posting with no runs and an empty DB print 'no runs'", async () => {
    expect(await report()).toMatchObject({ code: 0, out: "dry-run-report: no runs\n" });
    addPosting("p1");
    expect(await report("--posting", "p1")).toMatchObject({
      code: 0,
      out: "dry-run-report: no runs\n",
    });
  });

  it("refuses an unknown posting with fixed text", async () => {
    const r = await report("--posting", "nope");
    expect(r).toEqual({ code: 1, out: "", err: "dry-run-report: refused: unknown posting\n" });
  });

  it("refuses bad arguments with fixed text that does not echo them", async () => {
    for (const args of [
      ["--last", "0"],
      ["--last", "abc"],
      ["--last", "9999"],
      ["--since", "yesterday"],
      ["--posting", "a b"],
      ["--posting", `x\nQZECHO7`],
      ["--bogus", "QZECHO7"],
      ["QZECHO7"],
      ["--last"],
    ]) {
      const r = await report(...args);
      expect(r.code).toBe(1);
      expect(r.out).toBe("");
      expect(r.err).toContain(
        "dry-run-report: refused: invalid arguments\nUsage: job-agent dry-run-report",
      );
      expect(r.err).not.toContain("QZECHO7");
    }
  });

  it("--batch is refused until the operator batch table exists", async () => {
    const r = await report("--batch", "b1");
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      "dry-run-report: refused: --batch needs the operator batch table, not available\n",
    );
  });

  it("refuses a missing database without creating it", async () => {
    process.env["JOB_AGENT_DB"] = join(dir, "sub", "missing.db");
    const r = await report();
    expect(r).toEqual({ code: 1, out: "", err: "dry-run-report: refused: database not found\n" });
    expect(() => readFileSync(join(dir, "sub", "missing.db"))).toThrow();
  });

  it("a corrupt row prints only the error name and place, no partial report", async () => {
    addPosting("p1");
    addRun("p1", "2026-10-10T10:00:00.000Z");
    const bad = addRun("p1", "2026-10-11T10:00:00.000Z", {
      fields: [field("Full name", { value: `${MV}` })],
    });
    db.$client
      .prepare("update dry_runs set status = ?, stop_detail = ? where id = ?")
      .run(`${MN}bad`, MN, bad);
    const r = await report();
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/^dry-run-report: error ZodError at [^\n]*:\d+\n$/);
    expectValueFree(r);
  });

  it("a corrupt field row is the same", async () => {
    addPosting("p1");
    const id = addRun("p1", "2026-10-10T10:00:00.000Z");
    db.$client
      .prepare("update dry_run_fields set source = ? where dry_run_id = ?")
      .run(`${MN}x`, id);
    const r = await report();
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^dry-run-report: error ZodError at /);
    expectValueFree(r);
  });

  it("a label, field type, key or stop detail cannot forge a line or flood one", async () => {
    addPosting("p1");
    const evil = `Name\nrun "forged" posting="x" status=filled\r${"  "}\u0007\u001b[31m${"x".repeat(300)}`;
    addRun("p1", "2026-10-10T10:00:00.000Z", {
      status: "stopped",
      stop_reason: "other",
      stop_detail: `detail\nREGRESSION: forged\n${"d".repeat(170)}`,
      fields: [field(evil, { field_type: `te\nxt`, filled: false, source: "none" })],
    });
    const r = await report();
    expect(r.code).toBe(0);
    const lines = r.out.trimEnd().split("\n");
    expect(lines).toHaveLength(4); // run, detail, previous, one field
    expect(lines[0]).toMatch(/^run "/);
    expect(lines[1]).toMatch(/^ {2}detail: "detail/);
    expect(lines[2]).toBe("  previous: none");
    expect(lines[3]).toMatch(/^ {2}field "Name/);
    expect(r.out).not.toMatch(new RegExp("[\\u0000-\\u0009\\u000b-\\u001f\\u007f\\u2028\\u2029]"));
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThan(500);
    expect(r.out).not.toContain("x".repeat(170));
  });

  it("opens the DB read-only: the file is byte-identical afterwards and writes fail", async () => {
    addPosting("p1");
    addRun("p1", "2026-10-10T10:00:00.000Z");
    db.$client.pragma("wal_checkpoint(TRUNCATE)");
    db.$client.close();
    const hash = () => createHash("sha256").update(readFileSync(dbPath)).digest("hex");
    const before = hash();
    const r = await report();
    expect(r.code).toBe(0);
    expect(hash()).toBe(before);
    const ro = openDbReadonly(dbPath);
    expect(() => ro.$client.prepare("delete from dry_runs").run()).toThrow();
    expect(() => ro.delete(dry_runs).run()).toThrow();
    ro.$client.close();
    expect(hash()).toBe(before);
    db = openDb(dbPath); // for afterEach
  });
});

function sqlId(id: string) {
  return eq(dry_runs.id, id);
}
