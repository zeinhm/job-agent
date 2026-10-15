import { SourceSkippedError, __testInjectTimeAndSleep, httpGet, log } from "@job-agent/core";
import { readFileSync, writeFileSync } from "node:fs";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BRAVE_DAILY_REQUEST_CAP, searchUrls } from "../discovery/search.ts";
import { buildAdapters } from "../registry.ts";
import { makeConfig } from "../test-utils.ts";
import { MAX_POST_QUERIES_PER_RUN, createLinkedinPostsAdapter, mapResult } from "./index.ts";

const BRAVE = "https://api.search.brave.com/res/v1/web/search";
const server = setupServer();
const linkedinHits: string[] = [];
const freshness: string[] = [];

// Hand-built fake results (never real Brave output, no real people).
const hiring = {
  url: "https://www.linkedin.com/posts/example-handle_hiring-activity-1000000000000000001-abcd",
  title: "We are hiring a Senior React engineer",
  description: "Join Examplecorp Labs. Remote, APAC friendly. Senior frontend role.",
};
const seeker = {
  url: "https://www.linkedin.com/posts/example-handle_open-to-work-activity-1000000000000000002-abcd",
  title: "Open to work: frontend developer",
  description: "I am open to work as a React developer.",
};
const profile = {
  url: "https://www.linkedin.com/in/example-handle",
  title: "Hiring React",
  description: "hiring react remote",
};
const jobPage = {
  url: "https://www.linkedin.com/jobs/view/123",
  title: "Hiring",
  description: "hiring react remote",
};

let usageFile = "";
let calls = 0;
let results: unknown[] = [hiring];

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  usageFile = process.env["JOB_AGENT_BRAVE_USAGE"] ?? "";
  process.env["BRAVE_API_KEY"] = "test-key";
  calls = 0;
  linkedinHits.length = 0;
  freshness.length = 0;
  results = [hiring];
  let now = 0;
  __testInjectTimeAndSleep(
    () => new Date(now),
    async (ms) => {
      now += ms;
    },
  );
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  server.use(
    http.get(BRAVE, ({ request }) => {
      calls++;
      expect(request.headers.get("x-subscription-token")).toBe("test-key");
      freshness.push(new URL(request.url).searchParams.get("freshness") ?? "");
      expect(request.url).not.toContain("test-key");
      return HttpResponse.json({ web: { results } });
    }),
    http.all(/linkedin\.com|lnkd\.in/, ({ request }) => {
      linkedinHits.push(request.url);
      return new HttpResponse(null, { status: 200 });
    }),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
  delete process.env["BRAVE_API_KEY"];
});

describe("linkedin_posts adapter", () => {
  it("is registered with a 170 minute interval", () => {
    const found = buildAdapters(makeConfig()).filter((a) => a.name === "linkedin_posts");
    expect(found).toHaveLength(1);
    expect(found[0]?.minIntervalMinutes).toBe(170);
  });

  it("maps a hiring post to a posting holding only the URL and own facts", async () => {
    const out = await createLinkedinPostsAdapter().fetch(new Date(0));
    expect(out).toHaveLength(1); // same URL from every query collapses to one
    const p = out[0];
    if (!p) throw new Error("no posting");
    expect(p).toMatchObject({
      source: "linkedin_posts",
      url: hiring.url,
      title: "(LinkedIn post)",
      company: "Examplecorp Labs",
      remote: true,
      locationText: "APAC",
    });
    expect(p.externalId).toMatch(/^[0-9a-f]{24}$/);
    const stored = JSON.stringify(p);
    // storage option (a): nothing of the Brave title or snippet is kept
    expect(stored).not.toContain(hiring.title);
    expect(stored).not.toContain(hiring.description);
    expect(stored).not.toContain("friendly");
    expect(p.descriptionText).toBe("Hiring: Senior Frontend Engineer. Remote. Region: APAC.");
  });

  it("uses (unknown) when no company is stated", () => {
    const p = mapResult({
      ...hiring,
      description: "Hiring a frontend engineer, remote.",
      title: "Hiring",
    });
    expect(p?.company).toBe("(unknown)");
  });

  it("gives the same externalId for the same post on a regional host", () => {
    const a = mapResult(hiring);
    const b = mapResult({ ...hiring, url: hiring.url.replace("www.", "id.") + "?utm=x" });
    expect(a?.externalId).toBeDefined();
    expect(b?.externalId).toBe(a?.externalId);
  });

  it("ignores profiles, job pages, job seekers and other hosts", async () => {
    results = [
      profile,
      jobPage,
      seeker,
      { ...hiring, url: "https://example.com/posts/x" },
      { ...hiring, url: "https://lnkd.in/posts/x" },
      { ...hiring, url: "http://www.linkedin.com/posts/x_y" },
    ];
    expect(await createLinkedinPostsAdapter().fetch(new Date(0))).toEqual([]);
  });

  it("runs at most MAX_POST_QUERIES_PER_RUN queries", async () => {
    await createLinkedinPostsAdapter().fetch(new Date(0));
    expect(MAX_POST_QUERIES_PER_RUN).toBe(4);
    expect(calls).toBe(4);
    expect(freshness).toEqual(["pd", "pd", "pd", "pd"]);
  });

  it("is skipped without BRAVE_API_KEY and makes no request", async () => {
    delete process.env["BRAVE_API_KEY"];
    await expect(createLinkedinPostsAdapter().fetch(new Date(0))).rejects.toBeInstanceOf(
      SourceSkippedError,
    );
    expect(calls).toBe(0);
  });

  it("makes zero requests to linkedin.com", async () => {
    await createLinkedinPostsAdapter().fetch(new Date(0));
    expect(linkedinHits).toEqual([]);
  });

  it("the http client throws on linkedin hosts before any request", async () => {
    for (const u of [hiring.url, "https://pt.linkedin.com/posts/x", "https://lnkd.in/abc"]) {
      await expect(httpGet(u)).rejects.toThrow(/network error/);
    }
    expect(linkedinHits).toEqual([]);
  });

  it("shares a 30/day cap across callers and skips with a reason", async () => {
    const day = new Date().toISOString().slice(0, 10);
    writeFileSync(usageFile, JSON.stringify({ day, count: BRAVE_DAILY_REQUEST_CAP - 2 }));
    await searchUrls("q", "test-key"); // another Brave caller uses one
    expect(calls).toBe(1);
    // one left: adapter runs one query, then stops at the cap
    const out = await createLinkedinPostsAdapter().fetch(new Date(0));
    expect(calls).toBe(2);
    expect(out).toHaveLength(1);
    expect(JSON.parse(readFileSync(usageFile, "utf-8"))).toEqual({
      day,
      count: BRAVE_DAILY_REQUEST_CAP,
    });
    await expect(createLinkedinPostsAdapter().fetch(new Date(0))).rejects.toThrow(
      /daily request cap/,
    );
    expect(calls).toBe(2);
  });

  it("a stale day resets the counter", async () => {
    writeFileSync(usageFile, JSON.stringify({ day: "2020-01-01", count: 99 }));
    await createLinkedinPostsAdapter().fetch(new Date(0));
    expect(calls).toBe(4);
  });
});
