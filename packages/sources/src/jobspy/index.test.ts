import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PartialSourceError,
  SourceBlockedError,
  SourceError,
  SourceSkippedError,
} from "@job-agent/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LINKEDIN_RESULTS_WANTED,
  MAX_RESULTS_PER_SEARCH,
  SEARCH_GAP_MS,
  createIndeedAdapter,
  createLinkedInAdapter,
  lookbackHours,
} from "./index.ts";
import { NOT_INSTALLED, type WorkerRunner, type WorkerSearch } from "./worker.ts";

const job = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `li-${n}`,
  site: "linkedin",
  job_url: `https://www.linkedin.com/jobs/view/${n}`,
  job_url_direct: null,
  title: `Senior Frontend Engineer ${n}`,
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
const lines = (...items: unknown[]) =>
  items.map((i) => (typeof i === "string" ? i : JSON.stringify(i))).join("\n");
const ok = (stdout: string) => ({ exitCode: 0, stdout });

afterEach(() => vi.useRealTimers());

describe("linkedin adapter mapping", () => {
  it("maps every field", async () => {
    const full = job(1, {
      job_url_direct: "https://boards.example.com/apply/1",
      description: "Build things.",
      min_amount: 100000,
      max_amount: 150000,
      currency: "USD",
      interval: "yearly",
    });
    const runWorker: WorkerRunner = vi.fn(async (s) =>
      ok(s.location === "Worldwide" ? lines(full) : ""),
    );
    const adapter = createLinkedInAdapter({ runWorker, sleep: async () => undefined });
    expect(adapter.name).toBe("linkedin");
    expect(adapter.minIntervalMinutes).toBe(50);
    const [p, ...rest] = await adapter.fetch(new Date());
    expect(rest).toEqual([]);
    expect(p).toEqual({
      source: "linkedin",
      externalId: "1",
      url: "https://www.linkedin.com/jobs/view/1",
      applyUrl: "https://boards.example.com/apply/1",
      title: "Senior Frontend Engineer 1",
      company: "Example Co",
      descriptionText: "Build things.",
      locationText: "Remote",
      remote: true,
      salaryText: "USD 100000-150000 / yearly",
      salary: { min: 100000, max: 150000, currency: "USD", period: "year" },
      postedAt: "2026-10-14T00:00:00.000Z",
    });
  });

  it("omits optional fields, remote=false and salaries without a known period", async () => {
    const runWorker: WorkerRunner = async (s) =>
      ok(
        s.location === "Worldwide"
          ? lines(
              job(2, {
                is_remote: false,
                location: null,
                date_posted: null,
                min_amount: 5,
                currency: "USD",
                interval: "daily",
              }),
            )
          : "",
      );
    const [p] = await createLinkedInAdapter({ runWorker, sleep: async () => undefined }).fetch(
      new Date(),
    );
    expect(p?.remote).toBeUndefined();
    expect(p?.applyUrl).toBeUndefined();
    expect(p?.locationText).toBeUndefined();
    expect(p?.postedAt).toBeUndefined();
    expect(p?.salary).toBeUndefined();
    expect(p?.salaryText).toBe("USD 5 / daily");
  });

  it("takes the id from the url when the worker sends none and de-duplicates across both searches", async () => {
    const runWorker: WorkerRunner = async () => ok(lines(job(3, { id: null }), job(4)));
    const result = await createLinkedInAdapter({ runWorker, sleep: async () => undefined }).fetch(
      new Date(),
    );
    expect(result.map((p) => p.externalId)).toEqual(["3", "4"]);
  });

  it("counts and skips a malformed line, keeps the others and reports a warning once", async () => {
    const runWorker: WorkerRunner = async (s) =>
      ok(
        s.location === "Worldwide"
          ? lines(job(1), "{not json", job(2), job(3, { job_url: "nope" }))
          : lines(job(5)),
      );
    const adapter = createLinkedInAdapter({ runWorker, sleep: async () => undefined });
    const result = await adapter.fetch(new Date());
    expect(result.map((p) => p.externalId)).toEqual(["1", "2", "5"]);
    expect(adapter.takeWarnings?.()).toEqual(["2 malformed worker line(s) skipped"]);
    expect(adapter.takeWarnings?.()).toEqual([]);
  });

  it("errors when most lines are invalid", async () => {
    const runWorker: WorkerRunner = async () => ok(lines("x", "y", job(1)));
    await expect(
      createLinkedInAdapter({ runWorker, sleep: async () => undefined }).fetch(new Date()),
    ).rejects.toThrow("2 of 3 worker lines invalid");
  });
});

const min = (n: number) => n * 60_000;
describe("lookbackHours", () => {
  const NOW = new Date("2026-10-14T12:00:00Z");
  const hoursFor = (agoMs: number) => lookbackHours(new Date(NOW.getTime() - agoMs), NOW);
  it.each([
    ["0 min", 0, 1],
    ["50 min (exactly 60 with overlap)", min(50), 1],
    ["51 min", min(51), 2],
    ["70 min", min(70), 2],
    ["2 h 10 min", min(130), 3],
    ["6 h 5 min (after a block backoff)", min(365), 7],
    ["23 h 50 min", min(23 * 60 + 50), 24],
    ["30 h", min(30 * 60), 24],
    ["7 days", min(7 * 24 * 60), 24],
    ["1 h in the future", -min(60), 1],
  ])("%s -> %i", (_label, ago, expected) => {
    expect(hoursFor(ago)).toBe(expected);
  });
});

describe("linkedin lookback", () => {
  const NOW = new Date("2026-10-14T12:00:00Z");
  it("sends the computed hours_old to both searches and in smoke mode", async () => {
    for (const smoke of [false, true]) {
      const seen: WorkerSearch[] = [];
      const runWorker: WorkerRunner = async (s) => {
        seen.push(s);
        return ok("");
      };
      await createLinkedInAdapter({
        runWorker,
        smoke,
        sleep: async () => undefined,
        now: () => NOW,
      }).fetch(new Date(NOW.getTime() - min(365)));
      expect(seen).toHaveLength(smoke ? 1 : 2);
      for (const s of seen) expect(s.hours_old).toBe(7);
    }
  });
});

describe("linkedin searches", () => {
  it("runs Worldwide then Indonesia, 10 s apart, lookback hours, at most 25 results", async () => {
    vi.useFakeTimers();
    const started: { search: WorkerSearch; at: number }[] = [];
    const runWorker: WorkerRunner = async (search) => {
      started.push({ search, at: Date.now() });
      return ok("");
    };
    const promise = createLinkedInAdapter({ runWorker }).fetch(new Date());
    await vi.advanceTimersByTimeAsync(SEARCH_GAP_MS - 1);
    expect(started).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(started.map((s) => s.search.location)).toEqual(["Worldwide", "Indonesia"]);
    expect((started[1]?.at ?? 0) - (started[0]?.at ?? 0)).toBeGreaterThanOrEqual(10_000);
    for (const { search } of started) {
      expect(search.site).toBe("linkedin");
      expect(search.hours_old).toBe(1); // since = now
      expect(search.results_wanted).toBeLessThanOrEqual(25);
      expect(search.search_term).toContain("remote");
    }
    expect(LINKEDIN_RESULTS_WANTED).toBeLessThanOrEqual(25);
    expect(SEARCH_GAP_MS).toBeGreaterThanOrEqual(10_000);
  });

  it("smoke mode runs one search with at most 10 results", async () => {
    const seen: WorkerSearch[] = [];
    const runWorker: WorkerRunner = async (s) => {
      seen.push(s);
      return ok("");
    };
    await createLinkedInAdapter({ runWorker, smoke: true }).fetch(new Date());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.results_wanted).toBe(10);
    expect(seen[0]?.hours_old).toBe(1);
  });

  it("a block on the first search is a SourceBlockedError and the second search never runs", async () => {
    const runWorker = vi.fn<WorkerRunner>(async () => ({
      exitCode: 2,
      stdout: lines({ error: "response status code 429", kind: "blocked" }),
    }));
    const err = await createLinkedInAdapter({ runWorker, sleep: async () => undefined })
      .fetch(new Date())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceBlockedError);
    expect((err as Error).message).toContain("response status code 429");
    expect(runWorker).toHaveBeenCalledTimes(1);
  });

  it("a block on the second search keeps the first search's postings", async () => {
    let n = 0;
    const runWorker: WorkerRunner = async () =>
      ++n === 1
        ? ok(lines(job(1)))
        : { exitCode: 2, stdout: lines({ error: "authwall", kind: "blocked" }) };
    const err = await createLinkedInAdapter({ runWorker, sleep: async () => undefined })
      .fetch(new Date())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceBlockedError);
    expect((err as SourceBlockedError).postings.map((p) => p.externalId)).toEqual(["1"]);
  });

  it("a non-block worker failure is a plain error, not a block", async () => {
    const runWorker: WorkerRunner = async () => ({
      exitCode: 2,
      stdout: lines({ error: "bad args", kind: "error" }),
    });
    const err = await createLinkedInAdapter({ runWorker, sleep: async () => undefined })
      .fetch(new Date())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err).not.toBeInstanceOf(SourceBlockedError);
    expect(err).not.toBeInstanceOf(PartialSourceError);
    expect((err as Error).message).toContain("bad args");
  });

  it("exit 2 without an error line reports the exit code", async () => {
    const runWorker: WorkerRunner = async () => ({ exitCode: 3, stdout: "" });
    await expect(
      createLinkedInAdapter({ runWorker, sleep: async () => undefined }).fetch(new Date()),
    ).rejects.toThrow("exited 3");
  });
});

describe("real worker process", () => {
  const fakePython = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), "fake-python-"));
    const py = join(dir, "python");
    writeFileSync(py, `#!/bin/sh\n${body}\n`);
    chmodSync(py, 0o755);
    const script = join(dir, "run.py");
    writeFileSync(script, "");
    return { python: py, script };
  };

  it("missing venv -> skipped", async () => {
    const adapter = createLinkedInAdapter({ python: "/nonexistent/.venv/bin/python" });
    const err = await adapter.fetch(new Date()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceSkippedError);
    expect((err as SourceSkippedError).reason).toBe(NOT_INSTALLED);
  });

  it("passes the search as JSON on stdin and reads stdout lines", async () => {
    const { python, script } = fakePython(`cat > /dev/null; echo '${JSON.stringify(job(7))}'`);
    const result = await createLinkedInAdapter({
      python,
      script,
      sleep: async () => undefined,
    }).fetch(new Date());
    expect(result.map((p) => p.externalId)).toEqual(["7"]);
  });

  it("exit 2 with a block object -> SourceBlockedError", async () => {
    const { python, script } = fakePython(
      `echo '{"error":"status code 999","kind":"blocked"}'; exit 2`,
    );
    await expect(
      createLinkedInAdapter({ python, script, sleep: async () => undefined }).fetch(new Date()),
    ).rejects.toBeInstanceOf(SourceBlockedError);
  });

  it("timeout -> error and the process is killed", async () => {
    const { python, script } = fakePython(`sleep 30`);
    const started = Date.now();
    const err = await createLinkedInAdapter({
      python,
      script,
      timeoutMs: 200,
      sleep: async () => undefined,
    })
      .fetch(new Date())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err).not.toBeInstanceOf(SourceBlockedError);
    expect((err as Error).message).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("saturation paging", () => {
  /** Fake runner: answers each call with `pages[n]` job lines (unique ids per call) and records calls and sleeps. */
  function harness(pages: number[], site: "linkedin" | "indeed" = "linkedin") {
    const calls: WorkerSearch[] = [];
    const events: string[] = [];
    let id = 0;
    const runWorker: WorkerRunner = async (s) => {
      calls.push(s);
      events.push("call");
      const n = pages[calls.length - 1] ?? 0;
      const items = Array.from({ length: n }, () => {
        id++;
        return site === "linkedin"
          ? job(id)
          : job(id, {
              id: `in-k${id}`,
              site: "indeed",
              job_url: `https://www.indeed.com/viewjob?jk=k${id}`,
            });
      });
      return ok(lines(...items));
    };
    const sleep = async (ms: number) => {
      events.push(`sleep ${ms}`);
    };
    const adapter = (site === "linkedin" ? createLinkedInAdapter : createIndeedAdapter)({
      runWorker,
      sleep,
    });
    return { calls, events, adapter };
  }
  const offsets = (calls: WorkerSearch[]) => calls.map((c) => c.offset ?? 0);

  it("a full first page of 25 asks for offset 25", async () => {
    const h = harness([25, 12, 0]);
    await h.adapter.fetch(new Date());
    expect(offsets(h.calls).slice(0, 2)).toEqual([0, 25]);
    expect(h.calls[0]).not.toHaveProperty("offset");
  });

  it("four full pages stop at 100: offsets 0, 25, 50, 75 for the first search", async () => {
    const h = harness([25, 25, 25, 25, 0, 0]);
    await h.adapter.fetch(new Date());
    expect(MAX_RESULTS_PER_SEARCH).toBe(100);
    expect(h.calls.map((c) => [c.location, c.offset ?? 0])).toEqual([
      ["Worldwide", 0],
      ["Worldwide", 25],
      ["Worldwide", 50],
      ["Worldwide", 75],
      ["Indonesia", 0],
    ]);
  });

  it("25 then 12 is two calls; 24 is one call and not saturated", async () => {
    const a = harness([25, 12, 0]);
    await a.adapter.fetch(new Date());
    expect(offsets(a.calls)).toEqual([0, 25, 0]); // search 2 takes the third call
    const b = harness([24, 0]);
    await b.adapter.fetch(new Date());
    expect(offsets(b.calls)).toEqual([0, 0]);
    expect(b.adapter.takeSaturated?.()).toBe(0);
  });

  it("indeed pages 50 then 50 and stops at 100", async () => {
    const h = harness([50, 50, 0], "indeed");
    await h.adapter.fetch(new Date());
    expect(h.calls.map((c) => [c.country, c.offset ?? 0])).toEqual([
      ["usa", 0],
      ["usa", 50],
      ["indonesia", 0],
    ]);
  });

  it("sleeps 10 s before every call but the first, pages and searches alike", async () => {
    const h = harness([25, 25, 25, 25, 25, 0]);
    await h.adapter.fetch(new Date());
    expect(h.events).toEqual([
      "call",
      ...Array.from({ length: 5 }, () => ["sleep 10000", "call"]).flat(),
    ]);
  });

  it("counts searches whose first page was full, not full pages", async () => {
    const a = harness([25, 25, 3, 10]);
    await a.adapter.fetch(new Date());
    expect(a.adapter.takeSaturated?.()).toBe(1);
    const b = harness([25, 10, 10]);
    await b.adapter.fetch(new Date());
    expect(b.adapter.takeSaturated?.()).toBe(1);
    const c = harness([10, 10]);
    await c.adapter.fetch(new Date());
    expect(c.adapter.takeSaturated?.()).toBe(0);
    const d = harness([25, 25, 25, 25, 25, 25, 25, 25]);
    await d.adapter.fetch(new Date());
    expect(d.calls).toHaveLength(8);
    expect(d.adapter.takeSaturated?.()).toBe(2);
  });

  it("the count is reset by each fetch", async () => {
    const h = harness([25, 0, 0, 0, 0]);
    await h.adapter.fetch(new Date());
    expect(h.adapter.takeSaturated?.()).toBe(1);
    await h.adapter.fetch(new Date());
    expect(h.adapter.takeSaturated?.()).toBe(0);
  });

  it("a page counts malformed lines as lines", async () => {
    const calls: WorkerSearch[] = [];
    const runWorker: WorkerRunner = async (s) => {
      calls.push(s);
      if (calls.length > 1) return ok("");
      const items = Array.from({ length: 24 }, (_, i) => job(i + 1));
      return ok(lines(...items, "garbage"));
    };
    const adapter = createLinkedInAdapter({ runWorker, sleep: async () => undefined });
    await adapter.fetch(new Date());
    expect(calls[1]?.offset).toBe(25);
  });

  it("a posting repeated across pages is counted once", async () => {
    let n = 0;
    const runWorker: WorkerRunner = async () => {
      n++;
      if (n > 2) return ok("");
      const first = n === 1 ? 1 : 2;
      return ok(lines(...Array.from({ length: 25 }, (_, i) => job(first + i))));
    };
    const found = await createLinkedInAdapter({ runWorker, sleep: async () => undefined }).fetch(
      new Date(),
    );
    expect(found).toHaveLength(26);
  });

  it("a block on page 2 stops everything and carries page 1's postings", async () => {
    const calls: WorkerSearch[] = [];
    const runWorker: WorkerRunner = async (s) => {
      calls.push(s);
      return calls.length === 1
        ? ok(lines(...Array.from({ length: 25 }, (_, i) => job(i + 1))))
        : { exitCode: 2, stdout: lines({ error: "authwall", kind: "blocked" }) };
    };
    const err = await createLinkedInAdapter({ runWorker, sleep: async () => undefined })
      .fetch(new Date())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceBlockedError);
    expect((err as SourceBlockedError).postings).toHaveLength(25);
    expect(calls).toHaveLength(2);
  });

  it("a worker error on page 2 is a PartialSourceError with page 1's postings", async () => {
    const calls: WorkerSearch[] = [];
    const runWorker: WorkerRunner = async (s) => {
      calls.push(s);
      return calls.length === 1
        ? ok(lines(...Array.from({ length: 25 }, (_, i) => job(i + 1))))
        : { exitCode: 2, stdout: lines({ error: "boom", kind: "error" }) };
    };
    const err = await createLinkedInAdapter({ runWorker, sleep: async () => undefined })
      .fetch(new Date())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartialSourceError);
    expect(err).not.toBeInstanceOf(SourceBlockedError);
    expect((err as PartialSourceError).postings).toHaveLength(25);
    expect(calls).toHaveLength(2);
  });

  it("smoke mode makes exactly one call even when the page is full", async () => {
    const calls: WorkerSearch[] = [];
    const runWorker: WorkerRunner = async (s) => {
      calls.push(s);
      return ok(lines(...Array.from({ length: 10 }, (_, i) => job(i + 1))));
    };
    await createLinkedInAdapter({ runWorker, smoke: true, sleep: async () => undefined }).fetch(
      new Date(),
    );
    expect(calls).toHaveLength(1);
  });
});
