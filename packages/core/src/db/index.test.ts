import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, defaultDbPath } from "./index.ts";
import { companies, postings, analysis, fx_rates } from "./schema.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("openDb", () => {
  it("opens an in-memory database and applies migrations", () => {
    const db = openDb(":memory:");
    expect(db.$client.open).toBe(true);
    expect(db.$client.pragma("user_version", { simple: true })).toBe(0);
    db.$client.close();
  });

  it("creates the parent directory of a file path", () => {
    const dir = mkdtempSync(join(tmpdir(), "job-agent-"));
    try {
      const file = join(dir, "nested", "deeper", "test.db");
      const db = openDb(file);
      db.$client.close();
      expect(existsSync(file)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent: running twice on the same file db produces no error", () => {
    const dir = mkdtempSync(join(tmpdir(), "job-agent-"));
    try {
      const file = join(dir, "test.db");
      const db1 = openDb(file);
      db1.$client.close();
      const db2 = openDb(file);
      db2.$client.close();
      // No error thrown, migrations applied cleanly twice
      expect(true).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates all five phase-1 tables", () => {
    const db = openDb(":memory:");
    const tables = db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const tableNames = tables
      .map((t) => t.name)
      .filter((name) => !name.startsWith("__")) // Exclude drizzle's internal tables
      .sort();
    expect(tableNames).toEqual(["analysis", "companies", "fx_rates", "postings", "source_runs"]);
    db.$client.close();
  });
});

describe("Schema constraints", () => {
  it("rejects duplicate (source, external_id) in postings", () => {
    const db = openDb(":memory:");

    db.insert(postings)
      .values({
        id: "p1",
        source: "greenhouse",
        external_id: "12345",
        url: "https://example.com/job1",
        title: "Test Job",
        company_name: "Test Co",
        first_seen_at: "2026-10-07T00:00:00Z",
        last_seen_at: "2026-10-07T00:00:00Z",
      })
      .run();

    expect(() => {
      db.insert(postings)
        .values({
          id: "p2",
          source: "greenhouse",
          external_id: "12345",
          url: "https://example.com/job2",
          title: "Test Job 2",
          company_name: "Test Co",
          first_seen_at: "2026-10-07T00:00:00Z",
          last_seen_at: "2026-10-07T00:00:00Z",
        })
        .run();
    }).toThrow(/UNIQUE constraint failed/);

    db.$client.close();
  });

  it("rejects invalid location_class enum value in analysis", () => {
    const db = openDb(":memory:");

    // Insert a posting first
    db.insert(postings)
      .values({
        id: "p1",
        source: "greenhouse",
        external_id: "12345",
        url: "https://example.com/job1",
        title: "Test Job",
        company_name: "Test Co",
        first_seen_at: "2026-10-07T00:00:00Z",
        last_seen_at: "2026-10-07T00:00:00Z",
      })
      .run();

    // Try to insert analysis with invalid location_class
    expect(() => {
      db.insert(analysis)
        .values({
          id: "a1",
          posting_id: "p1",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          location_class: "maybe" as any, // Invalid value
          indonesia_rule: "not_applicable",
          salary_status: "unknown",
          decision: "keep",
          analyzed_at: "2026-10-07T00:00:00Z",
        })
        .run();
    }).toThrow(/CHECK constraint failed/);

    db.$client.close();
  });

  it("rejects duplicate (date, base, quote) in fx_rates", () => {
    const db = openDb(":memory:");

    db.insert(fx_rates)
      .values({
        id: "fx1",
        date: "2026-10-07",
        base: "USD",
        quote: "IDR",
        rate: "15000",
        source: "xe.com",
        fetched_at: "2026-10-07T00:00:00Z",
      })
      .run();

    expect(() => {
      db.insert(fx_rates)
        .values({
          id: "fx2",
          date: "2026-10-07",
          base: "USD",
          quote: "IDR",
          rate: "15100",
          source: "oanda.com",
          fetched_at: "2026-10-07T01:00:00Z",
        })
        .run();
    }).toThrow(/UNIQUE constraint failed/);

    db.$client.close();
  });

  it("enforces unique posting_id in analysis", () => {
    const db = openDb(":memory:");

    // Insert a posting
    db.insert(postings)
      .values({
        id: "p1",
        source: "greenhouse",
        external_id: "12345",
        url: "https://example.com/job1",
        title: "Test Job",
        company_name: "Test Co",
        first_seen_at: "2026-10-07T00:00:00Z",
        last_seen_at: "2026-10-07T00:00:00Z",
      })
      .run();

    // Insert first analysis
    db.insert(analysis)
      .values({
        id: "a1",
        posting_id: "p1",
        location_class: "worldwide",
        indonesia_rule: "not_applicable",
        salary_status: "unknown",
        decision: "keep",
        analyzed_at: "2026-10-07T00:00:00Z",
      })
      .run();

    // Try to insert second analysis for same posting
    expect(() => {
      db.insert(analysis)
        .values({
          id: "a2",
          posting_id: "p1",
          location_class: "worldwide",
          indonesia_rule: "not_applicable",
          salary_status: "unknown",
          decision: "keep",
          analyzed_at: "2026-10-07T00:00:00Z",
        })
        .run();
    }).toThrow(/UNIQUE constraint failed/);

    db.$client.close();
  });

  it("allows nullable canonical_posting_id (duplicates point to canonical)", () => {
    const db = openDb(":memory:");

    // Insert canonical posting
    db.insert(postings)
      .values({
        id: "p1-canonical",
        source: "greenhouse",
        external_id: "12345",
        url: "https://example.com/job1",
        title: "Test Job",
        company_name: "Test Co",
        first_seen_at: "2026-10-07T00:00:00Z",
        last_seen_at: "2026-10-07T00:00:00Z",
      })
      .run();

    // Insert duplicate posting pointing at canonical
    db.insert(postings)
      .values({
        id: "p1-duplicate",
        source: "linkedin",
        external_id: "67890",
        url: "https://linkedin.com/job",
        title: "Test Job",
        company_name: "Test Co",
        first_seen_at: "2026-10-07T00:00:00Z",
        last_seen_at: "2026-10-07T00:00:00Z",
        canonical_posting_id: "p1-canonical",
      })
      .run();

    const result = db.select().from(postings).where(eq(postings.id, "p1-duplicate")).all();

    expect(result).toHaveLength(1);
    expect(result[0]?.canonical_posting_id).toBe("p1-canonical");

    db.$client.close();
  });

  it("enforces unique normalized_name in companies", () => {
    const db = openDb(":memory:");

    db.insert(companies)
      .values({
        id: "c1",
        name: "Test Company",
        normalized_name: "test-company",
        created_at: "2026-10-07T00:00:00Z",
      })
      .run();

    expect(() => {
      db.insert(companies)
        .values({
          id: "c2",
          name: "Test Company Inc",
          normalized_name: "test-company",
          created_at: "2026-10-07T00:00:00Z",
        })
        .run();
    }).toThrow(/UNIQUE constraint failed/);

    db.$client.close();
  });

  it("validates salary_status enum in analysis", () => {
    const db = openDb(":memory:");

    db.insert(postings)
      .values({
        id: "p1",
        source: "greenhouse",
        external_id: "12345",
        url: "https://example.com/job1",
        title: "Test Job",
        company_name: "Test Co",
        first_seen_at: "2026-10-07T00:00:00Z",
        last_seen_at: "2026-10-07T00:00:00Z",
      })
      .run();

    // Invalid salary_status
    expect(() => {
      db.insert(analysis)
        .values({
          id: "a1",
          posting_id: "p1",
          location_class: "worldwide",
          indonesia_rule: "not_applicable",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          salary_status: "invalid" as any,
          decision: "keep",
          analyzed_at: "2026-10-07T00:00:00Z",
        })
        .run();
    }).toThrow(/CHECK constraint failed/);

    db.$client.close();
  });

  it("validates decision enum in analysis", () => {
    const db = openDb(":memory:");

    db.insert(postings)
      .values({
        id: "p1",
        source: "greenhouse",
        external_id: "12345",
        url: "https://example.com/job1",
        title: "Test Job",
        company_name: "Test Co",
        first_seen_at: "2026-10-07T00:00:00Z",
        last_seen_at: "2026-10-07T00:00:00Z",
      })
      .run();

    // Invalid decision
    expect(() => {
      db.insert(analysis)
        .values({
          id: "a1",
          posting_id: "p1",
          location_class: "worldwide",
          indonesia_rule: "not_applicable",
          salary_status: "unknown",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          decision: "maybe" as any,
          analyzed_at: "2026-10-07T00:00:00Z",
        })
        .run();
    }).toThrow(/CHECK constraint failed/);

    db.$client.close();
  });
});

describe("defaultDbPath", () => {
  it("falls back to data/job-agent.db", () => {
    vi.stubEnv("JOB_AGENT_DB", undefined);
    expect(defaultDbPath()).toBe("data/job-agent.db");
  });

  it("honours JOB_AGENT_DB", () => {
    vi.stubEnv("JOB_AGENT_DB", "/tmp/custom.db");
    expect(defaultDbPath()).toBe("/tmp/custom.db");
  });
});
