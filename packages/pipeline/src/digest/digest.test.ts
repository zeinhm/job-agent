import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analysis, intel, openDb, postings, source_runs, type Db } from "@job-agent/core";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../cli.ts";
import { formatSalary, isDigestDate, jakartaDate, runDigest } from "./index.ts";

const NOW = new Date("2026-10-07T03:00:00Z");
const DATE = "2026-10-07";

let db: Db;
let dir: string;
let n = 0;

function seed(
  id: string,
  over: {
    source?: string;
    title?: string;
    posted?: string | null;
    decision?: "keep" | "reject";
    flags?: string[];
    reasons?: string[];
    locationClass?: "worldwide" | "apac_ok" | "restricted" | "unclear";
    indonesia?: "not_applicable" | "domestic";
    canonical?: string;
    company?: string;
    location?: string;
    digestedAt?: string | null;
    salaryStatus?: "listed" | "unknown" | "unparsed" | "no_fx";
    min?: number | null;
    max?: number | null;
    analyzedAt?: string;
    applyUrl?: string;
  } = {},
) {
  n += 1;
  db.insert(postings)
    .values({
      id,
      source: over.source ?? "remotive",
      external_id: `e${n}`,
      url: `https://example.com/jobs/${id}`,
      apply_url: over.applyUrl ?? null,
      title: over.title ?? `Job ${id}`,
      company_name: over.company ?? "Acme Inc",
      location_text: over.location ?? "Worldwide",
      posted_at: over.posted === undefined ? "2026-10-05T00:00:00Z" : over.posted,
      first_seen_at: NOW.toISOString(),
      last_seen_at: NOW.toISOString(),
      canonical_posting_id: over.canonical ?? null,
    })
    .run();
  if (over.canonical !== undefined) return;
  db.insert(analysis)
    .values({
      id: `a-${id}`,
      posting_id: id,
      location_class: over.locationClass ?? "worldwide",
      indonesia_rule: over.indonesia ?? "not_applicable",
      salary_status: over.salaryStatus ?? "listed",
      salary_idr_month_min: over.min === undefined ? 25_000_000 : over.min,
      salary_idr_month_max: over.max === undefined ? 30_000_000 : over.max,
      decision: over.decision ?? "keep",
      flags: JSON.stringify(over.flags ?? []),
      reasons: JSON.stringify(over.reasons ?? []),
      analyzed_at: over.analyzedAt ?? "2026-10-07T01:00:00Z",
      digested_at: over.digestedAt ?? null,
    })
    .run();
}

function run(opts: { date?: string; now?: Date } = {}) {
  const out: string[] = [];
  const path = runDigest({
    db,
    outDir: dir,
    now: () => opts.now ?? NOW,
    ...(opts.date !== undefined ? { date: opts.date } : {}),
    out: (t) => out.push(t),
  });
  return { path, out: out.join(""), text: readFileSync(path, "utf8") };
}

function run1(
  id: string,
  source: string,
  status: "ok" | "error" | "skipped",
  startedAt: string,
  msg?: string,
) {
  db.insert(source_runs)
    .values({
      id: `r-${id}`,
      source,
      started_at: startedAt,
      finished_at: startedAt,
      status,
      found: 10,
      new: 3,
      error_message: msg ?? null,
    })
    .run();
}

function seedDay() {
  seed("m1", { title: "Older Match", posted: "2026-10-01T00:00:00Z" });
  seed("m2", { title: "Newest Match", posted: "2026-10-06T00:00:00Z" });
  seed("m3", { title: "Undated Match", posted: null });
  seed("f1", {
    title: "Old Flagged",
    flags: ["salary_unknown"],
    salaryStatus: "unknown",
    posted: "2026-10-02T00:00:00Z",
  });
  seed("f2", {
    title: "New Flagged",
    flags: ["location_unclear"],
    locationClass: "unclear",
    posted: "2026-10-06T00:00:00Z",
  });
  seed("r1", { decision: "reject", locationClass: "restricted", reasons: ["location: us only"] });
  seed("r2", {
    decision: "reject",
    reasons: ["location: ok", "salary: max below floor"],
  });
  seed("d1", { source: "himalayas", canonical: "m2" });
  seed("d2", { source: "hn", canonical: "m2" });
}

beforeEach(() => {
  db = openDb(":memory:");
  dir = mkdtempSync(join(tmpdir(), "digest-test-"));
  n = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("formatSalary", () => {
  const base = { status: "listed", idrMonthMin: null, idrMonthMax: null } as const;
  it("formats a range", () => {
    expect(formatSalary({ ...base, idrMonthMin: 25_000_000, idrMonthMax: 30_000_000 })).toBe(
      "IDR 25.0M–30.0M / month",
    );
  });
  it("formats min only", () => {
    expect(formatSalary({ ...base, idrMonthMin: 25_000_000 })).toBe("from IDR 25.0M / month");
  });
  it("formats max only", () => {
    expect(formatSalary({ ...base, idrMonthMax: 30_000_000 })).toBe("up to IDR 30.0M / month");
  });
  it("rounds to one decimal", () => {
    expect(formatSalary({ ...base, idrMonthMin: 24_960_000, idrMonthMax: 30_040_000 })).toBe(
      "IDR 25.0M–30.0M / month",
    );
  });
  it("formats non-listed statuses", () => {
    expect(formatSalary({ ...base, status: "unknown" })).toBe("salary unknown");
    expect(formatSalary({ ...base, status: "unparsed" })).toBe("salary not parsed");
    expect(formatSalary({ ...base, status: "no_fx" })).toBe("no FX rate");
  });
});

describe("dates", () => {
  it("uses Asia/Jakarta for the default date", () => {
    expect(jakartaDate(new Date("2026-10-06T18:00:00Z"))).toBe("2026-10-07");
    expect(jakartaDate(new Date("2026-10-06T16:00:00Z"))).toBe("2026-10-06");
  });
  it("validates the date", () => {
    expect(isDigestDate("2026-10-07")).toBe(true);
    expect(isDigestDate("2026-02-30")).toBe(false);
    expect(isDigestDate("10/07/2026")).toBe(false);
  });
});

describe("runDigest", () => {
  it("lists matches and needs-a-look in order, duplicates only as extra sources", () => {
    seedDay();
    const { text, path, out } = run();
    expect(path).toBe(join(dir, `${DATE}.md`));
    expect(out).toBe(`${path}\n`);

    // No intel yet: every kept posting is listed under Waiting for scoring, newest first.
    const waiting = text.slice(
      text.indexOf("## Waiting for scoring"),
      text.indexOf("## Needs a look"),
    );
    const looks = text.slice(text.indexOf("## Needs a look"), text.indexOf("## Suspicious"));
    expect(waiting.match(/^### /gm)).toHaveLength(5);
    expect(waiting.indexOf("Newest Match")).toBeLessThan(waiting.indexOf("Older Match"));
    expect(waiting.indexOf("Older Match")).toBeLessThan(waiting.indexOf("Undated Match"));
    expect(looks).toContain("- New Flagged — Acme Inc: location_unclear");
    expect(looks).not.toContain("Old Flagged");

    // Duplicates are not separate entries.
    expect(text).not.toContain("### Job d1");
    expect(text).toContain("- Sources: remotive, himalayas, hn");
    expect(text).toContain("- Salary: IDR 25.0M–30.0M / month");
    expect(text).toContain("- Salary: salary unknown");
    expect(text).toContain("- Flags: location_unclear");
    expect(text).toContain("- Location: unclear — Worldwide");
    expect(text).toContain("- Posted: unknown");
    expect(text).toContain("- Kept: 5");
    expect(text).toContain("- Waiting for scoring: 5");
    expect(text).toContain(
      "- Rejected in the last 24h: 2 (location 1, indonesia 0, role 0, salary 1)",
    );
    expect(text).not.toContain("Job r1");
  });

  it("shows role_unclear postings under Needs a look and counts role rejects", () => {
    seed("ok", { title: "Senior Frontend Engineer" });
    seed("gen", { title: "Staff Engineer", flags: ["role_unclear"] });
    seed("sales", {
      title: "Sales Manager",
      decision: "reject",
      reasons: ["role: non-engineering"],
    });
    const { text } = run();
    const looks = text.slice(text.indexOf("## Needs a look"), text.indexOf("## Suspicious"));
    expect(looks).toContain("- Staff Engineer — Acme Inc: role_unclear");
    expect(text).toContain("- Flags: role_unclear");
    expect(text).toContain(
      "- Rejected in the last 24h: 1 (location 0, indonesia 0, role 1, salary 0)",
    );
  });

  it("links the apply url for ATS canonicals and the posting url otherwise", () => {
    seed("ats", { source: "greenhouse", applyUrl: "https://apply.example.com/ats" });
    seed("api", { source: "remotive", applyUrl: "https://apply.example.com/api" });
    const { text } = run();
    expect(text).toContain("- Link: https://apply.example.com/ats");
    expect(text).toContain("- Link: https://example.com/jobs/api");
    expect(text).not.toContain("apply.example.com/api");
  });

  it.each(["smartrecruiters", "workable", "recruitee"])(
    "links the ATS apply url for a %s posting",
    (source) => {
      seed("ats", { source, applyUrl: "https://apply.example.com/ats" });
      expect(run().text).toContain("- Link: https://apply.example.com/ats");
    },
  );

  it("is idempotent and picks up newly kept postings under the same date", () => {
    seedDay();
    const first = run();
    expect(run().text).toBe(first.text);

    seed("late", { title: "Late Match" });
    const second = run();
    expect(second.text).toContain("### Late Match");
    expect(second.text).toContain("### Newest Match");
    expect(
      db.select().from(analysis).where(eq(analysis.posting_id, "late")).get()?.digested_at,
    ).toBe(DATE);
    expect(run().text).toBe(second.text);
  });

  it("groups same company + title across locations into one entry and stamps all", () => {
    seed("g1", { title: "Backend Engineer", location: "Berlin", posted: "2026-10-03T00:00:00Z" });
    seed("g2", {
      title: "Backend Engineer",
      location: "Austin",
      source: "greenhouse",
      applyUrl: "https://apply.example.com/g2",
    });
    seed("g3", { title: "backend engineer", location: "Lisbon", company: "ACME" });
    seed("g4", { title: "Backend Engineer", location: "Lisbon", company: "Globex" });
    const { text } = run();
    expect(text.match(/^### /gm)).toHaveLength(2);
    expect(text).toContain("- Location: worldwide — Austin; Berlin; Lisbon");
    expect(text).toContain("- Link: https://apply.example.com/g2");
    expect(text).toContain("- Kept: 2");
    for (const id of ["g1", "g2", "g3", "g4"]) {
      expect(db.select().from(analysis).where(eq(analysis.posting_id, id)).get()?.digested_at).toBe(
        DATE,
      );
    }
    expect(run().text).toBe(text);
  });

  it("caps joined locations at 5 with +N more", () => {
    for (const c of "abcdefg") seed(`l${c}`, { title: "Same", location: `City ${c}` });
    const { text } = run();
    expect(text).toContain("City a; City b; City c; City d; City e; +2 more");
  });

  it("does not show a posting stamped on an earlier day", () => {
    seed("old", { title: "Yesterday Match", digestedAt: "2026-10-06" });
    seed("new", { title: "Today Match" });
    // Scored on an earlier day: done, nothing left to wait for.
    db.insert(intel)
      .values({
        id: "i-old",
        posting_id: "old",
        status: "done",
        final_decision: "keep",
        fit_score: 70,
        updated_at: "2026-10-06T01:00:00Z",
      })
      .run();
    const { text } = run();
    expect(text).toContain("Today Match");
    expect(text).not.toContain("Yesterday Match");
  });

  it("stamps with the --date value", () => {
    seed("x");
    run({ date: "2026-10-09" });
    expect(db.select().from(analysis).get()?.digested_at).toBe("2026-10-09");
  });

  it("reports source errors and sources without an ok run in 24h", () => {
    run1("1", "greenhouse", "ok", "2026-10-07T01:00:00Z");
    run1("2", "remotive", "ok", "2026-10-06T20:00:00Z");
    run1("3", "remotive", "error", "2026-10-07T02:00:00Z", "HTTP 503\nfrom remotive");
    run1("4", "hn", "ok", "2026-10-01T00:00:00Z");
    const { text } = run();
    const health = text.slice(text.indexOf("## Source health"));
    expect(health).toContain("- **greenhouse**: ok, found 10, new 3\n");
    expect(health).toContain(
      "- **remotive**: error, found 10, new 3, error: HTTP 503 from remotive\n",
    );
    expect(health).toContain("- **hn**: no run in the last 24h — NO SUCCESSFUL RUN");
    expect(health).not.toMatch(/remotive.*NO SUCCESSFUL RUN/);
  });

  it("ignores skipped runs when picking the latest run, and labels ok-run notes as warnings", () => {
    run1("1", "greenhouse", "ok", "2026-10-07T01:00:00Z", "1 board not found: gone");
    run1("2", "greenhouse", "skipped", "2026-10-07T02:00:00Z");
    const { text } = run();
    expect(text).toContain(
      "- **greenhouse**: ok, found 10, new 3, warning: 1 board not found: gone\n",
    );
    expect(text).not.toContain("skipped");
  });

  it("marks a source whose only recent runs failed", () => {
    run1("1", "remotive", "error", "2026-10-07T02:00:00Z", "boom");
    expect(run().text).toContain("error: boom — NO SUCCESSFUL RUN");
  });

  it("writes an empty day with the source health section", () => {
    run1("1", "greenhouse", "ok", "2026-10-07T01:00:00Z");
    const { text } = run();
    expect(text).toContain("None scored yet.");
    expect(text).not.toContain("### ");
    expect(text).toContain("- Kept: 0");
    expect(text).toContain("## Source health");
    expect(text).toContain("- **greenhouse**: ok");
  });

  it("rejects an invalid date", () => {
    expect(() => run({ date: "nope" })).toThrow(/Invalid date/);
  });
});

describe("cli digest", () => {
  it("fails on an invalid date without writing", async () => {
    const prev = process.env["JOB_AGENT_DB"];
    process.env["JOB_AGENT_DB"] = join(dir, "t.db");
    const err: string[] = [];
    try {
      const code = await main(["digest", "--date", "bad"], {
        out: () => {},
        err: (t) => err.push(t),
      });
      expect(code).toBe(1);
      expect(err.join("")).toContain("Invalid date");
    } finally {
      if (prev === undefined) delete process.env["JOB_AGENT_DB"];
      else process.env["JOB_AGENT_DB"] = prev;
    }
  });
});
