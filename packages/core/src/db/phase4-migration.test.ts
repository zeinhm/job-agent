import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./index.ts";
import {
  ANSWER_TYPES,
  APPLY_METHODS,
  NOT_INTERESTED_REASONS,
  REVIEW_ACTIONS,
  REVIEW_STATUS_ACTIONS,
  answer_bank,
  apply_links,
  llm_calls,
  posting_questions,
  postings,
  reviews,
  unknown_questions,
} from "./schema.ts";

const drizzleDir = fileURLToPath(new URL("../../drizzle", import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "job-agent-p4-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A DB migrated up to and including 0003 (the last Phase 3 migration), with rows. */
function createPhase3Db(file: string): void {
  const folder = join(dir, "phase3-migrations");
  mkdirSync(join(folder, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(join(drizzleDir, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  journal.entries = journal.entries.filter((e) => e.tag.startsWith("000") && e.tag < "0004");
  expect(journal.entries).toHaveLength(4);
  for (const e of journal.entries)
    cpSync(join(drizzleDir, `${e.tag}.sql`), join(folder, `${e.tag}.sql`));
  writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify(journal));
  const sqlite = new Database(file);
  migrate(drizzle(sqlite), { migrationsFolder: folder });
  expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'reviews'").get()).toBe(
    undefined,
  );
  sqlite.exec(`
    INSERT INTO postings (id, source, external_id, url, title, company_name, first_seen_at, last_seen_at)
      VALUES ('p1', 'remotive', 'e1', 'https://example.com/1', 'Senior Frontend Engineer', 'Example Co', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z');
    INSERT INTO apply_links (id, posting_id, apply_url, apply_type, method, found_on, checked_at)
      VALUES ('a1', 'p1', 'https://jobs.example.com/1', 'ats', 'ats_board', 'remotive', '2026-10-02T00:00:00Z');
    INSERT INTO llm_calls (id, day, model, purpose, posting_id, input_tokens, output_tokens, cache_read_tokens, cost_usd, status, created_at)
      VALUES ('l1', '2026-10-01', 'm', 'extract', 'p1', 1, 1, 0, '0.001', 'ok', '2026-10-01T00:00:00Z');
  `);
  sqlite.close();
}

const cols = (db: ReturnType<typeof openDb>, t: string) =>
  (db.$client.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );

describe("Phase 4 schema migration", () => {
  it("creates the Phase 4 tables with the convention columns on a fresh database", () => {
    const db = openDb(":memory:");
    expect(cols(db, "reviews")).toEqual([
      "id",
      "posting_id",
      "action",
      "reason",
      "note",
      "apply_url",
      "pay_policy",
      "reviewed_at",
      "review_day",
      "fit_score",
      "final_decision",
      "tier",
      "apply_type",
      "extract_prompt_version",
      "fit_prompt_version",
    ]);
    expect(cols(db, "answer_bank")).toEqual([
      "id",
      "key",
      "group",
      "question",
      "answer",
      "type",
      "choices",
      "alternatives",
      "approved",
      "approved_at",
      "source",
      "updated_at",
    ]);
    expect(cols(db, "posting_questions")).toEqual([
      "id",
      "posting_id",
      "ats_type",
      "question_id",
      "label",
      "required",
      "type",
      "options",
      "normalized_label",
      "matched_key",
      "fetched_at",
    ]);
    expect(cols(db, "unknown_questions")).toEqual([
      "id",
      "normalized_label",
      "label",
      "posting_count",
      "first_seen_at",
      "last_seen_at",
      "status",
      "answer_key",
    ]);
    db.$client.close();
  });

  it("exports the enum constants from one source", () => {
    expect(REVIEW_STATUS_ACTIONS).toEqual([
      "interested",
      "applied_manually",
      "not_interested",
      "later",
    ]);
    expect(REVIEW_ACTIONS).toEqual([
      ...REVIEW_STATUS_ACTIONS,
      "wrong_apply_link",
      "pay_policy",
      "scam",
      "not_scam",
      "ask_ok",
      "ask_too_high",
      "ask_too_low",
    ]);
    expect(NOT_INTERESTED_REASONS).toHaveLength(13);
    expect(NOT_INTERESTED_REASONS).toContain("other");
    expect(ANSWER_TYPES).toEqual(["text", "long_text", "yes_no", "number", "choice"]);
    expect(APPLY_METHODS).toContain("owner");
  });

  it("migrates a database at migration 0003, keeps its rows and accepts the new rows", () => {
    const file = join(dir, "phase3.db");
    createPhase3Db(file);
    const db = openDb(file);

    expect(db.select().from(postings).all()).toHaveLength(1);
    expect(db.select().from(apply_links).get()).toMatchObject({
      id: "a1",
      method: "ats_board",
      apply_type: "ats",
    });
    expect(db.select().from(llm_calls).all()).toHaveLength(1);
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);

    db.insert(llm_calls)
      .values(
        (["eval_extract", "eval_fit"] as const).map((purpose, i) => ({
          id: `le${i}`,
          day: "2026-10-15",
          model: "m",
          purpose,
          input_tokens: 1,
          output_tokens: 1,
          cache_read_tokens: 0,
          cost_usd: "0",
          status: "ok" as const,
          created_at: "2026-10-15T00:00:00Z",
        })),
      )
      .run();
    db.update(apply_links).set({ method: "owner" }).run();
    expect(db.select().from(apply_links).get()?.method).toBe("owner");

    const review = {
      id: "r1",
      posting_id: "p1",
      action: "not_interested",
      reason: "stack",
      note: null,
      apply_url: null,
      pay_policy: null,
      reviewed_at: "2026-10-15T01:00:00Z",
      review_day: "2026-10-15",
      fit_score: 70,
      final_decision: "keep",
      tier: "global_flat",
      apply_type: "ats",
      extract_prompt_version: "e1",
      fit_prompt_version: "f1",
    } as const;
    db.insert(reviews).values(review).run();
    expect(db.select().from(reviews).get()).toEqual(review);
    // History is append-only: several rows per posting are allowed.
    db.insert(reviews)
      .values({ ...review, id: "r2", action: "later", reason: null })
      .run();
    expect(db.select().from(reviews).all()).toHaveLength(2);
    expect(() =>
      db
        .insert(reviews)
        .values({ ...review, id: "r3", posting_id: "missing" })
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);

    const answer = {
      id: "ab1",
      key: "work.notice_period",
      group: "work",
      question: "What is your notice period?",
      answer: "Two weeks",
      type: "text",
      choices: null,
      alternatives: JSON.stringify(["Notice period"]),
      approved: false,
      approved_at: null,
      source: "config",
      updated_at: "2026-10-15T00:00:00Z",
    } as const;
    db.insert(answer_bank).values(answer).run();
    expect(db.select().from(answer_bank).get()).toEqual(answer);
    expect(() =>
      db
        .insert(answer_bank)
        .values({ ...answer, id: "ab2" })
        .run(),
    ).toThrow(/UNIQUE constraint failed/);

    const question = {
      id: "q1",
      posting_id: "p1",
      ats_type: "greenhouse",
      question_id: "q_100",
      label: "Why do you want to work here?",
      required: true,
      type: "long_text",
      options: null,
      normalized_label: "why do you want to work here",
      matched_key: null,
      fetched_at: "2026-10-15T00:00:00Z",
    } as const;
    db.insert(posting_questions).values(question).run();
    expect(db.select().from(posting_questions).get()).toEqual(question);
    expect(() =>
      db
        .insert(posting_questions)
        .values({ ...question, id: "q2" })
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      db
        .insert(posting_questions)
        .values({ ...question, id: "q3", question_id: "q_101", posting_id: "missing" })
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);

    const unknown = {
      id: "u1",
      normalized_label: "why do you want to work here",
      label: "Why do you want to work here?",
      posting_count: 1,
      first_seen_at: "2026-10-15T00:00:00Z",
      last_seen_at: "2026-10-15T00:00:00Z",
      status: "open",
      answer_key: null,
    } as const;
    db.insert(unknown_questions).values(unknown).run();
    expect(db.select().from(unknown_questions).get()).toEqual(unknown);
    expect(() =>
      db
        .insert(unknown_questions)
        .values({ ...unknown, id: "u2" })
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    db.$client.close();
  });
});

describe("openDb pragmas", () => {
  it("sets WAL and a 5 second busy timeout on file databases", () => {
    const db = openDb(join(dir, "wal.db"));
    expect(db.$client.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.$client.pragma("busy_timeout", { simple: true })).toBe(5000);
    db.$client.close();
  });

  it("leaves in-memory databases out of WAL", () => {
    const db = openDb(":memory:");
    expect(db.$client.pragma("journal_mode", { simple: true })).toBe("memory");
    db.$client.close();
  });
});
