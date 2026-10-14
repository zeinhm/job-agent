import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./index.ts";
import { apply_links, companies, llm_calls, postings } from "./schema.ts";

const drizzleDir = fileURLToPath(new URL("../../drizzle", import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "job-agent-p3-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A DB migrated with the Phase 1 + Phase 2 migrations only (first two journal entries). */
function createPhase2Db(file: string): void {
  const folder = join(dir, "phase2-migrations");
  mkdirSync(join(folder, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(join(drizzleDir, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  journal.entries = journal.entries.slice(0, 2);
  for (const e of journal.entries)
    cpSync(join(drizzleDir, `${e.tag}.sql`), join(folder, `${e.tag}.sql`));
  writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify(journal));
  const sqlite = new Database(file);
  migrate(drizzle(sqlite), { migrationsFolder: folder });
  const cols = sqlite.prepare("PRAGMA table_info(companies)").all() as Array<{ name: string }>;
  expect(cols.map((c) => c.name)).not.toContain("ats_checked_at");
  expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'apply_links'").get()).toBe(
    undefined,
  );
  sqlite.exec(`
    INSERT INTO companies (id, name, normalized_name, ats_type, ats_slug, discovered_via, verified, created_at)
      VALUES ('c1', 'Example Co', 'example co', 'ashby', 'example', 'search', 1, '2026-10-01T00:00:00Z');
    INSERT INTO postings (id, source, external_id, url, title, company_id, company_name, first_seen_at, last_seen_at)
      VALUES ('p1', 'remotive', 'e1', 'https://example.com/1', 'Senior Frontend Engineer', 'c1', 'Example Co', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z');
    INSERT INTO llm_calls (id, day, model, purpose, posting_id, input_tokens, output_tokens, cache_read_tokens, cost_usd, status, created_at)
      VALUES ('l1', '2026-10-01', 'm', 'extract', 'p1', 1, 1, 0, '0.001', 'ok', '2026-10-01T00:00:00Z');
  `);
  sqlite.close();
}

describe("Phase 3 apply-links migration", () => {
  it("applies on a fresh database with the table and the new column", () => {
    const db = openDb(":memory:");
    const cols = (t: string) =>
      (db.$client.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
    expect(cols("companies")).toContain("ats_checked_at");
    expect(cols("apply_links")).toEqual([
      "id",
      "posting_id",
      "apply_url",
      "apply_type",
      "method",
      "ats_type",
      "ats_slug",
      "found_on",
      "reason",
      "checked_at",
    ]);
    db.$client.close();
  });

  it("migrates a Phase 2 database, keeps its rows and accepts the new enum values", () => {
    const file = join(dir, "phase2.db");
    createPhase2Db(file);
    const db = openDb(file);

    expect(db.select().from(companies).get()).toMatchObject({
      id: "c1",
      ats_type: "ashby",
      ats_slug: "example",
      discovered_via: "search",
      verified: true,
      ats_checked_at: null,
    });
    expect(db.select().from(postings).all()).toHaveLength(1);
    expect(db.select().from(llm_calls).all()).toHaveLength(1);
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);

    db.update(companies)
      .set({ discovered_via: "apply_resolve", ats_checked_at: "2026-10-14T00:00:00Z" })
      .where(eq(companies.id, "c1"))
      .run();
    db.insert(llm_calls)
      .values({
        id: "l2",
        day: "2026-10-14",
        model: "m",
        purpose: "apply_link",
        posting_id: "p1",
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cost_usd: "0",
        status: "ok",
        created_at: "2026-10-14T00:00:00Z",
      })
      .run();
    const link = {
      id: "a1",
      posting_id: "p1",
      apply_url: "https://jobs.example.com/1",
      apply_type: "ats",
      method: "ats_board",
      ats_type: "ashby",
      ats_slug: "example",
      found_on: "remotive",
      reason: null,
      checked_at: "2026-10-14T00:00:00Z",
    } as const;
    db.insert(apply_links).values(link).run();
    expect(db.select().from(apply_links).get()).toEqual(link);
    // One row per posting, and the posting must exist.
    expect(() =>
      db
        .insert(apply_links)
        .values({ ...link, id: "a2" })
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      db
        .insert(apply_links)
        .values({ ...link, id: "a3", posting_id: "missing" })
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
    db.$client.close();
  });
});
