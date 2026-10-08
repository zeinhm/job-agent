import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  analysis,
  openDb,
  postings,
  source_runs,
  type Db,
  type NewAnalysis,
  type NewPosting,
} from "@job-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../cli.ts";
import { formatSalary, runDigest } from "./index.ts";

const NOW = new Date("2026-10-08T03:00:00Z");
const DATE = "2026-10-08";

let db: Db;
let dir: string;
let n = 0;

function add(
  id: string,
  over: Partial<NewPosting> = {},
  a: Partial<NewAnalysis> = {},
  withAnalysis = true,
) {
  n += 1;
  db.insert(postings)
    .values({
      id,
      source: "remotive",
      external_id: `e${n}`,
      url: `https://example.com/${id}`,
      title: `Title ${id}`,
      company_name: `Co ${id}`,
      first_seen_at: NOW.toISOString(),
      last_seen_at: NOW.toISOString(),
      ...over,
    })
    .run();
  if (withAnalysis) {
    db.insert(analysis)
      .values({
        id: `a-${id}`,
        posting_id: id,
        location_class: "worldwide",
        indonesia_rule: "not_applicable",
        salary_status: "unknown",
        decision: "keep",
        flags: "[]",
        reasons: "[]",
        analyzed_at: NOW.toISOString(),
        ...a,
      })
      .run();
  }
}

function run(over: { date?: string; now?: Date } = {}) {
  return runDigest({
    db,
    dir,
    now: () => over.now ?? NOW,
    ...(over.date ? { date: over.date } : {}),
  });
}

function seed() {
  add("m1", { posted_at: "2026-10-01T00:00:00Z", location_text: "Worldwide" });
  add(
    "m2",
    { posted_at: "2026-10-05T00:00:00Z" },
    { salary_status: "listed", salary_idr_month_min: 25_000_000, salary_idr_month_max: 30_000_000 },
  );
  add("m3", {});
  add(
    "f1",
    { posted_at: "2026-10-03T00:00:00Z" },
    { location_class: "unclear", flags: '["location_unclear"]' },
  );
  add(
    "f2",
    {
      posted_at: "2026-10-06T00:00:00Z",
      source: "greenhouse",
      apply_url: "https://apply.example.com/f2",
    },
    { salary_status: "unparsed", flags: '["salary_unparsed"]' },
  );
  add("r1", {}, { decision: "reject", location_class: "restricted" });
  add("r2", {}, { decision: "reject", salary_status: "listed" });
  add("dup", { source: "himalayas", canonical_posting_id: "m2", title: "Dup title" }, {}, false);
}

beforeEach(() => {
  db = openDb(":memory:");
  dir = mkdtempSync(join(tmpdir(), "job-agent-digest-"));
  n = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("formatSalary", () => {
  it("formats ranges and open-ended salaries", () => {
    const base = { status: "listed" as const };
    expect(formatSalary({ ...base, idrMonthMin: 25_000_000, idrMonthMax: 30_000_000 })).toBe(
      "IDR 25.0M–30.0M / month",
    );
    expect(formatSalary({ ...base, idrMonthMin: 25_000_000, idrMonthMax: null })).toBe(
      "from IDR 25.0M / month",
    );
    expect(formatSalary({ ...base, idrMonthMin: null, idrMonthMax: 30_000_000 })).toBe(
      "up to IDR 30.0M / month",
    );
    expect(formatSalary({ ...base, idrMonthMin: 25_000_000, idrMonthMax: 25_000_000 })).toBe(
      "IDR 25.0M / month",
    );
    expect(formatSalary({ ...base, idrMonthMin: 12_340_000, idrMonthMax: 30_000_000 })).toBe(
      "IDR 12.3M–30.0M / month",
    );
  });

  it("covers non-listed statuses", () => {
    const n = { idrMonthMin: null, idrMonthMax: null };
    expect(formatSalary({ status: "unknown", ...n })).toBe("salary unknown");
    expect(formatSalary({ status: "unparsed", ...n })).toBe("salary not parsed");
    expect(formatSalary({ status: "no_fx", ...n })).toBe("no FX rate");
  });
});

describe("runDigest", () => {
  it("lists matches and needs-a-look in order, duplicates only as extra sources", () => {
    seed();
    const { path, content } = run();
    expect(path).toBe(join(dir, `${DATE}.md`));
    expect(content).toContain("- Kept today: 5");
    expect(content).toContain("- Flagged: 2");
    expect(content).toContain("- Rejected in the last 24h: 2 (location 1, indonesia 0, salary 1)");

    const titles = [...content.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    expect(titles).toEqual([
      "Title m2 — Co m2",
      "Title m1 — Co m1",
      "Title m3 — Co m3",
      "Title f2 — Co f2",
      "Title f1 — Co f1",
    ]);
    expect(content.indexOf("## Matches")).toBeLessThan(content.indexOf("### Title m2"));
    expect(content.indexOf("### Title m3")).toBeLessThan(content.indexOf("## Needs a look"));
    expect(content.indexOf("## Needs a look")).toBeLessThan(content.indexOf("### Title f2"));
    expect(content).not.toContain("Dup title");
    expect(content).toContain("- Sources: remotive, himalayas");
    expect(content).toContain("- Salary: IDR 25.0M–30.0M / month");
    expect(content).toContain("- Salary: salary not parsed");
    expect(content).toContain("- Flags: location_unclear");
    expect(content).toContain("- Link: https://apply.example.com/f2");
    expect(content).toContain("- Link: https://example.com/m1");
    expect(content).toContain("- Location: worldwide — Worldwide");
    expect(content).toContain("- Posted: 2026-10-05");
    expect(content).toContain("- Posted: date unknown");
    expect(content).not.toContain("Rejected title");
  });

  it("uses url, not apply_url, for non-ATS sources", () => {
    add("x", { apply_url: "https://apply.example.com/x" });
    expect(run().content).toContain("- Link: https://example.com/x");
  });

  it("is idempotent and adds postings kept after the first run with the same date", () => {
    seed();
    const first = run().content;
    expect(run().content).toBe(first);
    add("late", { posted_at: "2026-10-07T00:00:00Z" });
    const third = run().content;
    expect(third).toContain("### Title late — Co late");
    expect(third).toContain("- Kept today: 6");
    expect(
      db.select().from(analysis).where(eq(analysis.posting_id, "late")).get()?.digested_at,
    ).toBe(DATE);
    expect(readFileSync(join(dir, `${DATE}.md`), "utf8")).toBe(third);
  });

  it("does not list a posting stamped on an earlier date", () => {
    add("old", {}, { digested_at: "2026-10-07" });
    add("new", {});
    const { content } = run();
    expect(content).toContain("### Title new");
    expect(content).not.toContain("Title old");
    expect(run({ date: "2026-10-07" }).content).toContain("### Title old");
  });

  it("reports source health with errors and sources lacking an ok run", () => {
    const hours = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
    const runRow = (
      id: string,
      source: string,
      status: "ok" | "error",
      h: number,
      msg: string | null = null,
    ) =>
      db
        .insert(source_runs)
        .values({
          id,
          source,
          started_at: hours(h),
          finished_at: hours(h),
          status,
          found: 7,
          new: 3,
          error_message: msg,
        })
        .run();
    runRow("1", "lever", "ok", 2);
    runRow("2", "remotive", "ok", 10);
    runRow("3", "remotive", "error", 1, "HTTP 503 from upstream");
    runRow("4", "ashby", "ok", 30);
    runRow("5", "hn", "error", 5, "boom");
    const { content } = run();
    const health = content.slice(content.indexOf("## Source health"));
    expect(health).toContain("- lever: ok, found 7, new 3\n");
    expect(health).toContain("- remotive: error, found 7, new 3, error: HTTP 503 from upstream\n");
    expect(health).toContain("- hn: error, found 7, new 3, error: boom — NO SUCCESSFUL RUN");
    expect(health).toContain("- ashby: no run in the last 24h — NO SUCCESSFUL RUN");
    expect(health).not.toMatch(/- (lever|remotive).*NO SUCCESSFUL RUN/);
  });

  it("writes a file on an empty day", () => {
    const { path, content } = run();
    expect(existsSync(path)).toBe(true);
    expect(content).toContain("No new matches");
    expect(content).toContain("- Kept today: 0");
    expect(content).toContain("## Source health");
  });

  it("only digests canonical kept postings with analysis", () => {
    add("rej", {}, { decision: "reject" });
    add("unanalysed", {}, {}, false);
    const { content } = run();
    expect(content).not.toContain("###");
    expect(
      db.select().from(analysis).where(eq(analysis.posting_id, "rej")).get()?.digested_at,
    ).toBeNull();
  });

  it("rejects a malformed date", () => {
    expect(() => run({ date: "2026-13-40" })).toThrow(/Invalid date/);
  });
});

describe("digest command", () => {
  it("writes under the given folder's data/digests, prints the path, rejects bad dates", async () => {
    const cwd = process.cwd();
    const work = mkdtempSync(join(tmpdir(), "job-agent-digest-cli-"));
    vi.stubEnv("JOB_AGENT_DB", join(work, "t.db"));
    process.chdir(work);
    try {
      const out: string[] = [];
      const err: string[] = [];
      const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };
      expect(await main(["digest", "--date", "2026-10-08"], io)).toBe(0);
      expect(out.join("")).toBe(join("data", "digests", "2026-10-08.md") + "\n");
      expect(existsSync(join(work, "data", "digests", "2026-10-08.md"))).toBe(true);
      expect(await main(["digest", "--date", "nope"], io)).toBe(1);
      expect(err.join("")).toContain("Invalid date");
    } finally {
      process.chdir(cwd);
      rmSync(work, { recursive: true, force: true });
    }
  });
});
