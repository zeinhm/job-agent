import { SourceError, log, __testInjectTimeAndSleep } from "@job-agent/core";
import { readFileSync } from "node:fs";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWeWorkRemotelyAdapter } from "./index.ts";

const BASE = "https://weworkremotely.com/categories";
const FRONT_END = `${BASE}/remote-front-end-programming-jobs.rss`;
const FULL_STACK = `${BASE}/remote-full-stack-programming-jobs.rss`;
const PROGRAMMING = `${BASE}/remote-programming-jobs.rss`;

function readFeed(name: string): string {
  return readFileSync(
    new URL(`../../test/fixtures/weworkremotely/${name}.rss`, import.meta.url),
    "utf-8",
  );
}

const feeds = {
  frontEnd: readFeed("front-end"),
  fullStack: readFeed("full-stack"),
  programming: readFeed("programming"),
};

const xml = (body: string) =>
  new HttpResponse(body, { headers: { "Content-Type": "application/rss+xml" } });

function rss(items: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>t</title>${items}</channel></rss>`;
}

function item(fields: Record<string, string>): string {
  const inner = Object.entries(fields)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join("");
  return `<item>${inner}</item>`;
}

const good = (n: number, extra: Record<string, string> = {}) =>
  item({
    title: `Acme${n}: Engineer ${n}`,
    pubDate: "Tue, 06 Oct 2026 07:31:26 +0000",
    guid: `https://weworkremotely.com/remote-jobs/acme-${n}`,
    link: `https://weworkremotely.com/remote-jobs/acme-${n}`,
    ...extra,
  });

const server = setupServer();

/** Serves the recorded fixtures for the three feeds. */
function serveFixtures() {
  server.use(
    http.get(FRONT_END, () => xml(feeds.frontEnd)),
    http.get(FULL_STACK, () => xml(feeds.fullStack)),
    http.get(PROGRAMMING, () => xml(feeds.programming)),
  );
}

/** Serves the same body from all three feeds. */
function serveAll(body: string) {
  server.use(
    http.get(FRONT_END, () => xml(body)),
    http.get(FULL_STACK, () => xml(body)),
    http.get(PROGRAMMING, () => xml(body)),
  );
}

const adapter = createWeWorkRemotelyAdapter();
let warn: ReturnType<typeof vi.spyOn>;

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
  warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
});

describe("weworkremotely adapter", () => {
  it("identifies itself and polls at most hourly", () => {
    expect(adapter.name).toBe("weworkremotely");
    expect(adapter.minIntervalMinutes).toBe(60);
  });

  it("returns one RawPosting per unique item across the feeds", async () => {
    serveFixtures();
    const postings = await adapter.fetch(new Date(0));
    const totalItems = Object.values(feeds).reduce(
      (n, f) => n + (f.match(/<item>/g) ?? []).length,
      0,
    );
    expect(totalItems).toBe(20);
    expect(postings).toHaveLength(17);
    expect(new Set(postings.map((p) => p.externalId)).size).toBe(17);
    expect(postings.every((p) => p.source === "weworkremotely")).toBe(true);
  });

  it("maps an item fully", async () => {
    serveFixtures();
    const postings = await adapter.fetch(new Date(0));
    const lemon = postings.find((p) => p.company === "Lemon.io");
    expect(lemon).toEqual({
      source: "weworkremotely",
      externalId:
        "https://weworkremotely.com/remote-jobs/lemon-io-senior-angular-full-stack-developer",
      url: "https://weworkremotely.com/remote-jobs/lemon-io-senior-angular-full-stack-developer",
      title: "Senior Angular Full-stack Developer",
      company: "Lemon.io",
      descriptionHtml: expect.stringContaining("<strong>Headquarters:</strong> New York, NY"),
      locationText: "Anywhere in the World",
      postedAt: "2026-10-06T13:25:57.000Z",
      tags: [
        "Full-Stack Programming",
        "AngularJS",
        "AWS",
        "Azure",
        "Node.js",
        "PHP",
        "Engineer",
        "Developer",
        "Full Stack Dev",
        "Full Time",
        "English",
        "Laravel",
        "GCP",
        "TypeScript",
      ],
    });
  });

  it("decodes entities in titles", async () => {
    serveFixtures();
    const postings = await adapter.fetch(new Date(0));
    const dropbox = postings.find((p) => p.company === "Dropbox");
    expect(dropbox?.title).toBe("Director of Media Strategy & Activation (Paid Media)");
  });

  it("uses company 'unknown' and keeps the title when there is no colon", async () => {
    serveAll(rss(good(1, { title: "Senior Rust Engineer" })));
    const postings = await adapter.fetch(new Date(0));
    expect(postings).toHaveLength(1);
    expect(postings[0]).toMatchObject({ company: "unknown", title: "Senior Rust Engineer" });
  });

  it("splits only on the first colon", async () => {
    serveAll(rss(good(1, { title: "Acme: Staff Engineer: Platform" })));
    const [posting] = await adapter.fetch(new Date(0));
    expect(posting).toMatchObject({ company: "Acme", title: "Staff Engineer: Platform" });
  });

  it("falls back to the link when there is no guid", async () => {
    const noGuid = item({
      title: "Acme: Engineer",
      link: "https://weworkremotely.com/remote-jobs/acme-x",
    });
    serveAll(rss(noGuid));
    const [posting] = await adapter.fetch(new Date(0));
    expect(posting?.externalId).toBe("https://weworkremotely.com/remote-jobs/acme-x");
    expect(posting).not.toHaveProperty("postedAt");
  });

  it("returns an item present in two feeds once", async () => {
    server.use(
      http.get(FRONT_END, () => xml(rss(""))),
      http.get(FULL_STACK, () => xml(rss(good(1) + good(2)))),
      http.get(PROGRAMMING, () => xml(rss(good(2) + good(3)))),
    );
    const postings = await adapter.fetch(new Date(0));
    expect(postings.map((p) => p.externalId)).toEqual([
      "https://weworkremotely.com/remote-jobs/acme-1",
      "https://weworkremotely.com/remote-jobs/acme-2",
      "https://weworkremotely.com/remote-jobs/acme-3",
    ]);
  });

  it("excludes items dated before since", async () => {
    serveFixtures();
    const since = new Date("2026-10-06T00:00:00Z");
    const postings = await adapter.fetch(since);
    expect(postings.length).toBeGreaterThan(0);
    expect(postings.length).toBeLessThan(17);
    expect(postings.every((p) => new Date(p.postedAt as string) >= since)).toBe(true);
  });

  it("returns [] for valid empty feeds", async () => {
    serveAll(rss(""));
    await expect(adapter.fetch(new Date(0))).resolves.toEqual([]);
  });

  it("throws SourceError on malformed XML", async () => {
    serveAll("<rss><channel><item><title>oops</channel></rss>");
    const err = await adapter.fetch(new Date(0)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).source).toBe("weworkremotely");
  });

  it("throws SourceError when the document is not an RSS feed", async () => {
    serveAll("<html><body>blocked</body></html>");
    const err = await adapter.fetch(new Date(0)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).source).toBe("weworkremotely");
  });

  it("throws SourceError (never []) when a feed keeps returning 500", async () => {
    let calls = 0;
    server.use(
      http.get(FRONT_END, () => xml(feeds.frontEnd)),
      http.get(FULL_STACK, () => {
        calls++;
        return new HttpResponse(null, { status: 500 });
      }),
      http.get(PROGRAMMING, () => xml(feeds.programming)),
    );
    const err = await adapter.fetch(new Date(0)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).source).toBe("weworkremotely");
    expect(calls).toBe(3);
  });

  it("skips one invalid item with a warning", async () => {
    const bad = item({ title: "", guid: "https://weworkremotely.com/remote-jobs/bad", link: "x" });
    server.use(
      http.get(FRONT_END, () => xml(rss(""))),
      http.get(FULL_STACK, () => xml(rss(good(1) + bad + good(2)))),
      http.get(PROGRAMMING, () => xml(rss(""))),
    );
    const postings = await adapter.fetch(new Date(0));
    expect(postings).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "weworkremotely: skipping invalid item",
      expect.objectContaining({
        source: "weworkremotely",
        externalId: "https://weworkremotely.com/remote-jobs/bad",
        path: "title",
      }),
    );
  });

  it("skips an item with an unparseable date", async () => {
    serveAll(rss(good(1) + good(2, { pubDate: "not a date" })));
    const postings = await adapter.fetch(new Date(0));
    expect(postings).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });

  it("throws SourceError when more than 50% of items are invalid", async () => {
    const bad = (n: number) => item({ title: "", guid: `bad-${n}`, link: "x" });
    serveAll(rss(good(1) + bad(1) + bad(2)));
    const err = await adapter.fetch(new Date(0)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).source).toBe("weworkremotely");
  });

  it("accepts exactly 50% invalid items", async () => {
    const bad = item({ title: "", guid: "bad", link: "x" });
    serveAll(rss(good(1) + bad));
    await expect(adapter.fetch(new Date(0))).resolves.toHaveLength(1);
  });
});
