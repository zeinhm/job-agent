import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeConfig } from "./test-utils.ts";
import { buildAdapters, pollingCompanies, type DiscoveredCompany } from "./registry.ts";

describe("buildAdapters", () => {
  const names = (config: ReturnType<typeof makeConfig>) => buildAdapters(config).map((a) => a.name);

  it("returns no lever adapter without a lever company", () => {
    expect(names(makeConfig())).not.toContain("lever");
    expect(names(makeConfig([{ name: "Acme", ats: "greenhouse", slug: "acme" }]))).not.toContain(
      "lever",
    );
  });

  it("always includes exactly one remoteok adapter", () => {
    expect(names(makeConfig()).filter((n) => n === "remoteok")).toHaveLength(1);
  });

  it("returns an ashby adapter only when the config has an ashby company", () => {
    expect(names(makeConfig())).not.toContain("ashby");
    expect(names(makeConfig([{ name: "G", ats: "greenhouse", slug: "g" }]))).not.toContain("ashby");
    const list = names(makeConfig([{ name: "A", ats: "ashby", slug: "a" }]));
    expect(list.filter((n) => n === "ashby")).toHaveLength(1);
  });

  it("returns a recruitee adapter only when the config has a recruitee company", () => {
    expect(names(makeConfig())).not.toContain("recruitee");
    const adapters = buildAdapters(makeConfig([{ name: "R", ats: "recruitee", slug: "r" }]));
    const recruitee = adapters.filter((a) => a.name === "recruitee");
    expect(recruitee).toHaveLength(1);
    expect(recruitee[0]?.minIntervalMinutes).toBe(360);
  });

  it("always includes exactly one himalayas adapter with a 60 minute interval", () => {
    const himalayas = buildAdapters(makeConfig()).filter((a) => a.name === "himalayas");
    expect(himalayas).toHaveLength(1);
    expect(himalayas[0]?.minIntervalMinutes).toBe(60);
  });

  it("always includes exactly one arbeitnow adapter with a 360 minute interval", () => {
    const arbeitnow = buildAdapters(makeConfig()).filter((a) => a.name === "arbeitnow");
    expect(arbeitnow).toHaveLength(1);
    expect(arbeitnow[0]?.minIntervalMinutes).toBe(360);
  });

  it("returns exactly one lever adapter when the config has lever companies", () => {
    const adapters = buildAdapters(
      makeConfig([
        { name: "Globex", ats: "lever", slug: "globex" },
        { name: "Initech", ats: "lever", slug: "initech" },
      ]),
    );
    const levers = adapters.filter((a) => a.name === "lever");
    expect(levers).toHaveLength(1);
    expect(levers[0]?.minIntervalMinutes).toBe(60);
  });

  it("always includes exactly one hn adapter with a monthly-thread interval", () => {
    const hn = buildAdapters(makeConfig()).filter((a) => a.name === "hn");
    expect(hn).toHaveLength(1);
    expect(hn[0]?.minIntervalMinutes).toBe(360);
  });

  it("returns one adapter per configured ATS", () => {
    const adapters = buildAdapters(
      makeConfig([
        { name: "Acme", ats: "greenhouse", slug: "acme" },
        { name: "Globex", ats: "lever", slug: "globex" },
        { name: "Initech", ats: "lever", slug: "initech" },
      ]),
    );
    expect(adapters.map((a) => a.name).filter((n) => n === "greenhouse" || n === "lever")).toEqual([
      "greenhouse",
      "lever",
    ]);
  });

  it("always returns exactly one web3career adapter", () => {
    const adapters = buildAdapters(makeConfig()).filter((a) => a.name === "web3career");
    expect(adapters).toHaveLength(1);
    expect(adapters[0]?.minIntervalMinutes).toBe(5);
  });
});

const row = (over: Partial<DiscoveredCompany> = {}): DiscoveredCompany => ({
  name: "Found Co",
  ats_type: "greenhouse",
  ats_slug: "found",
  verified: true,
  ...over,
});

describe("polling discovered companies", () => {
  vi.setConfig({ testTimeout: 30_000 });
  const server = setupServer();
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  const config = makeConfig([{ name: "Acme", ats: "greenhouse", slug: "acme" }]);

  it("polls config and verified DB companies; a duplicate ats+slug is kept once, config wins", () => {
    const list = pollingCompanies(config, [
      row({ name: "Acme From DB", ats_slug: "ACME" }),
      row(),
      row({ name: "Found Again" }),
      row({ name: "Other ATS", ats_type: "lever", ats_slug: "acme" }),
    ]);
    expect(list).toEqual([
      { name: "Acme", ats: "greenhouse", slug: "acme" },
      { name: "Found Co", ats: "greenhouse", slug: "found" },
      { name: "Other ATS", ats: "lever", slug: "acme" },
    ]);
  });

  it("does not poll unverified or ats-less DB companies", () => {
    const list = pollingCompanies(config, [
      row({ verified: false }),
      row({ name: "Null", verified: null, ats_slug: "n" }),
      row({ name: "No ats", ats_type: null }),
      row({ name: "No slug", ats_slug: null }),
    ]);
    expect(list.map((c) => c.slug)).toEqual(["acme"]);
  });

  it("creates an adapter for a DB-only company and reports its unknown slug", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/acme/jobs", () =>
        HttpResponse.json({ jobs: [] }),
      ),
      http.get(
        "https://boards-api.greenhouse.io/v1/boards/found/jobs",
        () => new HttpResponse(null, { status: 404 }),
      ),
    );
    const adapters = buildAdapters(config, [row()]).filter((a) => a.name === "greenhouse");
    expect(adapters).toHaveLength(1);
    await adapters[0]?.fetch(new Date(0));
    expect(adapters[0]?.takeWarnings?.()).toEqual(["1 board not found: found"]);
    vi.restoreAllMocks();
  });

  it("adds an adapter for an ATS present only in the DB", () => {
    const names = buildAdapters(makeConfig(), [row({ ats_type: "ashby", ats_slug: "x" })]).map(
      (a) => a.name,
    );
    expect(names).toContain("ashby");
  });

  it("adds adapters for recruitee, workable and smartrecruiters companies found only in the DB", () => {
    const names = buildAdapters(makeConfig(), [
      row({ ats_type: "recruitee", ats_slug: "r" }),
      row({ ats_type: "workable", ats_slug: "w" }),
      row({ ats_type: "smartrecruiters", ats_slug: "s" }),
    ]).map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(["recruitee", "workable", "smartrecruiters"]));
  });
});

describe("buildAdapters workable", () => {
  it("returns exactly one workable adapter only when the config has workable companies", () => {
    const names = (c: ReturnType<typeof makeConfig>) => buildAdapters(c).map((a) => a.name);
    expect(names(makeConfig())).not.toContain("workable");
    const list = names(
      makeConfig([
        { name: "A", ats: "workable", slug: "a" },
        { name: "B", ats: "workable", slug: "b" },
      ]),
    );
    expect(list.filter((n) => n === "workable")).toHaveLength(1);
  });
});

describe("buildAdapters smartrecruiters", () => {
  it("returns one smartrecruiters adapter (360 minute interval) only with smartrecruiters companies", () => {
    expect(
      buildAdapters(makeConfig([{ name: "A", ats: "lever", slug: "a" }])).map((a) => a.name),
    ).not.toContain("smartrecruiters");
    const adapters = buildAdapters(
      makeConfig([
        { name: "A", ats: "smartrecruiters", slug: "a" },
        { name: "B", ats: "smartrecruiters", slug: "b" },
      ]),
    ).filter((a) => a.name === "smartrecruiters");
    expect(adapters).toHaveLength(1);
    expect(adapters[0]?.minIntervalMinutes).toBe(360);
  });
});
