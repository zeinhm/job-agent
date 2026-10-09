import { PartialSourceError, SourceError, log, __testInjectTimeAndSleep } from "@job-agent/core";
import { readFileSync } from "node:fs";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeConfig } from "../test-utils.ts";
import { buildAdapters } from "../registry.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../../test/fixtures/workable/huggingface.json", import.meta.url), "utf-8"),
) as { jobs: Record<string, unknown>[] };

const API = "https://apply.workable.com/api/v1/widget/accounts";
const server = setupServer();

function adapterFor(...slugs: string[]) {
  const adapters = buildAdapters(
    makeConfig(slugs.map((slug) => ({ name: `Co ${slug}`, ats: "workable" as const, slug }))),
  );
  const adapter = adapters.find((a) => a.name === "workable");
  if (!adapter) throw new Error("no workable adapter");
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

describe("workable adapter", () => {
  it("returns one RawPosting per fixture job and requests details=true", async () => {
    let query = "";
    server.use(
      http.get(`${API}/alpha`, ({ request }) => {
        query = new URL(request.url).search;
        return HttpResponse.json(fixture);
      }),
    );
    const postings = await adapterFor("alpha").fetch(new Date(0));
    expect(query).toBe("?details=true");
    expect(postings).toHaveLength(fixture.jobs.length);
    expect(postings.every((p) => p.source === "workable" && p.company === "Co alpha")).toBe(true);
  });

  it("maps every available field", async () => {
    server.use(http.get(`${API}/alpha`, () => HttpResponse.json(fixture)));
    const postings = await adapterFor("alpha").fetch(new Date(0));
    expect(postings[0]).toEqual({
      source: "workable",
      externalId: "81B46579FE",
      url: "https://apply.workable.com/j/81B46579FE",
      applyUrl: "https://apply.workable.com/j/81B46579FE/apply",
      title: "Open-Source Machine Learning Engineer - EMEA Remote",
      company: "Co alpha",
      descriptionHtml: "<p>At Hugging Face, we're on a journey to democratize good AI.</p>",
      locationText: "Paris, Île-de-France, France; Berlin, Berlin, Germany",
      remote: true,
      postedAt: "2026-05-29T00:00:00.000Z",
      tags: ["Open Source", "Engineering", "Full-time", "Computer Software"],
    });
  });

  it("falls back to top-level location, created_at and remote=false", async () => {
    server.use(http.get(`${API}/alpha`, () => HttpResponse.json(fixture)));
    const p = (await adapterFor("alpha").fetch(new Date(0)))[1];
    expect(p?.locationText).toBe("New York, New York, United States");
    expect(p?.remote).toBe(false);
    expect(p?.postedAt).toBe("2026-09-15T00:00:00.000Z");
  });

  it("builds url from the shortcode and omits absent fields", async () => {
    server.use(http.get(`${API}/alpha`, () => HttpResponse.json(fixture)));
    const p = (await adapterFor("alpha").fetch(new Date(0)))[2];
    expect(p).toEqual({
      source: "workable",
      externalId: "ZZ00000001",
      url: "https://apply.workable.com/j/ZZ00000001",
      title: "Minimal Posting",
      company: "Co alpha",
    });
  });

  it("excludes jobs posted before since but keeps undated ones", async () => {
    server.use(http.get(`${API}/alpha`, () => HttpResponse.json(fixture)));
    const postings = await adapterFor("alpha").fetch(new Date("2026-08-01T00:00:00Z"));
    expect(postings.map((p) => p.externalId)).toEqual(["A1B2C3D4E5", "ZZ00000001"]);
  });

  it("has a 360 minute interval (R3)", () => {
    expect(adapterFor("alpha").minIntervalMinutes).toBe(360);
  });

  it("skips a 404 slug with a warn, reports it as a warning, and errors when all are 404", async () => {
    server.use(
      http.get(`${API}/gone`, () => new HttpResponse("Not Found", { status: 404 })),
      http.get(`${API}/alpha`, () => HttpResponse.json(fixture)),
    );
    const adapter = adapterFor("gone", "alpha");
    const postings = await adapter.fetch(new Date(0));
    expect(postings).toHaveLength(fixture.jobs.length);
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ slug: "gone" }),
    );
    expect(adapter.takeWarnings?.()).toEqual(["1 board not found: gone"]);

    server.use(http.get(`${API}/alpha`, () => new HttpResponse("Not Found", { status: 404 })));
    const err = await adapter.fetch(new Date(0)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).message).toContain("all 2 boards not found: gone, alpha");
  });

  it("tries every board and keeps the successes when one slug returns 500", async () => {
    server.use(
      http.get(`${API}/flaky`, () => new HttpResponse(null, { status: 500 })),
      http.get(`${API}/alpha`, () => HttpResponse.json(fixture)),
    );
    const err = await adapterFor("flaky", "alpha")
      .fetch(new Date(0))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartialSourceError);
    expect((err as PartialSourceError).postings).toHaveLength(fixture.jobs.length);
  });

  it("rejects with SourceError on an invalid envelope", async () => {
    server.use(http.get(`${API}/alpha`, () => HttpResponse.json([])));
    await expect(adapterFor("alpha").fetch(new Date(0))).rejects.toBeInstanceOf(SourceError);
  });

  it("skips one invalid job with a warn and rejects when over 50% are invalid", async () => {
    const good = fixture.jobs[0];
    const bad = (id: string) => ({ shortcode: id });
    server.use(
      http.get(`${API}/alpha`, () => HttpResponse.json({ jobs: [good, good, bad("bad-1")] })),
    );
    await expect(adapterFor("alpha").fetch(new Date(0))).resolves.toHaveLength(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ slug: "alpha", externalId: "bad-1", path: "title" }),
    );

    server.use(
      http.get(`${API}/alpha`, () => HttpResponse.json({ jobs: [good, bad("b1"), bad("b2")] })),
    );
    await expect(adapterFor("alpha").fetch(new Date(0))).rejects.toBeInstanceOf(SourceError);
  });

  it("returns [] for a valid empty board", async () => {
    server.use(http.get(`${API}/alpha`, () => HttpResponse.json({ name: "A", jobs: [] })));
    await expect(adapterFor("alpha").fetch(new Date(0))).resolves.toEqual([]);
  });
});
