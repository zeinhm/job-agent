import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./index.ts";
import { answer_bank, choice_mappings, dry_run_fields, dry_runs, postings } from "./schema.ts";

const drizzleDir = fileURLToPath(new URL("../../drizzle", import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "job-agent-dryrun-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const cols = (db: ReturnType<typeof openDb>, t: string) =>
  (db.$client.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );

describe("dry-run tables migration (0008)", () => {
  it("creates dry_runs, dry_run_fields and choice_mappings on a fresh database", () => {
    const db = openDb(":memory:");
    expect(cols(db, "dry_runs")).toEqual([
      "id",
      "posting_id",
      "ats_type",
      "started_at",
      "finished_at",
      "status",
      "stop_reason",
      "stop_detail",
      "screenshot_path",
      "review",
      "review_reason",
      "review_note",
      "reviewed_at",
      "fixture",
    ]);
    expect(cols(db, "dry_run_fields")).toEqual([
      "id",
      "dry_run_id",
      "label",
      "field_type",
      "required",
      "source",
      "answer_key",
      "value",
      "filled",
      "note",
    ]);
    expect(cols(db, "choice_mappings")).toEqual([
      "id",
      "answer_key",
      "normalized_label",
      "options_hash",
      "options",
      "chosen",
      "approved",
      "approved_at",
      "updated_at",
    ]);
    db.$client.close();
  });

  it("upgrades a database at 0007: existing rows untouched, new tables empty", () => {
    const folder = join(dir, "before");
    mkdirSync(join(folder, "meta"), { recursive: true });
    const journal = JSON.parse(readFileSync(join(drizzleDir, "meta/_journal.json"), "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    journal.entries = journal.entries.filter((e) => e.tag < "0008");
    expect(journal.entries).toHaveLength(8);
    for (const e of journal.entries)
      cpSync(join(drizzleDir, `${e.tag}.sql`), join(folder, `${e.tag}.sql`));
    writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify(journal));
    const file = join(dir, "old.db");
    const old = new Database(file);
    migrate(drizzle(old), { migrationsFolder: folder });
    old
      .prepare(
        `INSERT INTO postings (id, source, external_id, url, title, company_name, first_seen_at, last_seen_at)
         VALUES ('p1', 'greenhouse', 'gh1', 'https://example.com/jobs/1', 'Senior Frontend Engineer', 'Fake Co', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z')`,
      )
      .run();
    old
      .prepare(
        `INSERT INTO answer_bank (id, key, "group", answer, approved, source, updated_at)
         VALUES ('a1', 'identity.full_name', 'identity', 'Alex Example', 1, 'dashboard', '2026-10-01T00:00:00Z')`,
      )
      .run();
    const tables = (d: Database.Database) =>
      (
        d
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%drizzle%'",
          )
          .all() as Array<{ name: string }>
      ).map((t) => t.name);
    expect(tables(old)).not.toContain("dry_runs");
    const snapshot = (d: Database.Database) => ({
      postings: d.prepare("SELECT * FROM postings").all(),
      answers: d.prepare("SELECT * FROM answer_bank").all(),
    });
    const before = snapshot(old);
    expect(before.postings).toHaveLength(1);
    old.close();

    const db = openDb(file);
    expect({
      postings: db.$client.prepare("SELECT * FROM postings").all(),
      answers: db.$client.prepare("SELECT * FROM answer_bank").all(),
    }).toEqual(before);
    expect(db.select().from(postings).all()).toHaveLength(1);
    expect(db.select().from(answer_bank).all()).toHaveLength(1);
    expect(db.select().from(dry_runs).all()).toEqual([]);
    expect(db.select().from(dry_run_fields).all()).toEqual([]);
    expect(db.select().from(choice_mappings).all()).toEqual([]);
    db.$client.close();
  });

  it("rejects a duplicate (answer key, label, options hash) and a run for an unknown posting", () => {
    const db = openDb(":memory:");
    const mapping = {
      id: "m1",
      answer_key: "work.auth",
      normalized_label: "work authorization",
      options_hash: "h",
      options: "[]",
      chosen: "[]",
      updated_at: "2026-10-01T00:00:00Z",
    };
    db.insert(choice_mappings).values(mapping).run();
    expect(() =>
      db
        .insert(choice_mappings)
        .values({ ...mapping, id: "m2" })
        .run(),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db
        .insert(dry_runs)
        .values({
          id: "r1",
          posting_id: "missing",
          ats_type: "greenhouse",
          started_at: "2026-10-01T00:00:00Z",
          finished_at: "2026-10-01T00:00:01Z",
          status: "filled",
        })
        .run(),
    ).toThrow(/FOREIGN KEY/);
    db.$client.close();
  });
});
