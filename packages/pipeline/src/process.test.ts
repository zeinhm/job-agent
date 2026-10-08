import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import {
  analysis,
  companies,
  fx_rates,
  openDb,
  postings,
  type Db,
  type NewPosting,
} from "@job-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli.ts";
import { normalizeCompanyName } from "./normalize/index.ts";
import { runProcess } from "./process.ts";

const NOW = new Date("2026-10-07T03:00:00Z");
const exampleDir = join(dirname(fileURLToPath(import.meta.url)), "../../../config");

let db: Db;
let n = 0;
let configDir: string;

function add(over: Partial<NewPosting> & Pick<NewPosting, "id" | "source" | "title">) {
  n += 1;
  const row: NewPosting = {
    external_id: `e${n}`,
    url: `https://example.com/${n}`,
    company_name: "Acme Inc",
    first_seen_at: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
    last_seen_at: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
    ...over,
  };
  db.insert(postings).values(row).run();
}

function run() {
  const out: string[] = [];
  const err: string[] = [];
  const code = runProcess({
    db,
    floorIdrMonth: 10_000_000,
    now: () => NOW,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  return { code, out: out.join(""), err: err.join("") };
}

function rows() {
  return db.select().from(analysis).all();
}

function byPosting(id: string) {
  const r = rows().find((a) => a.posting_id === id);
  if (!r) throw new Error(`no analysis for ${id}`);
  return r;
}

beforeEach(() => {
  db = openDb(":memory:");
  n = 0;
  db.insert(fx_rates)
    .values({
      id: "fx1",
      date: "2026-10-06",
      base: "USD",
      quote: "IDR",
      rate: "16000",
      source: "test",
      fetched_at: NOW.toISOString(),
    })
    .run();
});

describe("runProcess", () => {
  function seedSix() {
    add({
      id: "worldwide",
      source: "remotive",
      title: "Senior Frontend Engineer",
      location_text: "Worldwide",
      remote: true,
      salary_min: 120000,
      salary_max: 150000,
      salary_currency: "USD",
      salary_period: "year",
    });
    add({
      id: "us-only",
      source: "remotive",
      title: "Senior Frontend Engineer",
      company_name: "Globex",
      location_text: "US only",
      remote: true,
    });
    add({
      id: "domestic",
      source: "remotive",
      title: "Senior Frontend Engineer",
      company_name: "Initech",
      location_text: "Worldwide",
      remote: true,
    });
    // Company known to be headquartered in Indonesia: normalize links to this row, the rule reads its HQ.
    db.insert(companies)
      .values({
        id: "c-initech",
        name: "Initech",
        normalized_name: normalizeCompanyName("Initech"),
        hq_country: "ID",
        created_at: NOW.toISOString(),
      })
      .run();
    add({
      id: "low-pay",
      source: "remotive",
      title: "Senior Frontend Engineer",
      company_name: "Umbrella",
      location_text: "Worldwide",
      remote: true,
      salary_min: 300,
      salary_max: 400,
      salary_currency: "USD",
      salary_period: "month",
    });
    add({
      id: "bare-remote",
      source: "remotive",
      title: "Senior Frontend Engineer",
      company_name: "Hooli",
      location_text: "Remote",
    });
    add({
      id: "dup",
      source: "himalayas",
      title: "Senior Frontend Engineer",
      location_text: "Worldwide",
      remote: true,
    });
  }

  it("analyses the six seeded postings: 5 rows, duplicate has none", () => {
    seedSix();
    const result = run();
    expect(result.code).toBe(0);
    expect(rows()).toHaveLength(5);
    expect(rows().some((a) => a.posting_id === "dup")).toBe(false);

    expect(byPosting("worldwide")).toMatchObject({
      decision: "keep",
      flags: "[]",
      location_class: "worldwide",
      salary_status: "listed",
      salary_idr_month_min: 160_000_000,
    });
    expect(byPosting("us-only")).toMatchObject({
      decision: "reject",
      location_class: "restricted",
    });
    expect(byPosting("domestic")).toMatchObject({ decision: "reject", indonesia_rule: "domestic" });
    expect(byPosting("low-pay")).toMatchObject({
      decision: "reject",
      salary_status: "listed",
      salary_idr_month_max: 6_400_000,
    });
    expect(byPosting("bare-remote")).toMatchObject({
      decision: "keep",
      flags: JSON.stringify(["location_unclear", "salary_unknown"]),
    });
    for (const a of rows()) {
      const reasons = JSON.parse(a.reasons ?? "[]") as string[];
      expect(reasons).toHaveLength(4);
      expect(reasons[0]).toMatch(/^location: /);
      expect(reasons[1]).toMatch(/^indonesia: /);
      expect(reasons[2]).toMatch(/^role: /);
      expect(reasons[3]).toMatch(/^salary: /);
    }
    expect(byPosting("low-pay").reasons).toContain("salary: max below floor");
    expect(result.out).toMatch(
      /^processed 5, kept 2, rejected 3 \(location 1, indonesia 1, role 0, salary 1\), flagged 3\n$/,
    );
  });

  it("rejects non-target roles with `role: ...` and flags generic titles as role_unclear", () => {
    const base = { source: "remotive", location_text: "Worldwide", remote: true } as const;
    add({ id: "sales", title: "Sales Manager", ...base });
    add({ id: "junior", title: "Junior Frontend Engineer", ...base });
    add({ id: "generic", title: "Software Engineer", ...base });
    add({ id: "target", title: "Senior Frontend Engineer", ...base });
    const result = run();
    expect(result.out).toMatch(
      /^processed 4, kept 2, rejected 2 \(location 0, indonesia 0, role 2, salary 0\), flagged 4\n$/,
    );
    expect(byPosting("sales")).toMatchObject({ decision: "reject" });
    expect(JSON.parse(byPosting("sales").reasons ?? "[]")).toContain(
      'role: non-engineering role ("sales")',
    );
    expect(byPosting("junior").decision).toBe("reject");
    expect(byPosting("generic")).toMatchObject({ decision: "keep" });
    expect(JSON.parse(byPosting("generic").flags ?? "[]")).toEqual([
      "role_unclear",
      "salary_unknown",
    ]);
    expect(JSON.parse(byPosting("target").flags ?? "[]")).toEqual(["salary_unknown"]);
  });

  it("re-analyses a no_fx posting once rates exist, but not a digested one", () => {
    db.delete(fx_rates).run();
    const pay = {
      salary_min: 300,
      salary_max: 400,
      salary_currency: "USD",
      salary_period: "month",
    } as const;
    add({
      id: "late-fx",
      source: "remotive",
      title: "Senior Frontend Engineer",
      location_text: "Worldwide",
      remote: true,
      ...pay,
    });
    add({
      id: "sent",
      source: "remotive",
      title: "Senior Frontend Engineer",
      company_name: "Globex",
      location_text: "Worldwide",
      remote: true,
      ...pay,
    });
    run();
    expect(byPosting("late-fx")).toMatchObject({ salary_status: "no_fx", decision: "keep" });
    db.update(analysis)
      .set({ digested_at: "2026-10-06" })
      .where(eq(analysis.posting_id, "sent"))
      .run();

    db.insert(fx_rates)
      .values({
        id: "fx2",
        date: "2026-10-06",
        base: "USD",
        quote: "IDR",
        rate: "16000",
        source: "test",
        fetched_at: NOW.toISOString(),
      })
      .run();
    const second = run();

    expect(second.out).toMatch(/^processed 1,/);
    expect(rows()).toHaveLength(2);
    expect(byPosting("late-fx")).toMatchObject({ salary_status: "listed", decision: "reject" });
    expect(byPosting("sent")).toMatchObject({ salary_status: "no_fx", digested_at: "2026-10-06" });
  });

  it("creates no extra rows on a second run", () => {
    seedSix();
    run();
    const before = rows()
      .map((a) => a.id)
      .sort();
    const second = run();
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/^processed 0, kept 0, rejected 0/);
    expect(
      rows()
        .map((a) => a.id)
        .sort(),
    ).toEqual(before);
  });

  it("copies digested_at to a newly canonical posting", () => {
    add({
      id: "remotive-1",
      source: "remotive",
      title: "Senior Frontend Engineer",
      location_text: "Worldwide",
      remote: true,
    });
    run();
    db.update(analysis)
      .set({ digested_at: "2026-10-06" })
      .where(eq(analysis.posting_id, "remotive-1"))
      .run();

    add({
      id: "ashby-1",
      source: "ashby",
      title: "Senior Frontend Engineer",
      location_text: "Worldwide",
      remote: true,
    });
    const result = run();
    expect(result.out).toMatch(/^processed 1,/);
    expect(
      db.select().from(postings).where(eq(postings.id, "remotive-1")).get()?.canonical_posting_id,
    ).toBe("ashby-1");
    expect(byPosting("ashby-1").digested_at).toBe("2026-10-06");
    expect(rows()).toHaveLength(2);
  });

  it("leaves digested_at null when nothing in the group was digested", () => {
    add({
      id: "a",
      source: "remotive",
      title: "Senior Frontend Engineer",
      location_text: "Worldwide",
      remote: true,
    });
    run();
    expect(byPosting("a").digested_at).toBeNull();
  });
});

describe("process command", () => {
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "job-agent-process-"));
    copyFileSync(join(exampleDir, "salary.example.yaml"), join(configDir, "salary.yaml"));
    copyFileSync(join(exampleDir, "companies.example.yaml"), join(configDir, "companies.yaml"));
    vi.stubEnv("JOB_AGENT_CONFIG_DIR", configDir);
    vi.stubEnv("JOB_AGENT_DB", ":memory:");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("runs through the CLI with the example config and prints the summary", async () => {
    const out: string[] = [];
    const code = await main(["process"], { out: (t) => out.push(t), err: () => undefined });
    expect(code).toBe(0);
    expect(out.join("")).toBe(
      "processed 0, kept 0, rejected 0 (location 0, indonesia 0, role 0, salary 0), flagged 0\n",
    );
  });

  it("reads the floor from the example config when none is passed", () => {
    add({
      id: "low-pay",
      source: "remotive",
      title: "Senior Frontend Engineer",
      location_text: "Worldwide",
      remote: true,
      salary_min: 300,
      salary_max: 400,
      salary_currency: "USD",
      salary_period: "month",
    });
    const code = runProcess({ db, now: () => NOW, out: () => undefined, err: () => undefined });
    expect(code).toBe(0);
    expect(byPosting("low-pay").decision).toBe("reject");
  });
});
