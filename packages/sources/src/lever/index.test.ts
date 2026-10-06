import { SourceError, log, __testInjectTimeAndSleep } from "@job-agent/core";
import { readFileSync } from "node:fs";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeConfig } from "../test-utils.ts";
import { buildAdapters } from "../registry.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../../test/fixtures/lever/leverdemo.json", import.meta.url), "utf-8"),
) as Record<string, unknown>[];

const API = "https://api.lever.co/v0/postings";
const server = setupServer();

function adapterFor(...slugs: string[]) {
  const adapters = buildAdapters(
    makeConfig(slugs.map((slug) => ({ name: `Co ${slug}`, ats: "lever" as const, slug }))),
  );
  const adapter = adapters[0];
  if (!adapter) throw new Error("no lever adapter");
  return adapter;
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

describe("lever adapter", () => {
  it("returns one RawPosting per fixture job", async () => {
    server.use(http.get(`${API}/alpha`, () => HttpResponse.json(fixture)));
    const postings = await adapterFor("alpha").fetch(new Date(0));
    expect(postings).toHaveLength(fixture.length);
    expect(postings.every((p) => p.source === "lever" && p.company === "Co alpha")).toBe(true);
  });

  it("maps a job fully", async () => {
    server.use(http.get(`${API}/alpha`, () => HttpResponse.json(fixture)));
    const postings = await adapterFor("alpha").fetch(new Date(0));
    const raw = fixture[0] as {
      description: string;
      descriptionPlain: string;
    };
    expect(postings[0]).toEqual({
      source: "lever",
      externalId: "ad208490-4052-4f91-a57e-433f2d1e484b",
      url: "https://jobs.lever.co/leverdemo/ad208490-4052-4f91-a57e-433f2d1e484b",
      applyUrl: "https://jobs.lever.co/leverdemo/ad208490-4052-4f91-a57e-433f2d1e484b/apply",
      title: "Customer Success Manager",
      company: "Co alpha",
      descriptionHtml: raw.description,
      descriptionText: raw.descriptionPlain,
      locationText: "Atlanta, Georgia",
      salary: { min: 85000, max: 175000, currency: "USD", period: "year" },
      postedAt: "2026-08-31T18:12:19.703Z",
      tags: ["Customer Success", "Customer Success Team", "Regular Full Time (Salary)"],
    });
  });

  it("sets remote only when workplaceType states it", async () => {
    server.use(http.get(`${API}/alpha`, () => HttpResponse.json(fixture)));
    const byTitle = new Map(
      (await adapterFor("alpha").fetch(new Date(0))).map((p) => [p.title, p]),
    );
    expect(byTitle.get("Sales Engineer")?.remote).toBe(true);
    expect(byTitle.get("Dentist")?.remote).toBe(false);
    expect(byTitle.get("Customer Success Manager")).not.toHaveProperty("remote");
    expect(byTitle.get("Stephanie Test Posting A")).not.toHaveProperty("remote");
  });

  it("excludes jobs posted before since", async () => {
    server.use(http.get(`${API}/alpha`, () => HttpResponse.json(fixture)));
    const since = new Date("2026-01-01T00:00:00Z");
    const expected = fixture.filter((j) => (j.createdAt as number) >= since.getTime());
    const postings = await adapterFor("alpha").fetch(since);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(fixture.length);
    expect(postings.map((p) => p.externalId).sort()).toEqual(
      expected.map((j) => j.id as string).sort(),
    );
  });

  it("keeps jobs without a date", async () => {
    server.use(
      http.get(`${API}/alpha`, () =>
        HttpResponse.json([{ id: "x1", text: "No date", hostedUrl: "https://jobs.lever.co/a/x1" }]),
      ),
    );
    const postings = await adapterFor("alpha").fetch(new Date("2030-01-01T00:00:00Z"));
    expect(postings).toHaveLength(1);
    expect(postings[0]).not.toHaveProperty("postedAt");
  });

  it("skips a 404 company with a warn naming the slug and returns the others", async () => {
    server.use(
      http.get(`${API}/gone`, () =>
        HttpResponse.json({ ok: false, error: "Document not found" }, { status: 404 }),
      ),
      http.get(`${API}/alpha`, () => HttpResponse.json(fixture)),
    );
    const postings = await adapterFor("gone", "alpha").fetch(new Date(0));
    expect(postings).toHaveLength(fixture.length);
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ slug: "gone" }),
    );
  });

  it("rejects with SourceError on 500 after retries", async () => {
    let calls = 0;
    server.use(
      http.get(`${API}/alpha`, () => {
        calls++;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    const err = await adapterFor("alpha")
      .fetch(new Date(0))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).source).toBe("lever");
    expect(calls).toBe(3);
  });

  it("rejects with SourceError on an invalid envelope", async () => {
    server.use(http.get(`${API}/alpha`, () => HttpResponse.json({ jobs: [] })));
    await expect(adapterFor("alpha").fetch(new Date(0))).rejects.toBeInstanceOf(SourceError);
  });

  it("skips one invalid job with a warn", async () => {
    const bad = { ...fixture[0], id: "bad-1", hostedUrl: undefined };
    server.use(http.get(`${API}/alpha`, () => HttpResponse.json([...fixture, bad])));
    const postings = await adapterFor("alpha").fetch(new Date(0));
    expect(postings).toHaveLength(fixture.length);
    expect(postings.map((p) => p.externalId)).not.toContain("bad-1");
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ slug: "alpha", externalId: "bad-1", path: "hostedUrl" }),
    );
  });

  it("rejects with SourceError when more than 50% of jobs are invalid", async () => {
    const bad = (id: string) => ({ id, text: "t" });
    server.use(
      http.get(`${API}/alpha`, () => HttpResponse.json([fixture[0], bad("b1"), bad("b2")])),
    );
    await expect(adapterFor("alpha").fetch(new Date(0))).rejects.toBeInstanceOf(SourceError);
  });

  it("accepts exactly 50% invalid jobs", async () => {
    server.use(
      http.get(`${API}/alpha`, () => HttpResponse.json([fixture[0], { id: "b1", text: "t" }])),
    );
    await expect(adapterFor("alpha").fetch(new Date(0))).resolves.toHaveLength(1);
  });

  it("returns [] for a valid empty board", async () => {
    server.use(http.get(`${API}/alpha`, () => HttpResponse.json([])));
    await expect(adapterFor("alpha").fetch(new Date(0))).resolves.toEqual([]);
  });

  it("follows pagination with skip and limit", async () => {
    const mk = (i: number) => ({
      id: `job-${i}`,
      text: `Job ${i}`,
      hostedUrl: `https://jobs.lever.co/alpha/job-${i}`,
    });
    const all = Array.from({ length: 150 }, (_, i) => mk(i));
    const skips: string[] = [];
    server.use(
      http.get(`${API}/alpha`, ({ request }) => {
        const url = new URL(request.url);
        const skip = Number(url.searchParams.get("skip"));
        const limit = Number(url.searchParams.get("limit"));
        skips.push(`${skip}/${limit}`);
        return HttpResponse.json(all.slice(skip, skip + limit));
      }),
    );
    const postings = await adapterFor("alpha").fetch(new Date(0));
    expect(postings).toHaveLength(150);
    expect(skips).toEqual(["0/100", "100/100"]);
  });
});
