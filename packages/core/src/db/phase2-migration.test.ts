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
import { companies, intel, llm_calls, postings } from "./schema.ts";

const drizzleDir = fileURLToPath(new URL("../../drizzle", import.meta.url));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "job-agent-p2-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Creates a DB file migrated with the Phase 1 migration only (first journal entry). */
function createPhase1Db(file: string): void {
  const folder = join(dir, "phase1-migrations");
  mkdirSync(join(folder, "meta"), { recursive: true });
  cpSync(
    join(drizzleDir, "0000_spooky_grandmaster.sql"),
    join(folder, "0000_spooky_grandmaster.sql"),
  );
  const journal = JSON.parse(readFileSync(join(drizzleDir, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.slice(0, 1);
  writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify(journal));
  const sqlite = new Database(file);
  migrate(drizzle(sqlite), { migrationsFolder: folder });
  // Phase 1 shape: new columns must not exist yet.
  const cols = sqlite.prepare("PRAGMA table_info(postings)").all() as Array<{ name: string }>;
  expect(cols.map((c) => c.name)).not.toContain("content_hash");
  // Phase 1 rows: a company, two postings (one linked to the company), one analysis.
  sqlite.exec(`
    INSERT INTO companies (id, name, normalized_name, ats_type, ats_slug, pay_policy, pay_policy_source, verified, created_at)
      VALUES ('c1', 'Example Co', 'example co', 'ashby', 'example', 'unknown', 'posting:p1', 1, '2026-10-01T00:00:00Z');
    INSERT INTO postings (id, source, external_id, url, title, company_id, company_name, first_seen_at, last_seen_at)
      VALUES ('p1', 'ashby', 'e1', 'https://example.com/1', 'Senior Frontend Engineer', 'c1', 'Example Co', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z');
    INSERT INTO postings (id, source, external_id, url, title, company_name, first_seen_at, last_seen_at)
      VALUES ('p2', 'remotive', 'e2', 'https://example.com/2', 'Staff Engineer', 'Other Co', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z');
    INSERT INTO analysis (id, posting_id, location_class, indonesia_rule, salary_status, decision, analyzed_at)
      VALUES ('a1', 'p1', 'worldwide', 'not_applicable', 'unknown', 'keep', '2026-10-02T00:00:00Z');
  `);
  sqlite.close();
}

describe("Phase 2 migration", () => {
  it("applies on a fresh :memory: database with every new column", () => {
    const db = openDb(":memory:");
    const cols = (table: string) =>
      (db.$client.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
    expect(cols("postings")).toEqual(expect.arrayContaining(["content_hash", "updated_at"]));
    expect(cols("companies")).toEqual(
      expect.arrayContaining(["discovered_via", "discovered_at", "pay_policy_checked_at"]),
    );
    expect(cols("intel")).toHaveLength(20);
    expect(cols("llm_calls")).toHaveLength(12);
    db.$client.close();
  });

  it("applies on a database created by the Phase 1 migration and keeps its data", () => {
    const file = join(dir, "phase1.db");
    createPhase1Db(file);

    const db = openDb(file);
    expect(db.select().from(companies).all()).toEqual([
      {
        id: "c1",
        name: "Example Co",
        normalized_name: "example co",
        domain: null,
        ats_type: "ashby",
        ats_slug: "example",
        hq_country: null,
        company_type: null,
        pay_policy: "unknown",
        pay_policy_source: "posting:p1",
        pay_policy_checked_at: null,
        discovered_via: null,
        discovered_at: null,
        verified: true,
        created_at: "2026-10-01T00:00:00Z",
      },
    ]);
    const rows = db.select().from(postings).orderBy(postings.id).all();
    expect(rows.map((r) => [r.id, r.company_id, r.title, r.content_hash, r.updated_at])).toEqual([
      ["p1", "c1", "Senior Frontend Engineer", null, null],
      ["p2", null, "Staff Engineer", null, null],
    ]);
    expect(db.$client.prepare("SELECT COUNT(*) AS n FROM analysis").get()).toEqual({ n: 1 });
    // Foreign keys still hold after the companies rebuild.
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
    expect(() =>
      db
        .insert(postings)
        .values({
          id: "p3",
          source: "x",
          external_id: "x",
          url: "https://example.com/3",
          title: "T",
          company_id: "missing",
          company_name: "N",
          first_seen_at: "2026-10-01T00:00:00Z",
          last_seen_at: "2026-10-01T00:00:00Z",
        })
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
    // New ATS enum values are accepted on the migrated companies table.
    db.update(companies).set({ ats_type: "workable" }).where(eq(companies.id, "c1")).run();
    db.$client.close();
  });
});

describe("Phase 2 schema", () => {
  it("accepts a full intel row and a full llm_calls row, rejects a second intel row per posting", () => {
    const db = openDb(":memory:");
    db.insert(companies)
      .values({
        id: "c1",
        name: "Example Co",
        normalized_name: "example co",
        ats_type: "recruitee",
        pay_policy: "location_agnostic",
        pay_policy_source: "careers:https://example.com/careers",
        pay_policy_checked_at: "2026-10-08T00:00:00Z",
        discovered_via: "search",
        discovered_at: "2026-10-08T00:00:00Z",
        created_at: "2026-10-08T00:00:00Z",
      })
      .run();
    db.insert(postings)
      .values({
        id: "p1",
        source: "workable",
        external_id: "e1",
        url: "https://example.com/1",
        title: "Senior Frontend Engineer",
        company_id: "c1",
        company_name: "Example Co",
        content_hash: "abc123",
        updated_at: "2026-10-08T01:00:00Z",
        first_seen_at: "2026-10-08T00:00:00Z",
        last_seen_at: "2026-10-08T00:00:00Z",
      })
      .run();

    const intelRow = {
      id: "i1",
      posting_id: "p1",
      status: "done",
      extraction: '{"role":"frontend"}',
      extract_model: "claude-haiku-5-5",
      extract_prompt_version: "v1",
      final_decision: "keep",
      resolved_reasons: '["location_unclear -> apac_ok"]',
      scam_score: 10,
      scam_reasons: '["+10 free email domain"]',
      fit_score: 82,
      fit_reasons: '["react", "typescript"]',
      fit_model: "claude-sonnet-5-5",
      fit_prompt_version: "v1",
      tier: "global_flat",
      ask_idr_month: 15000000,
      ask_usd_year: 50000,
      ask_text: "Open to your band",
      ask_reason: "listed range, location agnostic",
      updated_at: "2026-10-08T02:00:00Z",
    } as const;
    db.insert(intel).values(intelRow).run();
    expect(db.select().from(intel).where(eq(intel.id, "i1")).get()).toEqual(intelRow);

    const callRow = {
      id: "l1",
      day: "2026-10-08",
      model: "claude-haiku-5-5",
      purpose: "extract",
      posting_id: "p1",
      company_id: "c1",
      input_tokens: 1200,
      output_tokens: 300,
      cache_read_tokens: 800,
      cost_usd: "0.0021",
      status: "ok",
      created_at: "2026-10-08T02:00:00Z",
    } as const;
    db.insert(llm_calls).values(callRow).run();
    expect(db.select().from(llm_calls).where(eq(llm_calls.id, "l1")).get()).toEqual(callRow);

    expect(() =>
      db
        .insert(intel)
        .values({ ...intelRow, id: "i2" })
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    db.$client.close();
  });

  it("rejects an llm_calls row pointing at a missing posting", () => {
    const db = openDb(":memory:");
    expect(() =>
      db
        .insert(llm_calls)
        .values({
          id: "l1",
          day: "2026-10-08",
          model: "m",
          purpose: "fit",
          posting_id: "missing",
          input_tokens: 1,
          output_tokens: 1,
          cache_read_tokens: 0,
          cost_usd: "0",
          status: "error",
          created_at: "2026-10-08T00:00:00Z",
        })
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
    db.$client.close();
  });
});
