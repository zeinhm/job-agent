import { readFileSync } from "node:fs";
import { companies, log, openDb, __testInjectTimeAndSleep } from "@job-agent/core";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCompanyName } from "./normalize/index.ts";
import { loadPollableCompanies } from "./companies.ts";
import { MAX_YC_COMPANIES_PER_RUN, runDiscoverCompanies } from "./discover-companies.ts";

const YC_PAGE = "https://www.ycombinator.com/companies";
const ALGOLIA = "https://TESTAPP123-dsn.algolia.net/1/indexes/YCCompany_production";
const SEARCH = "https://api.search.brave.com/res/v1/web/search";
const fx = (f: string) =>
  readFileSync(new URL(`../../sources/test/fixtures/discovery/${f}`, import.meta.url), "utf-8");
const page = fx("yc-companies-page.html");
const hiring = JSON.parse(fx("yc-algolia-hiring.json")) as Record<string, unknown>;

const server = setupServer();
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
  vi.spyOn(log, "info").mockImplementation(() => undefined);
});

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, o: (t: string) => out.push(t), e: (t: string) => err.push(t) };
};
const html = (body: string) => new HttpResponse(body, { headers: { "content-type": "text/html" } });

describe("runDiscoverCompanies: YC directory", () => {
  it("stores hiring YC companies via_yc_directory without a Brave key, and `discover` would poll the verified ones", async () => {
    const algoliaHeaders: Array<string | null> = [];
    const algoliaUrls: string[] = [];
    const requests: string[] = [];
    server.use(
      http.get(YC_PAGE, () => html(page)),
      http.get(ALGOLIA, ({ request }) => {
        algoliaHeaders.push(request.headers.get("x-algolia-api-key"));
        algoliaUrls.push(request.url);
        return HttpResponse.json(hiring);
      }),
      http.get("https://careerspage.example/careers", () => {
        requests.push("careers");
        return html(fx("yc-careers.html"));
      }),
      http.get("https://noats.example/careers", () => {
        requests.push("noats-careers");
        return html("<html><body>No openings</body></html>");
      }),
      http.get("https://noats.example/jobs", () => {
        requests.push("noats-jobs");
        return new HttpResponse(null, { status: 404 });
      }),
      http.get("https://boards-api.greenhouse.io/v1/boards/directboard/jobs", () => {
        requests.push("gh");
        return HttpResponse.json({ jobs: [] });
      }),
      http.get("https://api.ashbyhq.com/posting-api/job-board/careerspage", () => {
        requests.push("ashby");
        return HttpResponse.json({ jobs: [] });
      }),
      http.get("https://api.lever.co/v0/postings/ghost-labs", () => {
        requests.push("lever");
        return new HttpResponse(null, { status: 404 });
      }),
    );
    const db = openDb(":memory:");
    db.insert(companies)
      .values({
        id: "k",
        name: "Known Co",
        normalized_name: normalizeCompanyName("Known Co"),
        ats_type: "greenhouse",
        ats_slug: "known-co",
        verified: true,
        created_at: "2026-01-01T00:00:00Z",
      })
      .run();
    const c = io();
    const code = await runDiscoverCompanies({
      db,
      apiKey: "",
      now: () => new Date("2026-10-14T00:00:00Z"),
      out: c.o,
      err: c.e,
    });
    expect(code).toBe(0);
    expect(c.err).toEqual([]);
    expect(algoliaHeaders).toEqual(["fake-secured-key-for-tests"]);
    expect(new URL(algoliaUrls[0] ?? "").searchParams.get("facetFilters")).toBe(
      '[["isHiring:true"],["regions:Fully Remote"]]',
    );

    const rows = db
      .select()
      .from(companies)
      .all()
      .filter((r) => r.discovered_via === "yc_directory");
    expect(rows.map((r) => `${r.name}|${r.ats_type}:${r.ats_slug}|${r.verified}`).sort()).toEqual([
      "Careers Page Co|ashby:careerspage|true",
      "Directboard Inc|greenhouse:directboard|true",
      "Ghost Labs|lever:ghost-labs|false",
      "No Ats Corp|null:null|false",
    ]);
    expect(rows.find((r) => r.name === "Careers Page Co")?.domain).toBe("careerspage.example");
    // Known Co is not duplicated.
    expect(db.select().from(companies).all()).toHaveLength(5);
    // Only verified boards are polled.
    expect(
      loadPollableCompanies(db)
        .map((r) => `${r.ats_type}:${r.ats_slug}`)
        .sort(),
    ).toEqual(["ashby:careerspage", "greenhouse:directboard", "greenhouse:known-co"]);
    // 1 directory page + 1 Algolia page + careers (1) + noats careers/jobs (2) + 3 verifications = 8.
    expect(c.out.join("")).toBe(
      "BRAVE_API_KEY not set, search discovery skipped\n" +
        "discover-companies yc: 5 in directory, 4 checked (cap 30), 2 new verified, 1 not found, 1 no ATS, " +
        "1 known, 0 errors, 8 requests\n",
    );
    expect(requests).toHaveLength(6);

    // Second run: everything is known, only the 2 directory requests are made.
    const c2 = io();
    requests.length = 0;
    await runDiscoverCompanies({ db, apiKey: "", out: c2.o, err: c2.e });
    expect(requests).toEqual([]);
    expect(db.select().from(companies).all()).toHaveLength(5);
    expect(c2.out.join("")).toContain(
      "0 checked (cap 30), 0 new verified, 0 not found, 0 no ATS, 5 known, 0 errors, 2 requests",
    );
  });

  it("checks at most MAX_YC_COMPANIES_PER_RUN new companies per run", async () => {
    expect(MAX_YC_COMPANIES_PER_RUN).toBe(30);
    const hits = Array.from({ length: 45 }, (_, i) => ({
      name: `Cap Co ${i}`,
      website: `https://boards.greenhouse.io/cap-co-${i}`,
    }));
    let verifies = 0;
    server.use(
      http.get(YC_PAGE, () => html(page)),
      http.get(ALGOLIA, () => HttpResponse.json({ hits, nbPages: 1 })),
      http.get(/boards-api\.greenhouse\.io/, () => {
        verifies++;
        return HttpResponse.json({ jobs: [] });
      }),
    );
    const db = openDb(":memory:");
    const c = io();
    await runDiscoverCompanies({ db, apiKey: "", out: c.o, err: c.e });
    expect(verifies).toBe(30);
    expect(db.select().from(companies).all()).toHaveLength(30);
    expect(c.out.join("")).toContain("45 in directory, 30 checked (cap 30), 30 new verified");
    // The next run continues with the remaining 15.
    await runDiscoverCompanies({ db, apiKey: "", out: c.o, err: c.e });
    expect(verifies).toBe(45);
  });

  it("directory failure: error line, exit 1, Brave discovery still runs", async () => {
    let searches = 0;
    server.use(
      http.get(YC_PAGE, () => new HttpResponse(null, { status: 403 })),
      http.get(SEARCH, () => {
        searches++;
        return HttpResponse.json({ web: { results: [{ url: "https://jobs.lever.co/lv-one/1" }] } });
      }),
      http.get(/api\.lever\.co/, () => HttpResponse.json([])),
    );
    const db = openDb(":memory:");
    const c = io();
    const code = await runDiscoverCompanies({
      db,
      apiKey: "k",
      queries: ["q"],
      out: c.o,
      err: c.e,
    });
    expect(code).toBe(1);
    expect(searches).toBe(1);
    expect(c.err.join("")).toContain("YC directory failed");
    expect(c.out.join("")).toContain("1 new verified");
    expect(
      db
        .select()
        .from(companies)
        .all()
        .map((r) => r.discovered_via),
    ).toEqual(["search"]);
  });

  it("a careers page that cannot be read is not stored and is retried next run", async () => {
    server.use(
      http.get(YC_PAGE, () => html(page)),
      http.get(ALGOLIA, () =>
        HttpResponse.json({
          hits: [{ name: "Flaky Co", website: "https://flaky.example" }],
          nbPages: 1,
        }),
      ),
      http.get(/flaky\.example/, () => new HttpResponse(null, { status: 403 })),
    );
    const db = openDb(":memory:");
    const c = io();
    await runDiscoverCompanies({ db, apiKey: "", out: c.o, err: c.e });
    expect(db.select().from(companies).all()).toHaveLength(0);
    expect(c.out.join("")).toContain("1 errors");
  });
});
