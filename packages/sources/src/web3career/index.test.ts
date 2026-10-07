import { SourceError, log, __testInjectTimeAndSleep } from "@job-agent/core";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { setupServer } from "msw/node";
import { http, HttpResponse, type JsonBodyType } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWeb3CareerAdapter } from "./index.ts";

const fixtureText = readFileSync(
  new URL("../../test/fixtures/web3career/docs-shape.json", import.meta.url),
  "utf-8",
);
const envelope = JSON.parse(fixtureText) as [string, string, Record<string, unknown>[]];
const jobs = envelope[2];

const API = "https://web3.career/api/v1";
const TOKEN = "tok-SECRET-1234567890";
const server = setupServer();
const adapter = createWeb3CareerAdapter();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  vi.stubEnv("WEB3_CAREER_TOKEN", TOKEN);
  let now = 0;
  __testInjectTimeAndSleep(
    () => new Date(now),
    async (ms) => {
      now += ms;
    },
  );
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
});

const serve = (body: JsonBodyType) => server.use(http.get(API, () => HttpResponse.json(body)));
const wrap = (list: unknown[]) => ["feed", list];

describe("web3career adapter", () => {
  it("returns one RawPosting per fixture job", async () => {
    serve(envelope);
    const postings = await adapter.fetch(new Date(0));
    expect(postings).toHaveLength(jobs.length);
    expect(postings.every((p) => p.source === "web3career")).toBe(true);
    expect(adapter.name).toBe("web3career");
  });

  it("sends the remote-only query with the token", async () => {
    let seen: URL | undefined;
    server.use(
      http.get(API, ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json(envelope);
      }),
    );
    await adapter.fetch(new Date(0));
    expect(seen?.searchParams.get("token")).toBe(TOKEN);
    expect(seen?.searchParams.get("remote")).toBe("true");
    expect(seen?.searchParams.get("limit")).toBe("100");
  });

  it("maps a job fully, including structured salary", async () => {
    serve(envelope);
    const postings = await adapter.fetch(new Date(0));
    expect(postings[0]).toEqual({
      source: "web3career",
      externalId: "150325",
      url: "https://web3.career/senior-fullstack-engineer-backend-focus-example-labs/150325",
      applyUrl:
        "https://web3.career/senior-fullstack-engineer-backend-focus-example-labs/150325#apply",
      title: "Senior Fullstack Engineer (Backend Focus)",
      company: "Example Labs",
      descriptionHtml: "<p>Build backend services. Contact jobs@example.com or +10000000000.</p>",
      remote: true,
      salaryText: "$90k - $150k/year",
      salary: { min: 90000, max: 150000, currency: "USD", period: "year" },
      postedAt: "2026-10-05T00:00:00.000Z",
      tags: ["backend", "engineer", "full stack", "senior", "crypto"],
    });
  });

  it("omits salary when no numbers are given and maps other periods", async () => {
    serve(envelope);
    const byId = new Map((await adapter.fetch(new Date(0))).map((p) => [p.externalId, p]));
    expect(byId.get("150301")).not.toHaveProperty("salary");
    expect(byId.get("150301")).not.toHaveProperty("salaryText");
    expect(byId.get("150301")?.locationText).toBe("Worldwide");
    expect(byId.get("150288")?.salary).toEqual({
      min: 30,
      max: 45,
      currency: "USD",
      period: "hour",
    });
  });

  it("falls back from epoch to posted_at and omits an unknown date", async () => {
    serve(envelope);
    const byId = new Map((await adapter.fetch(new Date(0))).map((p) => [p.externalId, p]));
    expect(byId.get("150288")?.postedAt).toBe("2026-10-02T00:00:00.000Z");
    expect(byId.get("150301")?.postedAt).toBe("2026-09-20T00:00:00.000Z");
    expect(byId.get("150270")).not.toHaveProperty("postedAt");
  });

  it("excludes jobs posted before since and keeps undated ones", async () => {
    serve(envelope);
    const postings = await adapter.fetch(new Date("2026-10-03T00:00:00Z"));
    expect(postings.map((p) => p.externalId).sort()).toEqual(["150270", "150325"]);
  });

  it("throws SourceError naming the variable when the token is missing", async () => {
    vi.stubEnv("WEB3_CAREER_TOKEN", "");
    const err = await adapter.fetch(new Date(0)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).message).toContain("WEB3_CAREER_TOKEN not set");
  });

  it("never exposes the token in errors or logs when the request fails", async () => {
    const lines: string[] = [];
    vi.mocked(log.warn).mockImplementation((msg, fields) => {
      lines.push(JSON.stringify({ msg, fields }));
    });
    server.use(http.get(API, () => new HttpResponse(null, { status: 500 })));
    const err = await adapter.fetch(new Date(0)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(inspect(err, { depth: 10, showHidden: true })).not.toContain(TOKEN);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("rejects with SourceError on 500 after retries", async () => {
    let calls = 0;
    server.use(
      http.get(API, () => {
        calls++;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    const err = await adapter.fetch(new Date(0)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).source).toBe("web3career");
    expect(calls).toBe(3);
  });

  it("rejects with SourceError on an invalid envelope", async () => {
    serve({ jobs: [] });
    await expect(adapter.fetch(new Date(0))).rejects.toBeInstanceOf(SourceError);
    serve(["only", "strings"]);
    await expect(adapter.fetch(new Date(0))).rejects.toBeInstanceOf(SourceError);
  });

  it("skips one invalid job with a warn", async () => {
    const bad = { ...jobs[0], id: "bad-1", url: undefined };
    serve(wrap([...jobs, bad]));
    const postings = await adapter.fetch(new Date(0));
    expect(postings).toHaveLength(jobs.length);
    expect(postings.map((p) => p.externalId)).not.toContain("bad-1");
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ source: "web3career", externalId: "bad-1", path: "url" }),
    );
  });

  it("rejects with SourceError when more than 50% of jobs are invalid", async () => {
    const bad = (id: string) => ({ id, title: "t" });
    serve(wrap([jobs[0], bad("b1"), bad("b2")]));
    await expect(adapter.fetch(new Date(0))).rejects.toBeInstanceOf(SourceError);
  });

  it("accepts exactly 50% invalid jobs", async () => {
    serve(wrap([jobs[0], { id: "b1", title: "t" }]));
    await expect(adapter.fetch(new Date(0))).resolves.toHaveLength(1);
  });

  it("returns [] for a valid empty response", async () => {
    serve(wrap([]));
    await expect(adapter.fetch(new Date(0))).resolves.toEqual([]);
  });
});
