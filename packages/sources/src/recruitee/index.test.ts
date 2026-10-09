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
import { createRecruiteeAdapter } from "./index.ts";

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../test/fixtures/recruitee/bunq-offers.json", import.meta.url)),
    "utf8",
  ),
) as { offers: Array<Record<string, unknown>> };

const BOARD = /^https:\/\/([a-z0-9-]+)\.recruitee\.com\/api\/offers\/$/;
const acme: CompanyConfig = { name: "Acme Test", ats: "recruitee", slug: "acme" };
const globex: CompanyConfig = { name: "Globex Test", ats: "recruitee", slug: "globex" };

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
  http.get(BOARD, ({ request }) =>
    new URL(request.url).hostname === `${slug}.recruitee.com`
      ? HttpResponse.json(body as Record<string, unknown>)
      : undefined,
  );
const notFound = () =>
  http.get(BOARD, () => HttpResponse.json({ error: "Not Found" }, { status: 404 }));

const firstRaw = () => fixture.offers[0] as Record<string, string>;
const withSalary = (salary: unknown) => ({
  offers: [{ ...structuredClone(fixture.offers[0]), salary }],
});

describe("recruitee adapter", () => {
  it("exposes name and a 6 hour poll interval", () => {
    const adapter = createRecruiteeAdapter([acme], log);
    expect(adapter.name).toBe("recruitee");
    expect(adapter.minIntervalMinutes).toBe(360);
  });

  it("requests the company subdomain offers endpoint", async () => {
    server.use(serve("acme", fixture));
    await createRecruiteeAdapter([acme], log).fetch(new Date(0));
    expect(requests.map((r) => r.href)).toEqual(["https://acme.recruitee.com/api/offers/"]);
  });

  it("maps every published offer with every available field", async () => {
    server.use(serve("acme", fixture));
    const postings = await createRecruiteeAdapter([acme], log).fetch(new Date(0));
    expect(postings).toHaveLength(fixture.offers.length);
    const raw = firstRaw();
    const expected: RawPosting = {
      source: "recruitee",
      externalId: String(fixture.offers[0]?.id),
      url: raw.careers_url as string,
      applyUrl: raw.careers_apply_url as string,
      title: raw.title as string,
      company: "Acme Test",
      descriptionHtml: `${raw.description}\n${raw.requirements}`,
      locationText: raw.location as string,
      remote: false,
      postedAt: "2026-10-05T16:05:18.000Z",
    };
    expect(postings[0]).toEqual(expected);
    expect(postings.every((p) => p.source === "recruitee" && p.company === "Acme Test")).toBe(true);
    expect(postings.every((p) => p.descriptionHtml && p.locationText && p.postedAt)).toBe(true);
  });

  it("maps department and tags, remote and structured salary", async () => {
    const offer = {
      ...structuredClone(fixture.offers[0]),
      remote: true,
      department: "Engineering",
      tags: ["typescript", "backend"],
      salary: { min: 60000, max: 80000, currency: "eur", period: "year" },
    };
    server.use(serve("acme", { offers: [offer] }));
    const [posting] = await createRecruiteeAdapter([acme], log).fetch(new Date(0));
    expect(posting?.remote).toBe(true);
    expect(posting?.tags).toEqual(["Engineering", "typescript", "backend"]);
    expect(posting?.salary).toEqual({ min: 60000, max: 80000, currency: "EUR", period: "year" });
  });

  it("maps monthly pay and keeps a one-sided range", async () => {
    server.use(
      serve("acme", withSalary({ min: 4000, max: null, currency: "EUR", period: "month" })),
    );
    const [posting] = await createRecruiteeAdapter([acme], log).fetch(new Date(0));
    expect(posting?.salary).toEqual({ min: 4000, currency: "EUR", period: "month" });
  });

  it("leaves salary unset for the all-null object, an unknown period or a missing currency", async () => {
    for (const salary of [
      { min: null, max: null, currency: null, period: null },
      { min: 1, max: 2, currency: "EUR", period: "fortnight" },
      { min: 1, max: 2, currency: null, period: "year" },
      { min: null, max: null, currency: "EUR", period: "year" },
      null,
    ]) {
      server.use(serve("acme", withSalary(salary)));
      const [posting] = await createRecruiteeAdapter([acme], log).fetch(new Date(0));
      expect(posting, JSON.stringify(salary)).toBeDefined();
      expect(posting?.salary).toBeUndefined();
    }
  });

  it("skips offers that are not published", async () => {
    const draft = { ...structuredClone(fixture.offers[0]), id: 1, status: "draft" };
    server.use(serve("acme", { offers: [...fixture.offers, draft] }));
    const postings = await createRecruiteeAdapter([acme], log).fetch(new Date(0));
    expect(postings).toHaveLength(fixture.offers.length);
    expect(postings.some((p) => p.externalId === "1")).toBe(false);
  });

  it("excludes offers published before since and keeps undated ones", async () => {
    const undated = {
      ...structuredClone(fixture.offers[0]),
      id: 2,
      published_at: null,
      created_at: null,
    };
    server.use(serve("acme", { offers: [...fixture.offers, undated] }));
    const postings = await createRecruiteeAdapter([acme], log).fetch(
      new Date("2026-10-05T00:00:00Z"),
    );
    const expected = fixture.offers.filter((o) => String(o.published_at) >= "2026-10-05").length;
    expect(expected).toBeGreaterThan(0);
    expect(expected).toBeLessThan(fixture.offers.length);
    expect(postings).toHaveLength(expected + 1);
    expect(postings.some((p) => p.externalId === "2")).toBe(true);
    expect(postings.every((p) => !p.postedAt || p.postedAt >= "2026-10-05")).toBe(true);
  });

  it("warns and continues when one board is unknown (404)", async () => {
    server.use(serve("globex", fixture), notFound());
    const postings = await createRecruiteeAdapter([acme, globex], log).fetch(new Date(0));
    expect(postings).toHaveLength(fixture.offers.length);
    expect(postings.every((p) => p.company === "Globex Test")).toBe(true);
    const warn = logLines.find((l) => l.level === "warn");
    expect(warn?.slug).toBe("acme");
  });

  it("surfaces a 404 board as a warning and errors when every board is 404", async () => {
    server.use(serve("globex", fixture), notFound());
    const adapter = createRecruiteeAdapter([acme, globex], log);
    await adapter.fetch(new Date(0));
    expect(adapter.takeWarnings?.()).toEqual(["1 board not found: acme"]);
    expect(adapter.takeWarnings?.()).toEqual([]);

    server.use(notFound());
    const err = await adapter.fetch(new Date(0)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).message).toContain("all 2 boards not found: acme, globex");
  });

  it("tries every board and keeps the successes when one board returns 500", async () => {
    server.use(
      serve("globex", fixture),
      http.get(BOARD, () => new HttpResponse(null, { status: 500 })),
    );
    const err = await createRecruiteeAdapter([acme, globex], log)
      .fetch(new Date(0))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartialSourceError);
    expect((err as PartialSourceError).postings).toHaveLength(fixture.offers.length);
  });

  it("rejects with SourceError on 500 after retries", async () => {
    let calls = 0;
    server.use(
      http.get(BOARD, () => {
        calls++;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    const err = await createRecruiteeAdapter([acme], log)
      .fetch(new Date(0))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).source).toBe("recruitee");
    expect(calls).toBe(3);
  });

  it("rejects a slug that is not a valid hostname label without making a request", async () => {
    const evil: CompanyConfig = { name: "Evil", ats: "recruitee", slug: "evil.example.com/x?" };
    const err = await createRecruiteeAdapter([evil], log)
      .fetch(new Date(0))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(requests).toHaveLength(0);
  });

  it("rejects with SourceError on an invalid envelope", async () => {
    server.use(serve("acme", { offers: "nope" }));
    await expect(createRecruiteeAdapter([acme], log).fetch(new Date(0))).rejects.toBeInstanceOf(
      SourceError,
    );
  });

  it("skips one invalid offer with a warn log", async () => {
    const bad = { id: 99, title: "", careers_url: "not a url" };
    server.use(serve("acme", { offers: [...fixture.offers, bad] }));
    const postings = await createRecruiteeAdapter([acme], log).fetch(new Date(0));
    expect(postings).toHaveLength(fixture.offers.length);
    const warn = logLines.find((l) => l.level === "warn");
    expect(warn).toMatchObject({ source: "recruitee", slug: "acme", externalId: "99" });
  });

  it("rejects with SourceError when more than half of the offers are invalid", async () => {
    const offers = [fixture.offers[0], { id: 1 }, { id: 2 }];
    server.use(serve("acme", { offers }));
    await expect(createRecruiteeAdapter([acme], log).fetch(new Date(0))).rejects.toBeInstanceOf(
      SourceError,
    );
  });

  it("returns [] for a valid empty board", async () => {
    server.use(serve("acme", { offers: [] }));
    expect(await createRecruiteeAdapter([acme], log).fetch(new Date(0))).toEqual([]);
  });
});
