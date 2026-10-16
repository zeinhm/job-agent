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
import { description_runs, postings } from "./schema.ts";

const drizzleDir = fileURLToPath(new URL("../../drizzle", import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "job-agent-desc-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const cols = (db: ReturnType<typeof openDb>, t: string) =>
  (db.$client.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );

describe("LinkedIn description fetch migration (0005)", () => {
  it("adds the attempt columns and the description_runs table on a fresh database", () => {
    const db = openDb(":memory:");
    expect(cols(db, "postings")).toEqual(
      expect.arrayContaining([
        "description_attempts",
        "description_unavailable_at",
        "description_failed_at",
        "description_blocked_at",
      ]),
    );
    expect(cols(db, "description_runs")).toEqual([
      "id",
      "source",
      "started_at",
      "finished_at",
      "requested",
      "failed",
      "blocked",
      "fetched",
      "skipped",
    ]);
    db.$client.close();
  });

  it("upgrades a database from before it: old postings get 0 attempts and no unavailable mark", () => {
    const folder = join(dir, "before");
    mkdirSync(join(folder, "meta"), { recursive: true });
    const journal = JSON.parse(readFileSync(join(drizzleDir, "meta/_journal.json"), "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    journal.entries = journal.entries.filter((e) => e.tag < "0005");
    expect(journal.entries).toHaveLength(5);
    for (const e of journal.entries)
      cpSync(join(drizzleDir, `${e.tag}.sql`), join(folder, `${e.tag}.sql`));
    writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify(journal));
    const file = join(dir, "old.db");
    const old = new Database(file);
    migrate(drizzle(old), { migrationsFolder: folder });
    old
      .prepare(
        `INSERT INTO postings (id, source, external_id, url, title, company_name, first_seen_at, last_seen_at)
         VALUES ('p1', 'linkedin', 'li1', 'https://example.com/jobs/view/1', 'Senior Frontend Engineer', 'Fake Co', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z')`,
      )
      .run();
    old.close();

    const db = openDb(file);
    const row = db.select().from(postings).where(eq(postings.id, "p1")).get();
    expect(row?.description_attempts).toBe(0);
    expect(row?.description_unavailable_at).toBeNull();
    db.insert(description_runs)
      .values({
        id: "r1",
        source: "linkedin",
        started_at: "2026-10-16T00:00:00.000Z",
        finished_at: "2026-10-16T00:01:00.000Z",
        requested: 3,
        failed: 1,
        blocked: false,
      })
      .run();
    expect(db.select().from(description_runs).get()?.blocked).toBe(false);
    db.$client.close();
  });
});
