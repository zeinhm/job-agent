import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  dry_run_fields,
  dry_runs,
  openDb,
  posting_questions,
  postings,
  type Db,
} from "@job-agent/core";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDryRun } from "./dry-run.ts";

// One dry run per process: this file holds the only browser run of the Lever fixture (dry-run.test.ts has Greenhouse's).
let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dry-run-lever-cli-"));
  dbPath = join(dir, "scratch.db");
  db = openDb(dbPath);
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

async function cli(args: string[], isRealDb = false) {
  const out: string[] = [];
  const err: string[] = [];
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { headless: { type: "boolean", default: false }, fixture: { type: "string" } },
  });
  const code = await runDryRun({
    positionals,
    fixture: values.fixture,
    headless: values.headless === true,
    db,
    dbPath,
    isRealDb,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  return { code, out: out.join(""), err: err.join("") };
}

describe("dry-run --fixture lever", () => {
  it("reads the questions from the fixture page, stores them, fills the form, prints one summary line without values", async () => {
    const r = await cli(["--fixture", "lever"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out.trimEnd().split("\n")).toHaveLength(1);
    expect(r.out).toMatch(
      /^dry-run: status=filled reason=- fields=13\/13 screenshot=\S+\/dryruns\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\/screenshot\.png\n$/,
    );
    expect(r.out).not.toMatch(/Alex|Example|example\.test|555/);

    const run = db.select().from(dry_runs).get();
    expect(run).toMatchObject({ status: "filled", fixture: true, ats_type: "lever" });
    expect(
      db
        .select()
        .from(dry_run_fields)
        .where(eq(dry_run_fields.dry_run_id, run?.id ?? ""))
        .all(),
    ).toHaveLength(13);
    expect(
      db.select().from(posting_questions).where(eq(posting_questions.ats_type, "lever")).all(),
    ).toHaveLength(13);
    const shot = join(dir, run?.screenshot_path ?? "missing");
    expect(statSync(shot).mode & 0o777).toBe(0o600);
    expect(statSync(join(shot, "..")).mode & 0o777).toBe(0o700);
  }, 90_000);

  it("is refused on the real database and with a posting id; nothing is written", async () => {
    const real = await cli(["--fixture", "lever"], true);
    expect(real).toMatchObject({ code: 1, out: "" });
    expect(real.err).toContain("never runs on the real database");
    expect((await cli(["--fixture", "lever", "p1"])).code).toBe(1);
    expect(db.select().from(postings).all()).toEqual([]);
    expect(db.select().from(dry_runs).all()).toEqual([]);
  });
});
