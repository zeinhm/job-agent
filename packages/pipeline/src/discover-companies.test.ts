import { readFileSync } from "node:fs";
import { companies, log, openDb, __testInjectTimeAndSleep } from "@job-agent/core";
import { DAILY_QUERY_BUDGET } from "@job-agent/sources";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPollableCompanies } from "./companies.ts";
import { main } from "./cli.ts";
import { runDiscoverCompanies } from "./discover-companies.ts";

const SEARCH = "https://api.search.brave.com/res/v1/web/search";
const fixture = JSON.parse(
  readFileSync(
    new URL("../../sources/test/fixtures/discovery/brave-search.json", import.meta.url),
    "utf-8",
  ),
) as Record<string, unknown>;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
  vi.spyOn(log, "info").mockImplementation(() => undefined);
});

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, o: (t: string) => out.push(t), e: (t: string) => err.push(t) };
}

const oneResult = (url: string) => ({ web: { results: [{ url }] } });

describe("runDiscoverCompanies", () => {
  it("stores new verified slugs from a search response with the right ats + slug", async () => {
    const seen: string[] = [];
    server.use(
      http.get(SEARCH, ({ request }) => {
        expect(request.headers.get("x-subscription-token")).toBe("k");
        return HttpResponse.json(fixture);
      }),
      http.get(/^https:\/\/(boards-api|api|apply)\./, ({ request }) => {
        seen.push(request.url);
        return HttpResponse.json({});
      }),
      http.get(/recruitee\.com\/api\/offers/, () => HttpResponse.json({ offers: [] })),
    );
    const db = openDb(":memory:");
    const c = io();
    const code = await runDiscoverCompanies({
      db,
      apiKey: "k",
      queries: ["q"],
      now: () => new Date("2026-10-09T00:00:00Z"),
      out: c.o,
      err: c.e,
    });
    expect(code).toBe(0);
    const rows = db.select().from(companies).all();
    expect(rows.map((r) => `${r.ats_type}:${r.ats_slug}`).sort()).toEqual([
      "ashby:Ab.Corp",
      "greenhouse:gh-alpha",
      "greenhouse:gh-beta",
      "greenhouse:gh-embed",
      "greenhouse:gh-embed2",
      "greenhouse:gh-gamma",
      "lever:lv-alpha",
      "lever:lv-eu",
      "recruitee:rc-alpha",
      "smartrecruiters:sr-alpha",
      "smartrecruiters:sr-beta",
      "workable:wk-alpha",
    ]);
    expect(rows.every((r) => r.discovered_via === "search" && r.verified === true)).toBe(true);
    expect(rows[0]?.discovered_at).toBe("2026-10-09T00:00:00.000Z");
    // Counts only on stdout; no company names.
    expect(c.out.join("")).toContain("12 new verified");
    expect(c.out.join("")).not.toContain("gh-alpha");
  });

  it("does not duplicate existing companies and makes no verify request for them", async () => {
    let boardRequests = 0;
    server.use(
      http.get(SEARCH, () =>
        HttpResponse.json({
          web: {
            results: [
              { url: "https://boards.greenhouse.io/Known-Co/jobs/1" },
              { url: "https://boards.greenhouse.io/known-co" },
              { url: "https://jobs.lever.co/other/1" },
            ],
          },
        }),
      ),
      http.get(/boards-api|api\.lever/, () => {
        boardRequests++;
        return HttpResponse.json({});
      }),
    );
    const db = openDb(":memory:");
    db.insert(companies)
      .values({
        id: "1",
        name: "Known Co",
        normalized_name: "known co",
        ats_type: "greenhouse",
        ats_slug: "known-co",
        verified: true,
        created_at: "2026-01-01T00:00:00Z",
      })
      .run();
    const c = io();
    await runDiscoverCompanies({ db, apiKey: "k", queries: ["q", "q2"], out: c.o, err: c.e });
    expect(db.select().from(companies).all()).toHaveLength(2);
    expect(boardRequests).toBe(1);
    // Second run: nothing new.
    await runDiscoverCompanies({ db, apiKey: "k", queries: ["q"], out: c.o, err: c.e });
    expect(db.select().from(companies).all()).toHaveLength(2);
    expect(boardRequests).toBe(1);
  });

  it("keeps a 404 board unverified and never polls it", async () => {
    server.use(
      http.get(SEARCH, () =>
        HttpResponse.json({
          web: {
            results: [
              { url: "https://boards.greenhouse.io/ghost-co/jobs/1" },
              { url: "https://jobs.lever.co/real-co/1" },
            ],
          },
        }),
      ),
      http.get(/boards-api/, () => new HttpResponse(null, { status: 404 })),
      http.get(/api\.lever/, () => HttpResponse.json([])),
    );
    const db = openDb(":memory:");
    const c = io();
    await runDiscoverCompanies({ db, apiKey: "k", queries: ["q"], out: c.o, err: c.e });
    const ghost = db
      .select()
      .from(companies)
      .all()
      .find((r) => r.ats_slug === "ghost-co");
    expect(ghost?.verified).toBe(false);
    expect(ghost?.discovered_via).toBe("search");
    expect(loadPollableCompanies(db).map((r) => r.ats_slug)).toEqual(["real-co"]);
    expect(c.out.join("")).toContain("1 not found");
  });

  it("stores nothing when verification fails with a non-404 error", async () => {
    server.use(
      http.get(SEARCH, () => HttpResponse.json(oneResult("https://jobs.lever.co/flaky/1"))),
      http.get(/api\.lever/, () => new HttpResponse(null, { status: 403 })),
    );
    const db = openDb(":memory:");
    const c = io();
    expect(
      await runDiscoverCompanies({ db, apiKey: "k", queries: ["q"], out: c.o, err: c.e }),
    ).toBe(0);
    expect(db.select().from(companies).all()).toHaveLength(0);
    expect(c.out.join("")).toContain("1 verify errors");
  });

  it("never runs more queries than the daily budget", async () => {
    let searches = 0;
    server.use(
      http.get(SEARCH, () => {
        searches++;
        return HttpResponse.json({ web: { results: [] } });
      }),
    );
    const many = Array.from({ length: DAILY_QUERY_BUDGET + 15 }, (_, i) => `q${i}`);
    await runDiscoverCompanies({
      db: openDb(":memory:"),
      apiKey: "k",
      queries: many,
      ...(() => {
        const c = io();
        return { out: c.o, err: c.e };
      })(),
    });
    expect(searches).toBe(DAILY_QUERY_BUDGET);
  });

  it("returns 1 when every query fails", async () => {
    server.use(http.get(SEARCH, () => new HttpResponse(null, { status: 401 })));
    const c = io();
    expect(
      await runDiscoverCompanies({
        db: openDb(":memory:"),
        apiKey: "k",
        queries: ["q"],
        out: c.o,
        err: c.e,
      }),
    ).toBe(1);
  });

  it("skips with a message, no requests and exit 0 when the key is missing", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    const c = io();
    const db = openDb(":memory:");
    expect(await runDiscoverCompanies({ db, out: c.o, err: c.e })).toBe(0);
    expect(c.out.join("")).toBe("BRAVE_API_KEY not set, company discovery skipped\n");
    expect(db.select().from(companies).all()).toHaveLength(0);
  });

  it("CLI command skips with exit 0 and no network when the key is missing", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("JOB_AGENT_DB", ":memory:");
    const out: string[] = [];
    const code = await main(["discover-companies"], {
      out: (t) => out.push(t),
      err: () => undefined,
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("company discovery skipped");
  });
});
