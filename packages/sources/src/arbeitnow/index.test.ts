import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SourceError } from "@job-agent/core";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createArbeitnowAdapter } from "./index.ts";

// The shared HTTP client enforces a per-host interval and real retry backoff.
vi.setConfig({ testTimeout: 30_000 });

type FixtureJob = {
  slug: string;
  company_name: string;
  title: string;
  description: string;
  remote: boolean;
  url: string;
  tags: string[];
  job_types: string[];
  location: string;
  created_at: number;
};
type Fixture = { data: FixtureJob[]; links: { next: string | null }; meta: unknown };

const fixturePath = fileURLToPath(
  new URL("../../test/fixtures/arbeitnow/page1.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

const API = "https://www.arbeitnow.com/api/job-board-api";
const lastPage = (data: unknown[]) => ({ data, links: { next: null } });

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

describe("arbeitnow adapter", () => {
  it("has the expected name and the interval from the research doc", () => {
    const adapter = createArbeitnowAdapter();
    expect(adapter.name).toBe("arbeitnow");
    expect(adapter.minIntervalMinutes).toBe(360);
    expect(fixture.data.length).toBeLessThanOrEqual(20);
  });

  it("maps every fixture job to a RawPosting", async () => {
    server.use(http.get(API, () => HttpResponse.json(lastPage(fixture.data))));

    const postings = await createArbeitnowAdapter().fetch(new Date(0));

    expect(postings).toHaveLength(fixture.data.length);
    const first = fixture.data[0] as FixtureJob;
    expect(postings[0]).toEqual({
      source: "arbeitnow",
      externalId: first.slug,
      url: first.url,
      title: first.title,
      company: first.company_name,
      descriptionHtml: first.description,
      locationText: "Remote, Berlin",
      postedAt: "2026-10-08T12:00:00.000Z",
      tags: ["Remote", "Software Development", "Full time", "Permanent"],
    });
    expect(postings[1]?.locationText).toBe("Munich");
  });

  it("drops jobs created before since", async () => {
    server.use(http.get(API, () => HttpResponse.json(lastPage(fixture.data))));
    const since = new Date("2026-09-20T00:00:00Z");
    const expected = fixture.data
      .filter((j) => j.created_at * 1000 >= since.getTime())
      .map((j) => j.slug);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(fixture.data.length);

    const postings = await createArbeitnowAdapter().fetch(since);

    expect(postings.map((p) => p.externalId)).toEqual(expected);
  });

  it("follows links.next and stops at the first page that reaches older jobs", async () => {
    const requested: string[] = [];
    const page1 = fixture.data.slice(0, 5);
    const page2 = fixture.data.slice(5, 10);
    server.use(
      http.get(API, ({ request }) => {
        const page = new URL(request.url).searchParams.get("page");
        requested.push(page ?? "");
        return HttpResponse.json(
          page === "1"
            ? { data: page1, links: { next: `${API}?page=2` } }
            : { data: page2, links: { next: `${API}?page=3` } },
        );
      }),
    );
    // Cut-off between job 7 and job 8: page 2 contains older jobs, so page 3 is never requested.
    const since = new Date((fixture.data[7] as FixtureJob).created_at * 1000);

    const postings = await createArbeitnowAdapter().fetch(since);

    expect(requested).toEqual(["1", "2"]);
    expect(postings.map((p) => p.externalId)).toEqual(fixture.data.slice(0, 8).map((j) => j.slug));
  });

  it("stops when links.next is null or the page is empty", async () => {
    const requested: string[] = [];
    server.use(
      http.get(API, ({ request }) => {
        requested.push(new URL(request.url).searchParams.get("page") ?? "");
        return HttpResponse.json(lastPage([]));
      }),
    );

    await expect(createArbeitnowAdapter().fetch(new Date(0))).resolves.toEqual([]);
    expect(requested).toEqual(["1"]);
  });

  it("fetches at most five pages", async () => {
    let calls = 0;
    server.use(
      http.get(API, () => {
        calls++;
        return HttpResponse.json({ data: [fixture.data[0]], links: { next: `${API}?page=99` } });
      }),
    );

    const postings = await createArbeitnowAdapter().fetch(new Date(0));

    expect(calls).toBe(5);
    expect(postings).toHaveLength(5);
  });

  it("keeps jobs without a date and omits empty optional fields", async () => {
    const bare = {
      slug: "bare-1",
      company_name: "Example Company",
      title: "Engineer",
      url: "https://www.arbeitnow.com/jobs/companies/example-company/bare-1",
      remote: false,
      tags: [],
      job_types: [],
      location: "",
    };
    server.use(http.get(API, () => HttpResponse.json(lastPage([bare]))));

    const postings = await createArbeitnowAdapter().fetch(new Date());

    expect(postings).toEqual([
      {
        source: "arbeitnow",
        externalId: "bare-1",
        url: bare.url,
        title: "Engineer",
        company: "Example Company",
      },
    ]);
  });

  it("rejects with SourceError when the API keeps returning 500", async () => {
    captureLogs();
    server.use(http.get(API, () => new HttpResponse(null, { status: 500 })));

    const err = await createArbeitnowAdapter()
      .fetch(new Date(0))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).source).toBe("arbeitnow");
  });

  it("rejects with SourceError on an invalid envelope", async () => {
    server.use(http.get(API, () => HttpResponse.json({ jobs: [] })));

    await expect(createArbeitnowAdapter().fetch(new Date(0))).rejects.toBeInstanceOf(SourceError);
  });

  it("skips one invalid job with a warning", async () => {
    const logs = captureLogs();
    const bad = { ...(fixture.data[0] as FixtureJob), created_at: "yesterday" };
    const good = fixture.data.slice(1, 4);
    server.use(http.get(API, () => HttpResponse.json(lastPage([bad, ...good]))));

    const postings = await createArbeitnowAdapter().fetch(new Date(0));

    expect(postings.map((p) => p.externalId)).toEqual(good.map((j) => j.slug));
    const warn = logs().find((l) => l.level === "warn" && l.path === "created_at");
    expect(warn).toMatchObject({ source: "arbeitnow", externalId: bad.slug });
  });

  it("rejects with SourceError when more than half of the jobs are invalid", async () => {
    captureLogs();
    const good = fixture.data[0] as FixtureJob;
    const bad = { ...good, title: "" };
    server.use(http.get(API, () => HttpResponse.json(lastPage([bad, bad, good]))));

    await expect(createArbeitnowAdapter().fetch(new Date(0))).rejects.toBeInstanceOf(SourceError);
  });

  it("accepts exactly half invalid jobs", async () => {
    captureLogs();
    const good = fixture.data[0] as FixtureJob;
    const bad = { ...good, title: "" };
    server.use(http.get(API, () => HttpResponse.json(lastPage([bad, good]))));

    await expect(createArbeitnowAdapter().fetch(new Date(0))).resolves.toHaveLength(1);
  });
});
