import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SourceError } from "@job-agent/core";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRemotiveAdapter } from "./index.ts";

// The shared HTTP client enforces a per-host interval and real retry backoff.
vi.setConfig({ testTimeout: 30_000 });

type FixtureJob = {
  id: number;
  url: string;
  title: string;
  company_name: string;
  tags: string[];
  publication_date: string;
  candidate_required_location: string;
  salary: string;
  description: string;
};

const fixturePath = fileURLToPath(
  new URL("../../test/fixtures/remotive/jobs.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { jobs: FixtureJob[] };

const API = "https://remotive.com/api/remote-jobs";

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

describe("remotive adapter", () => {
  it("has the expected name and the interval justified in the research doc", () => {
    const adapter = createRemotiveAdapter();
    expect(adapter.name).toBe("remotive");
    expect(adapter.minIntervalMinutes).toBe(360);
  });

  it("maps every fixture job and requests the software-dev category", async () => {
    let requested = "";
    server.use(
      http.get(API, ({ request }) => {
        requested = request.url;
        return HttpResponse.json(fixture);
      }),
    );

    const postings = await createRemotiveAdapter().fetch(new Date(0));

    expect(requested).toBe(`${API}?category=software-dev`);
    expect(postings).toHaveLength(fixture.jobs.length);
    const first = fixture.jobs[0] as FixtureJob;
    expect(postings[0]).toEqual({
      source: "remotive",
      externalId: "2091149",
      url: first.url,
      title: "Software Engineer / AI Code Trainer (Python, Web, Full Stack)",
      company: "CodeForAI",
      locationText:
        "USA, UK, India, Australia, Ireland, New Zealand, Philippines, Pakistan, Singapore, Mexico",
      descriptionHtml: first.description,
      salaryText: "$45-$120/Hour",
      postedAt: "2026-10-05T05:15:43.000Z",
      tags: first.tags,
    });
    expect(first.tags).toContain("python");
    expect(first.description).toContain("<p>");
  });

  it("drops jobs published before since", async () => {
    server.use(http.get(API, () => HttpResponse.json(fixture)));
    const since = new Date("2026-09-18T00:00:00Z");
    const expected = fixture.jobs
      .filter((j) => new Date(`${j.publication_date}Z`) >= since)
      .map((j) => String(j.id));
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(fixture.jobs.length);

    const postings = await createRemotiveAdapter().fetch(since);

    expect(postings.map((p) => p.externalId)).toEqual(expected);
  });

  it("keeps jobs without a date and omits empty optional fields", async () => {
    const undated: Partial<FixtureJob> = { ...fixture.jobs[0], salary: "", tags: [] };
    delete undated.publication_date;
    server.use(http.get(API, () => HttpResponse.json({ jobs: [undated] })));

    const postings = await createRemotiveAdapter().fetch(new Date());

    expect(postings).toHaveLength(1);
    expect(postings[0]).not.toHaveProperty("postedAt");
    expect(postings[0]).not.toHaveProperty("salaryText");
    expect(postings[0]).not.toHaveProperty("tags");
  });

  it("rejects with SourceError when the API keeps returning 500", async () => {
    captureLogs();
    server.use(http.get(API, () => new HttpResponse(null, { status: 500 })));

    const err = await createRemotiveAdapter()
      .fetch(new Date(0))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).source).toBe("remotive");
  });

  it("rejects with SourceError on an invalid envelope", async () => {
    server.use(http.get(API, () => HttpResponse.json({ postings: [] })));

    await expect(createRemotiveAdapter().fetch(new Date(0))).rejects.toBeInstanceOf(SourceError);
  });

  it("skips one invalid job with a warning", async () => {
    const logs = captureLogs();
    const bad = { ...(fixture.jobs[0] as FixtureJob), id: "not-a-number" };
    const good = fixture.jobs.slice(1, 4);
    server.use(http.get(API, () => HttpResponse.json({ jobs: [bad, ...good] })));

    const postings = await createRemotiveAdapter().fetch(new Date(0));

    expect(postings.map((p) => p.externalId)).toEqual(good.map((j) => String(j.id)));
    const warn = logs().find((l) => l.level === "warn" && l.path === "id");
    expect(warn).toMatchObject({ source: "remotive" });
  });

  it("rejects with SourceError when more than half of the jobs are invalid", async () => {
    captureLogs();
    const good = fixture.jobs[0] as FixtureJob;
    const bad = { ...good, title: "" };
    server.use(http.get(API, () => HttpResponse.json({ jobs: [bad, bad, good] })));

    await expect(createRemotiveAdapter().fetch(new Date(0))).rejects.toBeInstanceOf(SourceError);
  });

  it("accepts exactly half invalid jobs", async () => {
    captureLogs();
    const good = fixture.jobs[0] as FixtureJob;
    const bad = { ...good, title: "" };
    server.use(http.get(API, () => HttpResponse.json({ jobs: [bad, good] })));

    await expect(createRemotiveAdapter().fetch(new Date(0))).resolves.toHaveLength(1);
  });

  it("returns [] for a valid empty response", async () => {
    server.use(http.get(API, () => HttpResponse.json({ jobs: [] })));

    await expect(createRemotiveAdapter().fetch(new Date(0))).resolves.toEqual([]);
  });
});
