import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PartialSourceError,
  SourceError,
  __testInjectTimeAndSleep,
  createLogger,
  type CompanyConfig,
  type RawPosting,
} from "@job-agent/core";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAshbyAdapter } from "./index.ts";

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../test/fixtures/ashby/ramp-board.json", import.meta.url)),
    "utf8",
  ),
) as { apiVersion: string; jobs: Array<Record<string, unknown>> };

const BOARD = "https://api.ashbyhq.com/posting-api/job-board/:slug";
const acme: CompanyConfig = { name: "Acme Test", ats: "ashby", slug: "acme" };
const globex: CompanyConfig = { name: "Globex Test", ats: "ashby", slug: "globex" };

const server = setupServer();
let logLines: Array<Record<string, unknown>> = [];
const log = createLogger((line) => logLines.push(JSON.parse(line) as Record<string, unknown>));
const requests: URL[] = [];

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  logLines = [];
  requests.length = 0;
  let now = 0;
  __testInjectTimeAndSleep(
    () => new Date(now),
    async (ms) => {
      now += ms;
    },
  );
  server.events.on("request:start", ({ request }) => requests.push(new URL(request.url)));
});
afterEach(() => {
  server.resetHandlers();
  server.events.removeAllListeners();
});

const serve = (slug: string, body: unknown) =>
  http.get(BOARD, ({ params }) =>
    params.slug === slug ? HttpResponse.json(body as Record<string, unknown>) : undefined,
  );

const byId = (postings: RawPosting[], prefix: string) => {
  const p = postings.find((x) => x.externalId.startsWith(prefix));
  if (!p) throw new Error(`no posting ${prefix}`);
  return p;
};

describe("ashby adapter", () => {
  it("exposes name and poll interval", () => {
    const adapter = createAshbyAdapter([acme], log);
    expect(adapter.name).toBe("ashby");
    expect(adapter.minIntervalMinutes).toBe(60);
  });

  it("maps every listed job and requests compensation", async () => {
    server.use(serve("acme", fixture));
    const postings = await createAshbyAdapter([acme], log).fetch(new Date(0));
    expect(postings).toHaveLength(fixture.jobs.length);
    expect(requests[0]?.searchParams.get("includeCompensation")).toBe("true");
    expect(postings.every((p) => p.source === "ashby" && p.company === "Acme Test")).toBe(true);
  });

  it("maps a job with compensation, including structured salary", async () => {
    server.use(serve("acme", fixture));
    const postings = await createAshbyAdapter([acme], log).fetch(new Date(0));
    const raw = fixture.jobs.find((j) => String(j.id).startsWith("f564dcf9")) as Record<
      string,
      string
    >;
    expect(byId(postings, "f564dcf9")).toEqual({
      source: "ashby",
      externalId: "f564dcf9-9390-4a3f-896f-8047a5086040",
      url: raw.jobUrl,
      applyUrl: raw.applyUrl,
      title: raw.title,
      company: "Acme Test",
      descriptionHtml: raw.descriptionHtml,
      descriptionText: raw.descriptionPlain,
      locationText: raw.location,
      remote: true,
      salaryText: "$189K – $330K • Offers Equity",
      salary: { min: 189000, max: 330000, currency: "USD", period: "year" },
      postedAt: "2025-07-31T21:58:34.674Z",
      tags: [raw.department, raw.team].filter(Boolean),
    });
  });

  it("maps a job without compensation to no salary fields", async () => {
    server.use(serve("acme", fixture));
    const postings = await createAshbyAdapter([acme], log).fetch(new Date(0));
    const raw = fixture.jobs.find((j) => String(j.id).startsWith("1515fe6d")) as Record<
      string,
      string
    >;
    expect(byId(postings, "1515fe6d")).toEqual({
      source: "ashby",
      externalId: "1515fe6d-1d8e-475b-a5ee-cefe43e78cb7",
      url: raw.jobUrl,
      applyUrl: raw.applyUrl,
      title: raw.title,
      company: "Acme Test",
      descriptionHtml: raw.descriptionHtml,
      descriptionText: raw.descriptionPlain,
      locationText: raw.location,
      remote: false,
      postedAt: "2026-06-08T19:17:53.481Z",
      tags: [raw.department, raw.team].filter(Boolean),
    });
  });

  it("maps monthly pay and takes the envelope across multiple tiers", async () => {
    server.use(serve("acme", fixture));
    const postings = await createAshbyAdapter([acme], log).fetch(new Date(0));
    expect(byId(postings, "b39ceb08").salary).toEqual({
      min: 12500,
      max: 12500,
      currency: "USD",
      period: "month",
    });
    const multi = byId(postings, "d84bbf19");
    expect(multi.salary).toEqual({ min: 190000, max: 330000, currency: "USD", period: "year" });
    expect(multi.salaryText).toContain("Multiple Ranges");
  });

  it("keeps salaryText but leaves salary unset for an unknown period", async () => {
    const job = structuredClone(fixture.jobs.find((j) => String(j.id).startsWith("f564dcf9")));
    if (!job) throw new Error("fixture job missing");
    const tiers = (job.compensation as { compensationTiers: Array<{ components: unknown[] }> })
      .compensationTiers;
    for (const c of tiers.flatMap((t) => t.components) as Array<Record<string, unknown>>) {
      if (c.compensationType === "Salary") c.interval = "1 FORTNIGHT";
    }
    server.use(serve("acme", { apiVersion: "1", jobs: [job] }));
    const [posting] = await createAshbyAdapter([acme], log).fetch(new Date(0));
    expect(posting?.salary).toBeUndefined();
    expect(posting?.salaryText).toBe("$189K – $330K • Offers Equity");
  });

  it("excludes jobs published before since and keeps undated ones", async () => {
    const undated = { ...structuredClone(fixture.jobs[0]), id: "undated", publishedAt: null };
    server.use(serve("acme", { apiVersion: "1", jobs: [...fixture.jobs, undated] }));
    const postings = await createAshbyAdapter([acme], log).fetch(new Date("2026-06-01T00:00:00Z"));
    const expected = fixture.jobs.filter((j) => String(j.publishedAt) >= "2026-06-01").length;
    expect(expected).toBeGreaterThan(0);
    expect(expected).toBeLessThan(fixture.jobs.length);
    expect(postings).toHaveLength(expected + 1);
    expect(postings.some((p) => p.externalId === "undated")).toBe(true);
    expect(postings.every((p) => !p.postedAt || p.postedAt >= "2026-06-01")).toBe(true);
  });

  it("warns and continues when one board is unknown (404)", async () => {
    server.use(
      serve("globex", fixture),
      http.get(BOARD, () => new HttpResponse(null, { status: 404 })),
    );
    const postings = await createAshbyAdapter([acme, globex], log).fetch(new Date(0));
    expect(postings).toHaveLength(fixture.jobs.length);
    expect(postings.every((p) => p.company === "Globex Test")).toBe(true);
    const warn = logLines.find((l) => l.level === "warn");
    expect(warn?.slug).toBe("acme");
  });

  it("surfaces a 404 board as a warning and errors when every board is 404", async () => {
    server.use(
      serve("globex", fixture),
      http.get(BOARD, () => new HttpResponse(null, { status: 404 })),
    );
    const adapter = createAshbyAdapter([acme, globex], log);
    await adapter.fetch(new Date(0));
    expect(adapter.takeWarnings?.()).toEqual(["1 board not found: acme"]);

    server.use(http.get(BOARD, () => new HttpResponse(null, { status: 404 })));
    const err = await adapter.fetch(new Date(0)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).message).toContain("all 2 boards not found: acme, globex");
  });

  it("tries every board and keeps the successes when one board returns 500", async () => {
    server.use(
      serve("globex", fixture),
      http.get(BOARD, () => new HttpResponse(null, { status: 500 })),
    );
    const err = await createAshbyAdapter([acme, globex], log)
      .fetch(new Date(0))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartialSourceError);
    expect((err as PartialSourceError).postings).toHaveLength(fixture.jobs.length);
  });

  it("rejects with SourceError on 500 after retries", async () => {
    let calls = 0;
    server.use(
      http.get(BOARD, () => {
        calls++;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    const err = await createAshbyAdapter([acme], log)
      .fetch(new Date(0))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).source).toBe("ashby");
    expect(calls).toBe(3);
  });

  it("rejects with SourceError on an invalid envelope", async () => {
    server.use(serve("acme", { apiVersion: "1", jobs: "nope" }));
    await expect(createAshbyAdapter([acme], log).fetch(new Date(0))).rejects.toBeInstanceOf(
      SourceError,
    );
  });

  it("skips one invalid job with a warn log", async () => {
    const bad = { id: "bad-job", title: "", jobUrl: "not a url" };
    server.use(serve("acme", { apiVersion: "1", jobs: [...fixture.jobs, bad] }));
    const postings = await createAshbyAdapter([acme], log).fetch(new Date(0));
    expect(postings).toHaveLength(fixture.jobs.length);
    const warn = logLines.find((l) => l.level === "warn");
    expect(warn).toMatchObject({ source: "ashby", slug: "acme", externalId: "bad-job" });
  });

  it("rejects with SourceError when more than half of the jobs are invalid", async () => {
    const jobs = [fixture.jobs[0], { id: "x1" }, { id: "x2" }];
    server.use(serve("acme", { apiVersion: "1", jobs }));
    await expect(createAshbyAdapter([acme], log).fetch(new Date(0))).rejects.toBeInstanceOf(
      SourceError,
    );
  });

  it("returns [] for a valid empty board", async () => {
    server.use(serve("acme", { apiVersion: "1", jobs: [] }));
    expect(await createAshbyAdapter([acme], log).fetch(new Date(0))).toEqual([]);
  });
});
