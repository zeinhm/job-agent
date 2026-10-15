import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceBlockedError, SourceSkippedError } from "@job-agent/core";
import { describe, expect, it, vi } from "vitest";
import {
  INDEED_MIN_INTERVAL_MINUTES,
  INDEED_RESULTS_WANTED,
  INDEED_SEARCHES,
  createIndeedAdapter,
} from "./index.ts";
import { NOT_INSTALLED, type WorkerRunner, type WorkerSearch } from "./worker.ts";

const NOW = new Date("2026-10-14T12:00:00Z");
const job = (key: string, extra: Record<string, unknown> = {}) => ({
  id: `in-${key}`,
  site: "indeed",
  job_url: `https://www.indeed.com/viewjob?jk=${key}`,
  job_url_direct: null,
  title: "Senior Frontend Engineer",
  company: "Example Co",
  location: "Remote",
  date_posted: "2026-10-14T00:00:00.000",
  is_remote: true,
  min_amount: null,
  max_amount: null,
  currency: null,
  interval: null,
  description: null,
  ...extra,
});
const lines = (...items: unknown[]) => items.map((i) => JSON.stringify(i)).join("\n");
const ok = (stdout: string) => ({ exitCode: 0, stdout });
const make = (runWorker: WorkerRunner) =>
  createIndeedAdapter({ runWorker, sleep: async () => undefined, now: () => NOW });

describe("indeed lookback", () => {
  it("sends the computed hours_old to both searches and in smoke mode", async () => {
    const since = new Date(NOW.getTime() - 130 * 60_000);
    for (const smoke of [false, true]) {
      const seen: WorkerSearch[] = [];
      await createIndeedAdapter({
        smoke,
        sleep: async () => undefined,
        now: () => NOW,
        runWorker: async (s) => {
          seen.push(s);
          return ok("");
        },
      }).fetch(since);
      expect(seen).toHaveLength(smoke ? 1 : 2);
      for (const s of seen) expect(s.hours_old).toBe(3);
    }
  });
});

describe("indeed searches", () => {
  it("builds both searches with the research parameters", () => {
    expect(INDEED_SEARCHES).toEqual([
      {
        site: "indeed",
        search_term: 'senior frontend OR "full stack" OR react OR typescript',
        is_remote: true,
        results_wanted: 50,
        country: "usa",
      },
      {
        site: "indeed",
        search_term: 'senior frontend OR "full stack" OR react OR typescript',
        location: "Indonesia",
        is_remote: true,
        results_wanted: 50,
        country: "indonesia",
      },
    ]);
    expect(INDEED_MIN_INTERVAL_MINUTES).toBe(110);
    expect(INDEED_RESULTS_WANTED).toBeLessThanOrEqual(50);
  });

  it("sends exactly those searches to the worker, in order, and has a 2 h interval", async () => {
    const seen: WorkerSearch[] = [];
    const adapter = make(async (s) => {
      seen.push(s);
      return ok("");
    });
    await adapter.fetch(NOW);
    expect(adapter.name).toBe("indeed");
    expect(adapter.minIntervalMinutes).toBe(110);
    // since = now -> 1 h lookback on top of the fixed searches
    expect(seen).toEqual(INDEED_SEARCHES.map((x) => ({ ...x, hours_old: 1 })));
  });

  it("smoke mode runs one search with at most 10 results", async () => {
    const seen: WorkerSearch[] = [];
    await createIndeedAdapter({
      smoke: true,
      sleep: async () => undefined,
      runWorker: async (s) => {
        seen.push(s);
        return ok("");
      },
    }).fetch(NOW);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ site: "indeed", results_wanted: 10, is_remote: true });
  });
});

describe("indeed mapping", () => {
  it("maps every field, salary interval to period and job_url_direct to applyUrl", async () => {
    const full = job("abc123", {
      job_url_direct: "https://boards.example.com/apply/1",
      description: "Build things.",
      min_amount: 4000,
      max_amount: 6000,
      currency: "EUR",
      interval: "monthly",
    });
    const [p, ...rest] = await make(async (s) => ok(s.country === "usa" ? lines(full) : "")).fetch(
      NOW,
    );
    expect(rest).toEqual([]);
    expect(p).toEqual({
      source: "indeed",
      externalId: "abc123",
      url: "https://www.indeed.com/viewjob?jk=abc123",
      applyUrl: "https://boards.example.com/apply/1",
      title: "Senior Frontend Engineer",
      company: "Example Co",
      descriptionText: "Build things.",
      locationText: "Remote",
      remote: true,
      salaryText: "EUR 4000-6000 / monthly",
      salary: { min: 4000, max: 6000, currency: "EUR", period: "month" },
      postedAt: "2026-10-14T00:00:00.000Z",
    });
  });

  it.each([
    ["yearly", "year"],
    ["monthly", "month"],
    ["hourly", "hour"],
  ])("interval %s -> period %s", async (interval, period) => {
    const [p] = await make(async () =>
      ok(lines(job("k1", { min_amount: 10, currency: "USD", interval }))),
    ).fetch(NOW);
    expect(p?.salary).toEqual({ min: 10, currency: "USD", period });
  });

  it("weekly pay has no RawSalary period: text only", async () => {
    const [p] = await make(async () =>
      ok(lines(job("k2", { min_amount: 10, currency: "USD", interval: "weekly" }))),
    ).fetch(NOW);
    expect(p?.salary).toBeUndefined();
    expect(p?.salaryText).toBe("USD 10 / weekly");
  });

  it("takes the id from the jk parameter when the worker sends none", async () => {
    const [p] = await make(async () => ok(lines(job("zz9", { id: null })))).fetch(NOW);
    expect(p?.externalId).toBe("zz9");
  });

  it("drops postings dated more than 48 h ago but keeps undated ones", async () => {
    const result = await make(async (s) =>
      ok(
        s.country === "usa"
          ? lines(
              job("old", { date_posted: "2026-10-11T00:00:00.000" }),
              job("new", { date_posted: "2026-10-13T00:00:00.000" }),
              job("undated", { date_posted: null }),
            )
          : "",
      ),
    ).fetch(NOW);
    expect(result.map((p) => p.externalId)).toEqual(["new", "undated"]);
  });
});

describe("indeed failures", () => {
  it("a block is a SourceBlockedError and the Indonesia search never runs", async () => {
    const runWorker = vi.fn<WorkerRunner>(async () => ({
      exitCode: 2,
      stdout: lines({ error: "response status code 403", kind: "blocked" }),
    }));
    const err = await make(runWorker)
      .fetch(NOW)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceBlockedError);
    expect((err as Error).message).toContain("[indeed]");
    expect((err as Error).message).toContain("status code 403");
    expect(runWorker).toHaveBeenCalledTimes(1);
  });

  it("missing venv -> skipped", async () => {
    const err = await createIndeedAdapter({ python: "/nonexistent/.venv/bin/python" })
      .fetch(NOW)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceSkippedError);
    expect((err as SourceSkippedError).reason).toBe(NOT_INSTALLED);
  });

  it("a real worker process reports a block", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-python-"));
    const python = join(dir, "python");
    writeFileSync(
      python,
      `#!/bin/sh\necho '{"error":"status code 403","kind":"blocked"}'; exit 2\n`,
    );
    chmodSync(python, 0o755);
    const script = join(dir, "run.py");
    writeFileSync(script, "");
    await expect(
      createIndeedAdapter({ python, script, sleep: async () => undefined }).fetch(NOW),
    ).rejects.toBeInstanceOf(SourceBlockedError);
  });
});
