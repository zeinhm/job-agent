import { SourceError, log, __testInjectTimeAndSleep } from "@job-agent/core";
import { readFileSync } from "node:fs";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHimalayasAdapter } from "./index.ts";

type Page = { jobs: Record<string, unknown>[]; nextCursor?: string | null } & Record<
  string,
  unknown
>;

function readPage(name: string): Page {
  return JSON.parse(
    readFileSync(new URL(`../../test/fixtures/himalayas/${name}.json`, import.meta.url), "utf-8"),
  ) as Page;
}

const page1 = readPage("page1");
const page2 = readPage("page2");

const API = "https://himalayas.app/jobs/api";
const server = setupServer();
const requestedCursors: (string | null)[] = [];

/** Serves the recorded pages: no cursor -> page 1, page 1's cursor -> page 2. */
function servePages() {
  server.use(
    http.get(API, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get("cursor");
      requestedCursors.push(cursor);
      if (cursor === null) return HttpResponse.json(page1);
      if (cursor === page1.nextCursor) return HttpResponse.json({ ...page2, nextCursor: null });
      return HttpResponse.json({ error: "unexpected cursor" }, { status: 400 });
    }),
  );
}

const adapter = createHimalayasAdapter();
let warn: ReturnType<typeof vi.spyOn>;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
beforeEach(() => {
  requestedCursors.length = 0;
  let now = 0;
  __testInjectTimeAndSleep(
    () => new Date(now),
    async (ms) => {
      now += ms;
    },
  );
  warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
});

describe("himalayas adapter", () => {
  it("identifies itself and polls at most hourly", () => {
    expect(adapter.name).toBe("himalayas");
    expect(adapter.minIntervalMinutes).toBe(60);
  });

  it("returns one RawPosting per job across both pages", async () => {
    servePages();
    const postings = await adapter.fetch(new Date(0));
    expect(postings).toHaveLength(page1.jobs.length + page2.jobs.length);
    expect(postings.every((p) => p.source === "himalayas")).toBe(true);
    expect(new Set(postings.map((p) => p.externalId)).size).toBe(postings.length);
    expect(requestedCursors).toEqual([null, page1.nextCursor]);
  });

  it("maps a job fully, building locationText from the restriction fields", async () => {
    servePages();
    const postings = await adapter.fetch(new Date(0));
    const raw = page1.jobs[9] as { description: string };
    expect(postings[9]).toEqual({
      source: "himalayas",
      externalId:
        "https://himalayas.app/companies/coinbase/jobs/sr-staff-technical-risk-architect-unified-trading",
      url: "https://himalayas.app/companies/coinbase/jobs/sr-staff-technical-risk-architect-unified-trading",
      title: "Sr. Staff Technical Risk Architect, Unified Trading",
      company: "Coinbase",
      descriptionHtml: raw.description,
      locationText:
        "Countries: United States; Timezones: UTC-10, UTC-9, UTC-8, UTC-7, UTC-6, UTC-5, UTC+14",
      salary: { min: 253895, max: 298700, currency: "USD", period: "year" },
      postedAt: "2026-10-06T21:51:41.000Z",
      tags: [
        "Risk-Architect",
        "Trading-Risk-Manager",
        "Risk-Engineer",
        "Financial-Risk-Analyst",
        "Quantitative-Risk-Analyst",
        "Staff-Trading-Technology-Engineer",
        "Senior-Principal-Financial-Platform-Architect",
        "Senior-Risk-Engineer",
        "Technical-Architect",
        "Developer",
      ],
    });
  });

  it("maps hourly salary, omits salary when none is given, and marks empty restrictions worldwide", async () => {
    servePages();
    const postings = await adapter.fetch(new Date(0));
    const hourly = postings.find((p) => p.salary?.period === "hour");
    expect(hourly?.salary).toEqual({ min: 20, max: 40, currency: "GBP", period: "hour" });
    expect(hourly?.locationText).toBe("Countries: United Kingdom; Timezones: UTC+0");
    expect(postings[0]).not.toHaveProperty("salary");
    expect(postings[3]?.locationText).toMatch(
      /^Countries: Worldwide; Timezones: UTC-11, UTC-10, UTC-9.5,/,
    );
    expect(postings[6]?.locationText).toBe("Countries: India; Timezones: UTC+5.5");
  });

  it("stops paging once a page reaches items older than since", async () => {
    servePages();
    const since = new Date(1791323600 * 1000);
    const postings = await adapter.fetch(since);
    expect(postings).toHaveLength(6);
    expect(postings.every((p) => new Date(p.postedAt as string) >= since)).toBe(true);
    expect(requestedCursors).toEqual([null]);
  });

  it("never requests more than 10 pages when every page is new", async () => {
    let calls = 0;
    server.use(
      http.get(API, () => {
        calls++;
        return HttpResponse.json({ ...page1, nextCursor: `cursor-${calls}` });
      }),
    );
    const postings = await adapter.fetch(new Date(0));
    expect(calls).toBe(10);
    expect(postings).toHaveLength(10 * page1.jobs.length);
  });

  it("stops when the feed has no next cursor", async () => {
    let calls = 0;
    server.use(
      http.get(API, () => {
        calls++;
        return HttpResponse.json({ ...page1, nextCursor: null });
      }),
    );
    await adapter.fetch(new Date(0));
    expect(calls).toBe(1);
  });

  it("returns [] for a valid empty feed", async () => {
    server.use(http.get(API, () => HttpResponse.json({ jobs: [], nextCursor: null })));
    await expect(adapter.fetch(new Date(0))).resolves.toEqual([]);
  });

  it("throws SourceError (never []) when the API keeps returning 500", async () => {
    let calls = 0;
    server.use(
      http.get(API, () => {
        calls++;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    const err = await adapter.fetch(new Date(0)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).source).toBe("himalayas");
    expect(calls).toBe(3);
  });

  it("throws SourceError on an invalid envelope", async () => {
    server.use(http.get(API, () => HttpResponse.json({ results: [] })));
    const err = await adapter.fetch(new Date(0)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).source).toBe("himalayas");
  });

  it("skips one invalid job with a warning", async () => {
    const jobs = [...page1.jobs];
    jobs[2] = { guid: "https://himalayas.app/companies/broken/jobs/x", title: "" };
    server.use(http.get(API, () => HttpResponse.json({ jobs, nextCursor: null })));
    const postings = await adapter.fetch(new Date(0));
    expect(postings).toHaveLength(page1.jobs.length - 1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "himalayas: skipping invalid job",
      expect.objectContaining({
        source: "himalayas",
        externalId: "https://himalayas.app/companies/broken/jobs/x",
        path: "title",
      }),
    );
  });

  it("throws SourceError when more than 50% of jobs are invalid", async () => {
    const jobs = page1.jobs.map((job, i) => (i < 6 ? { guid: `bad-${i}` } : job));
    server.use(http.get(API, () => HttpResponse.json({ jobs, nextCursor: null })));
    const err = await adapter.fetch(new Date(0)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).source).toBe("himalayas");
  });

  it("accepts exactly 50% invalid jobs", async () => {
    const jobs = page1.jobs.map((job, i) => (i < 5 ? { guid: `bad-${i}` } : job));
    server.use(http.get(API, () => HttpResponse.json({ jobs, nextCursor: null })));
    await expect(adapter.fetch(new Date(0))).resolves.toHaveLength(5);
  });
});
