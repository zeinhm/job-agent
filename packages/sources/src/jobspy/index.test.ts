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
  LINKEDIN_HOURS_OLD,
  LINKEDIN_RESULTS_WANTED,
  SEARCH_GAP_MS,
  createLinkedInAdapter,
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

describe("linkedin searches", () => {
  it("runs Worldwide then Indonesia, 10 s apart, past hour, at most 25 results", async () => {
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
      expect(search.hours_old).toBe(1);
      expect(search.results_wanted).toBeLessThanOrEqual(25);
      expect(search.search_term).toContain("remote");
    }
    expect(LINKEDIN_HOURS_OLD).toBe(1);
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
