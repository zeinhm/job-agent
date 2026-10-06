import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SourceError, type AppConfig } from "@job-agent/core";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildAdapters } from "../registry.ts";
import { createGreenhouseAdapter } from "./index.ts";

// The shared HTTP client enforces a per-host interval and real retry backoff.
vi.setConfig({ testTimeout: 30_000 });

type FixtureJob = {
  id: number;
  title: string;
  absolute_url: string;
  location: { name: string };
  content: string;
  first_published: string;
};

const fixturePath = fileURLToPath(
  new URL("../../test/fixtures/greenhouse/board.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { jobs: FixtureJob[] };

const acme = { name: "Acme Test", ats: "greenhouse" as const, slug: "acme" };
const globex = { name: "Globex Test", ats: "greenhouse" as const, slug: "globex" };
const API = "https://boards-api.greenhouse.io/v1/boards";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

function captureLogs(): () => Record<string, unknown>[] {
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("greenhouse adapter", () => {
  it("has the expected name and interval", () => {
    const adapter = createGreenhouseAdapter([acme]);
    expect(adapter.name).toBe("greenhouse");
    expect(adapter.minIntervalMinutes).toBe(60);
  });

  it("maps every fixture job and requests the board with content=true", async () => {
    let requested = "";
    server.use(
      http.get(`${API}/acme/jobs`, ({ request }) => {
        requested = request.url;
        return HttpResponse.json(fixture);
      }),
    );

    const postings = await createGreenhouseAdapter([acme]).fetch(new Date(0));

    expect(requested).toBe(`${API}/acme/jobs?content=true`);
    expect(postings).toHaveLength(fixture.jobs.length);
    const first = fixture.jobs[0] as FixtureJob;
    expect(postings[0]).toEqual({
      source: "greenhouse",
      externalId: String(first.id),
      url: first.absolute_url,
      applyUrl: first.absolute_url,
      title: first.title,
      company: "Acme Test",
      locationText: first.location.name,
      descriptionHtml: first.content,
      postedAt: new Date(first.first_published).toISOString(),
    });
    expect(postings[0]?.postedAt).toBe("2026-10-02T15:31:50.000Z");
    expect(postings[0]?.descriptionHtml).toContain("&lt;");
  });

  it("drops jobs published before since", async () => {
    server.use(http.get(`${API}/acme/jobs`, () => HttpResponse.json(fixture)));
    const since = new Date("2026-09-30T00:00:00Z");
    const expected = fixture.jobs
      .filter((j) => new Date(j.first_published) >= since)
      .map((j) => String(j.id));
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(fixture.jobs.length);

    const postings = await createGreenhouseAdapter([acme]).fetch(since);

    expect(postings.map((p) => p.externalId)).toEqual(expected);
  });

  it("keeps jobs without a date", async () => {
    const undated: Partial<FixtureJob> = { ...fixture.jobs[0] };
    delete undated.first_published;
    server.use(http.get(`${API}/acme/jobs`, () => HttpResponse.json({ jobs: [undated] })));

    const postings = await createGreenhouseAdapter([acme]).fetch(new Date());

    expect(postings).toHaveLength(1);
    expect(postings[0]).not.toHaveProperty("postedAt");
  });

  it("warns and continues when one company returns 404", async () => {
    const logs = captureLogs();
    server.use(
      http.get(`${API}/acme/jobs`, () =>
        HttpResponse.json({ status: 404, error: "Job not found" }, { status: 404 }),
      ),
      http.get(`${API}/globex/jobs`, () => HttpResponse.json(fixture)),
    );

    const postings = await createGreenhouseAdapter([acme, globex]).fetch(new Date(0));

    expect(postings).toHaveLength(fixture.jobs.length);
    expect(new Set(postings.map((p) => p.company))).toEqual(new Set(["Globex Test"]));
    const warn = logs().find((l) => l.level === "warn" && l.slug === "acme");
    expect(warn).toBeDefined();
  });

  it("rejects with SourceError when a board keeps returning 500", async () => {
    captureLogs();
    server.use(http.get(`${API}/acme/jobs`, () => new HttpResponse(null, { status: 500 })));

    const err = await createGreenhouseAdapter([acme])
      .fetch(new Date(0))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).source).toBe("greenhouse");
  });

  it("rejects with SourceError on an invalid envelope", async () => {
    server.use(http.get(`${API}/acme/jobs`, () => HttpResponse.json({ postings: [] })));

    await expect(createGreenhouseAdapter([acme]).fetch(new Date(0))).rejects.toBeInstanceOf(
      SourceError,
    );
  });

  it("rejects with SourceError when the body is not JSON", async () => {
    server.use(http.get(`${API}/acme/jobs`, () => HttpResponse.text("<html>oops</html>")));

    await expect(createGreenhouseAdapter([acme]).fetch(new Date(0))).rejects.toBeInstanceOf(
      SourceError,
    );
  });

  it("skips one invalid job with a warning", async () => {
    const logs = captureLogs();
    const bad = { ...(fixture.jobs[0] as FixtureJob), id: "not-a-number" };
    const good = fixture.jobs.slice(1, 4);
    server.use(http.get(`${API}/acme/jobs`, () => HttpResponse.json({ jobs: [bad, ...good] })));

    const postings = await createGreenhouseAdapter([acme]).fetch(new Date(0));

    expect(postings.map((p) => p.externalId)).toEqual(good.map((j) => String(j.id)));
    const warn = logs().find((l) => l.level === "warn" && l.path === "id");
    expect(warn).toMatchObject({ source: "greenhouse", slug: "acme" });
  });

  it("rejects with SourceError when more than half of the jobs are invalid", async () => {
    captureLogs();
    const good = fixture.jobs[0] as FixtureJob;
    const bad = { ...good, title: "" };
    server.use(http.get(`${API}/acme/jobs`, () => HttpResponse.json({ jobs: [bad, bad, good] })));

    await expect(createGreenhouseAdapter([acme]).fetch(new Date(0))).rejects.toBeInstanceOf(
      SourceError,
    );
  });

  it("accepts exactly half invalid jobs", async () => {
    captureLogs();
    const good = fixture.jobs[0] as FixtureJob;
    const bad = { ...good, title: "" };
    server.use(http.get(`${API}/acme/jobs`, () => HttpResponse.json({ jobs: [bad, good] })));

    await expect(createGreenhouseAdapter([acme]).fetch(new Date(0))).resolves.toHaveLength(1);
  });

  it("returns [] for a valid empty board", async () => {
    server.use(http.get(`${API}/acme/jobs`, () => HttpResponse.json({ jobs: [] })));

    await expect(createGreenhouseAdapter([acme]).fetch(new Date(0))).resolves.toEqual([]);
  });
});

describe("buildAdapters (greenhouse)", () => {
  const base: AppConfig = {
    salary: {
      floor_idr_month: 1,
      position_in_listed_range: 0.5,
      tiers: {
        indonesia: { ask_idr_month: 1 },
        regional: { ask_idr_month: 1 },
        global_adjusted: { ask_idr_month: 1 },
        global_flat: { ask_usd_year: 1 },
      },
      unknown_policy: "x",
      text_field_answer: "x",
      review_salary_answers: false,
    },
    companies: [],
  };

  it("returns a greenhouse adapter when the config has a greenhouse company", () => {
    const adapters = buildAdapters({ ...base, companies: [acme] });
    expect(adapters.map((a) => a.name)).toEqual(["greenhouse", "himalayas"]);
  });

  it("returns none when the config has only other ATS companies", () => {
    const adapters = buildAdapters({
      ...base,
      companies: [{ name: "Other", ats: "lever", slug: "other" }],
    });
    expect(adapters.map((a) => a.name)).not.toContain("greenhouse");
  });

  it("only requests boards of greenhouse companies", async () => {
    server.use(http.get(`${API}/acme/jobs`, () => HttpResponse.json({ jobs: [] })));
    const adapters = buildAdapters({
      ...base,
      companies: [{ name: "Other", ats: "lever", slug: "other" }, acme],
    });
    await expect(adapters[0]?.fetch(new Date(0))).resolves.toEqual([]);
  });
});
