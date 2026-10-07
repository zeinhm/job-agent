import { SourceError, log, __testInjectTimeAndSleep } from "@job-agent/core";
import { readFileSync } from "node:fs";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeConfig } from "../test-utils.ts";
import { buildAdapters } from "../registry.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../../test/fixtures/remoteok/api.json", import.meta.url), "utf-8"),
) as Record<string, unknown>[];
const legal = fixture[0] as Record<string, unknown>;
const jobs = fixture.slice(1);

const API = "https://remoteok.com/api";
const server = setupServer();

function omit(obj: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
}

function adapter() {
  const found = buildAdapters(makeConfig()).find((a) => a.name === "remoteok");
  if (!found) throw new Error("no remoteok adapter");
  return found;
}

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
beforeEach(() => {
  let now = 0;
  __testInjectTimeAndSleep(
    () => new Date(now),
    async (ms) => {
      now += ms;
    },
  );
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
});

describe("remoteok adapter", () => {
  it("is registered once with a 240 minute interval", () => {
    const all = buildAdapters(makeConfig()).filter((a) => a.name === "remoteok");
    expect(all).toHaveLength(1);
    expect(all[0]?.minIntervalMinutes).toBe(240);
  });

  it("returns one RawPosting per job and none for the legal notice, without warning", async () => {
    server.use(http.get(API, () => HttpResponse.json(fixture)));
    const postings = await adapter().fetch(new Date(0));
    expect(jobs).toHaveLength(20);
    expect(postings).toHaveLength(jobs.length);
    expect(postings.every((p) => p.source === "remoteok")).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("maps a job fully including salary", async () => {
    server.use(http.get(API, () => HttpResponse.json(fixture)));
    const postings = await adapter().fetch(new Date(0));
    const raw = jobs.find((j) => j.id === "1137461") as { description: string };
    expect(postings.find((p) => p.externalId === "1137461")).toEqual({
      source: "remoteok",
      externalId: "1137461",
      url: "https://remoteOK.com/remote-jobs/remote-head-of-operations-leverage-live-local-1137461",
      applyUrl:
        "https://remoteOK.com/remote-jobs/remote-head-of-operations-leverage-live-local-1137461",
      title: "Head of Operations",
      company: "Leverage Live Local",
      descriptionHtml: raw.description,
      salary: { min: 170000, max: 350000, currency: "USD", period: "year" },
      postedAt: "2026-10-03T20:20:32.000Z",
      tags: ["non tech", "ops", "exec"],
    });
  });

  it("has no salary when salary_min and salary_max are 0 or missing", async () => {
    const base = jobs[0] as Record<string, unknown>;
    const noSalary = omit(base, "salary_min", "salary_max");
    server.use(
      http.get(API, () =>
        HttpResponse.json([
          legal,
          { ...base, id: "z0", salary_min: 0, salary_max: 0 },
          { ...noSalary, id: "z1" },
        ]),
      ),
    );
    const postings = await adapter().fetch(new Date(0));
    expect(postings.map((p) => p.externalId)).toEqual(["z0", "z1"]);
    for (const p of postings) expect(p).not.toHaveProperty("salary");
  });

  it("keeps a single-sided salary", async () => {
    const base = jobs[0] as Record<string, unknown>;
    server.use(
      http.get(API, () =>
        HttpResponse.json([legal, { ...base, salary_min: 0, salary_max: 90000 }]),
      ),
    );
    const [p] = await adapter().fetch(new Date(0));
    expect(p?.salary).toEqual({ max: 90000, currency: "USD", period: "year" });
  });

  it("excludes jobs posted before since", async () => {
    server.use(http.get(API, () => HttpResponse.json(fixture)));
    const since = new Date("2026-09-28T00:00:00Z");
    const expected = jobs.filter((j) => new Date(j.date as string) >= since);
    const postings = await adapter().fetch(since);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(jobs.length);
    expect(postings.map((p) => p.externalId).sort()).toEqual(
      expected.map((j) => j.id as string).sort(),
    );
  });

  it("falls back to epoch when date is missing", async () => {
    const rest = omit(jobs[0] as Record<string, unknown>, "date");
    server.use(http.get(API, () => HttpResponse.json([legal, { ...rest, epoch: 1791205202 }])));
    const [p] = await adapter().fetch(new Date(0));
    expect(p?.postedAt).toBe("2026-10-05T13:00:02.000Z");
  });

  it("keeps jobs without a date", async () => {
    const rest = omit(jobs[0] as Record<string, unknown>, "date", "epoch");
    server.use(http.get(API, () => HttpResponse.json([legal, rest])));
    const postings = await adapter().fetch(new Date("2030-01-01T00:00:00Z"));
    expect(postings).toHaveLength(1);
    expect(postings[0]).not.toHaveProperty("postedAt");
  });

  it("rejects with SourceError on 500 after retries", async () => {
    let calls = 0;
    server.use(
      http.get(API, () => {
        calls++;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    const err = await adapter()
      .fetch(new Date(0))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).source).toBe("remoteok");
    expect(calls).toBe(3);
  });

  it("rejects with SourceError on an invalid envelope", async () => {
    server.use(http.get(API, () => HttpResponse.json({ jobs: [] })));
    await expect(adapter().fetch(new Date(0))).rejects.toBeInstanceOf(SourceError);
  });

  it("skips one invalid job with a warn", async () => {
    const bad = { ...jobs[0], id: "bad-1", url: undefined };
    server.use(http.get(API, () => HttpResponse.json([...fixture, bad])));
    const postings = await adapter().fetch(new Date(0));
    expect(postings).toHaveLength(jobs.length);
    expect(postings.map((p) => p.externalId)).not.toContain("bad-1");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ source: "remoteok", externalId: "bad-1", path: "url" }),
    );
  });

  it("rejects with SourceError when more than 50% of jobs are invalid", async () => {
    const bad = (id: string) => ({ id, position: "t" });
    server.use(http.get(API, () => HttpResponse.json([legal, jobs[0], bad("b1"), bad("b2")])));
    await expect(adapter().fetch(new Date(0))).rejects.toBeInstanceOf(SourceError);
  });

  it("accepts exactly 50% invalid jobs", async () => {
    server.use(
      http.get(API, () => HttpResponse.json([legal, jobs[0], { id: "b1", position: "t" }])),
    );
    await expect(adapter().fetch(new Date(0))).resolves.toHaveLength(1);
  });

  it("returns [] for a valid response with only the legal notice", async () => {
    server.use(http.get(API, () => HttpResponse.json([legal])));
    await expect(adapter().fetch(new Date(0))).resolves.toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
