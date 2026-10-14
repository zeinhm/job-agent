import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, source_runs, type Db } from "@job-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../cli.ts";
import { freshnessSuffix, wibTime } from "./freshness.ts";
import { runDigest } from "./index.ts";

// 06:00Z = 13:00 WIB
const NOW = new Date("2026-10-07T06:00:00Z");
let db: Db;
let dir: string;
let n = 0;

function addRun(
  source: string,
  minutesAgo: number,
  status: "ok" | "error" | "skipped",
  msg?: string,
) {
  const at = new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
  db.insert(source_runs)
    .values({
      id: `r${++n}`,
      source,
      started_at: at,
      finished_at: at,
      status,
      found: 10,
      new: 3,
      error_message: msg ?? null,
    })
    .run();
}

function addRunAt(source: string, at: Date, status: "ok" | "error") {
  const iso = at.toISOString();
  db.insert(source_runs)
    .values({
      id: `r${++n}`,
      source,
      started_at: iso,
      finished_at: iso,
      status,
      found: 10,
      new: 3,
      error_message: status === "error" ? "boom" : null,
    })
    .run();
}

/** Ok runs at the given minutes-ago offsets. */
function okRuns(source: string, offsets: number[]) {
  for (const m of offsets) addRun(source, m, "ok");
}

function health(): string {
  const path = runDigest({ db, outDir: dir, date: "2026-10-07", now: () => NOW, out: () => {} });
  return readFileSync(path, "utf8");
}

beforeEach(() => {
  db = openDb(":memory:");
  dir = mkdtempSync(join(tmpdir(), "freshness-test-"));
  n = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("freshness line", () => {
  it("formats WIB time", () => {
    expect(wibTime(new Date("2026-10-07T06:05:00Z"))).toBe("13:05 WIB");
    expect(wibTime(new Date("2026-10-07T17:30:00Z"))).toBe("00:30 WIB");
  });

  it("gaps of 55 and 60 min: no LATE, shows max gap", () => {
    okRuns("linkedin", [180, 125, 65, 5]);
    expect(freshnessSuffix(db, "linkedin", NOW)).toBe("last ok 12:55 WIB, max gap 60 min in 24h");
    const text = health();
    expect(text).toContain(
      "- **linkedin**: ok, found 10, new 3 — last ok 12:55 WIB, max gap 60 min in 24h\n",
    );
    expect(text).not.toContain("LATE");
  });

  it("a 90 min gap makes LATE", () => {
    okRuns("linkedin", [165, 75, 20, 5]);
    expect(health()).toContain(
      "- **linkedin**: ok, found 10, new 3 — last ok 12:55 WIB, max gap 90 min in 24h — LATE\n",
    );
  });

  it("exactly 65 min is not late, 66 is", () => {
    okRuns("linkedin", [70, 5]);
    expect(freshnessSuffix(db, "linkedin", NOW)).not.toContain("LATE");
    addRun("linkedin", 136, "ok");
    expect(freshnessSuffix(db, "linkedin", NOW)).toContain("max gap 66 min in 24h — LATE");
  });

  it("indeed uses 130 min", () => {
    okRuns("indeed", [250, 125, 5]);
    expect(freshnessSuffix(db, "indeed", NOW)).not.toContain("LATE");
    okRuns("indeed", [400]);
    expect(freshnessSuffix(db, "indeed", NOW)).toContain("max gap 150 min in 24h — LATE");
  });

  it("ignores runs older than 24h and failed runs", () => {
    okRuns("linkedin", [2000, 65, 5]);
    addRun("linkedin", 35, "error", "boom");
    addRun("linkedin", 20, "skipped");
    expect(freshnessSuffix(db, "linkedin", NOW)).toBe("last ok 12:55 WIB, max gap 60 min in 24h");
  });

  it("one ok run: the gap is now - last ok; none: no ok run", () => {
    okRuns("linkedin", [30]);
    expect(freshnessSuffix(db, "linkedin", NOW)).toBe("last ok 12:30 WIB, max gap 30 min in 24h");
    expect(freshnessSuffix(db, "indeed", NOW)).toBe("no ok run in 24h");
  });

  it("one ok run 2 h ago is LATE for linkedin", () => {
    okRuns("linkedin", [120]);
    expect(freshnessSuffix(db, "linkedin", NOW)).toBe(
      "last ok 11:00 WIB, max gap 120 min in 24h — LATE",
    );
  });

  it("now - last ok: 65 min is not late, 66 is", () => {
    okRuns("linkedin", [65]);
    expect(freshnessSuffix(db, "linkedin", NOW)).toBe("last ok 11:55 WIB, max gap 65 min in 24h");
    db.delete(source_runs).run();
    okRuns("linkedin", [66]);
    expect(freshnessSuffix(db, "linkedin", NOW)).toBe(
      "last ok 11:54 WIB, max gap 66 min in 24h — LATE",
    );
  });

  it("ok at 05:05, then hourly errors until 10:05, now 10:10: 305 min and LATE", () => {
    const at = (hhmm: string) => new Date(`2026-10-07T${hhmm}:00Z`);
    const now = at("10:10");
    addRunAt("linkedin", at("05:05"), "ok");
    for (const h of ["06:05", "07:05", "08:05", "09:05", "10:05"])
      addRunAt("linkedin", at(h), "error");
    expect(freshnessSuffix(db, "linkedin", now)).toBe(
      "last ok 12:05 WIB, max gap 305 min in 24h — LATE",
    );
  });

  it("ok hourly up to 10:05, now 10:10: not late", () => {
    const at = (hhmm: string) => new Date(`2026-10-07T${hhmm}:00Z`);
    for (const h of ["07:05", "08:05", "09:05", "10:05"]) addRunAt("linkedin", at(h), "ok");
    expect(freshnessSuffix(db, "linkedin", at("10:10"))).toBe(
      "last ok 17:05 WIB, max gap 60 min in 24h",
    );
  });

  it("shows the backoff end after a block", () => {
    okRuns("linkedin", [260, 190, 130]);
    addRun("linkedin", 60, "error", "blocked: HTTP 429");
    addRun("linkedin", 5, "skipped", "backoff after block until 2026-10-07T07:00:00.000Z");
    const text = health();
    expect(text).toMatch(
      /- \*\*linkedin\*\*: error, .* — last ok 10:50 WIB, max gap 130 min in 24h — LATE — in backoff until 18:00 WIB/,
    );
  });

  it("sources without a threshold keep today's line", () => {
    okRuns("remotive", [200, 5]);
    expect(freshnessSuffix(db, "remotive", NOW)).toBeUndefined();
    expect(health()).toContain("- **remotive**: ok, found 10, new 3\n");
  });

  it("status prints the same freshness line", async () => {
    const file = join(dir, "t.db");
    vi.stubEnv("JOB_AGENT_DB", file);
    const real = openDb(file);
    const now = Date.now();
    for (const [i, m] of [200, 110, 5].entries()) {
      const at = new Date(now - m * 60_000).toISOString();
      real
        .insert(source_runs)
        .values({
          id: `s${i}`,
          source: "linkedin",
          started_at: at,
          finished_at: at,
          status: "ok",
          found: 4,
          new: 1,
        })
        .run();
    }
    const at = new Date(now - 60_000).toISOString();
    real
      .insert(source_runs)
      .values({
        id: "o",
        source: "remotive",
        started_at: at,
        finished_at: at,
        status: "ok",
        found: 2,
        new: 0,
      })
      .run();
    real.$client.close();
    const out: string[] = [];
    const io = { out: (t: string) => out.push(t), err: () => {} };
    expect(await main(["status"], io as never)).toBe(0);
    const text = out.join("");
    expect(text).toMatch(
      / {2}linkedin: ok, found 4, new 1 — last ok \d\d:\d\d WIB, max gap 105 min in 24h — LATE\n/,
    );
    expect(text).toContain("  remotive: ok, found 2, new 0\n");
  });
});
