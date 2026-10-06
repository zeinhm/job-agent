import { SourceError, log, __testInjectTimeAndSleep } from "@job-agent/core";
import { readFileSync } from "node:fs";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FEED_URLS, createWeWorkRemotelyAdapter } from "./index.ts";

const read = (name: string) =>
  readFileSync(new URL(`../../test/fixtures/weworkremotely/${name}.rss`, import.meta.url), "utf-8");
const frontEnd = read("front-end");
const fullStack = read("full-stack");
const programming = read("programming");

const [FRONT_END_URL, FULL_STACK_URL, PROGRAMMING_URL] = FEED_URLS;
const xml = (body: string) =>
  new HttpResponse(body, { headers: { "Content-Type": "application/rss+xml" } });

const server = setupServer();

function serveFixtures(overrides: Partial<Record<string, string>> = {}) {
  server.use(
    http.get(FRONT_END_URL, () => xml(overrides[FRONT_END_URL] ?? frontEnd)),
    http.get(FULL_STACK_URL, () => xml(overrides[FULL_STACK_URL] ?? fullStack)),
    http.get(PROGRAMMING_URL, () => xml(overrides[PROGRAMMING_URL] ?? programming)),
  );
}

const feedWith = (items: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>t</title>${items}</channel></rss>`;
const item = (title: string, guid: string, extra = "") =>
  `<item><title>${title}</title><guid>${guid}</guid><link>${guid}</link>${extra}</item>`;
const goodItem = (n: number) =>
  item(`Co${n}: Job ${n}`, `https://weworkremotely.com/remote-jobs/j${n}`);
const badItem = (n: number) => `<item><guid>bad-${n}</guid></item>`;

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

describe("weworkremotely adapter", () => {
  it("has the expected name and interval", () => {
    const adapter = createWeWorkRemotelyAdapter();
    expect(adapter.name).toBe("weworkremotely");
    expect(adapter.minIntervalMinutes).toBe(60);
  });

  it("returns one RawPosting per unique item across feeds", async () => {
    serveFixtures();
    const postings = await createWeWorkRemotelyAdapter().fetch(new Date(0));
    expect(postings).toHaveLength(10);
    expect(new Set(postings.map((p) => p.externalId)).size).toBe(10);
    expect(postings.every((p) => p.source === "weworkremotely")).toBe(true);
  });

  it("maps an item fully", async () => {
    serveFixtures();
    const postings = await createWeWorkRemotelyAdapter().fetch(new Date(0));
    expect(postings[0]).toEqual({
      source: "weworkremotely",
      externalId: "https://weworkremotely.com/remote-jobs/acme-labs-senior-react-developer",
      url: "https://weworkremotely.com/remote-jobs/acme-labs-senior-react-developer",
      title: "Senior React Developer",
      company: "Acme Labs",
      descriptionHtml:
        "<p>Join <strong>Acme</strong> &amp; build things. Apply: jobs@example.com</p>",
      locationText: "Anywhere in the World",
      postedAt: "2026-10-06T13:25:57.000Z",
      tags: ["Front-End Programming", "Full-Time", "React", "TypeScript", "CSS"],
    });
  });

  it("uses company 'unknown' and keeps the full title when there is no colon", async () => {
    serveFixtures();
    const postings = await createWeWorkRemotelyAdapter().fetch(new Date(0));
    const p = postings.find((x) => x.title === "Wayne Enterprises Staff Engineer");
    expect(p?.company).toBe("unknown");
  });

  it("splits on the first colon only", async () => {
    serveFixtures();
    const postings = await createWeWorkRemotelyAdapter().fetch(new Date(0));
    const p = postings.find((x) => x.company === "Soylent");
    expect(p?.title).toBe("Backend Developer: Payments");
  });

  it("returns an item present in two feeds once", async () => {
    serveFixtures();
    const postings = await createWeWorkRemotelyAdapter().fetch(new Date(0));
    expect(postings.filter((p) => p.company === "Acme Labs")).toHaveLength(1);
    expect(postings.filter((p) => p.company === "Globex")).toHaveLength(1);
  });

  it("falls back to link when there is no guid", async () => {
    serveFixtures({
      [FRONT_END_URL]: feedWith(
        "<item><title>A: B</title><link>https://weworkremotely.com/remote-jobs/x</link></item>",
      ),
    });
    const postings = await createWeWorkRemotelyAdapter().fetch(new Date(0));
    expect(postings.find((p) => p.title === "B")?.externalId).toBe(
      "https://weworkremotely.com/remote-jobs/x",
    );
  });

  it("excludes items dated before since and keeps undated items", async () => {
    serveFixtures({ [PROGRAMMING_URL]: feedWith(goodItem(1)) });
    const since = new Date("2026-10-05T00:00:00Z");
    const postings = await createWeWorkRemotelyAdapter().fetch(since);
    const expected = ["Acme Labs", "Globex", "Umbrella Corp"].sort();
    expect(
      postings
        .filter((p) => p.postedAt)
        .map((p) => p.company)
        .sort(),
    ).toEqual(expected);
    expect(postings.every((p) => !p.postedAt || new Date(p.postedAt) >= since)).toBe(true);
    expect(postings.find((p) => p.company === "Co1")).not.toHaveProperty("postedAt");
  });

  it("rejects with SourceError on malformed XML", async () => {
    serveFixtures({ [FRONT_END_URL]: "<rss><channel><item><title>x</channel>" });
    const err = await createWeWorkRemotelyAdapter()
      .fetch(new Date(0))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).source).toBe("weworkremotely");
  });

  it("rejects with SourceError on a non-RSS document", async () => {
    serveFixtures({ [FRONT_END_URL]: "<html><body>blocked</body></html>" });
    await expect(createWeWorkRemotelyAdapter().fetch(new Date(0))).rejects.toBeInstanceOf(
      SourceError,
    );
  });

  it("rejects with SourceError on 500 after retries", async () => {
    let calls = 0;
    server.use(
      http.get(FRONT_END_URL, () => {
        calls++;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    const err = await createWeWorkRemotelyAdapter()
      .fetch(new Date(0))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).source).toBe("weworkremotely");
    expect(calls).toBe(3);
  });

  it("rejects with SourceError when a later feed fails", async () => {
    server.use(
      http.get(FRONT_END_URL, () => xml(frontEnd)),
      http.get(FULL_STACK_URL, () => new HttpResponse(null, { status: 500 })),
    );
    await expect(createWeWorkRemotelyAdapter().fetch(new Date(0))).rejects.toBeInstanceOf(
      SourceError,
    );
  });

  it("skips one invalid item with a warn", async () => {
    serveFixtures({ [FRONT_END_URL]: feedWith(goodItem(1) + goodItem(2) + badItem(1)) });
    const postings = await createWeWorkRemotelyAdapter().fetch(new Date(0));
    expect(postings.map((p) => p.company)).toContain("Co1");
    expect(postings.map((p) => p.externalId)).not.toContain("bad-1");
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ externalId: "bad-1", path: "title" }),
    );
  });

  it("treats an unparseable pubDate as an invalid item", async () => {
    serveFixtures({
      [FRONT_END_URL]: feedWith(
        goodItem(1) + goodItem(2) + item("X: Y", "https://x/y", "<pubDate>not a date</pubDate>"),
      ),
    });
    const postings = await createWeWorkRemotelyAdapter().fetch(new Date(0));
    expect(postings.map((p) => p.title)).not.toContain("Y");
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ path: "pubDate" }),
    );
  });

  it("rejects with SourceError when more than 50% of items are invalid", async () => {
    serveFixtures({ [FRONT_END_URL]: feedWith(goodItem(1) + badItem(1) + badItem(2)) });
    await expect(createWeWorkRemotelyAdapter().fetch(new Date(0))).rejects.toBeInstanceOf(
      SourceError,
    );
  });

  it("accepts exactly 50% invalid items", async () => {
    serveFixtures({
      [FRONT_END_URL]: feedWith(goodItem(1) + badItem(1)),
      [FULL_STACK_URL]: feedWith(""),
      [PROGRAMMING_URL]: feedWith(""),
    });
    await expect(createWeWorkRemotelyAdapter().fetch(new Date(0))).resolves.toHaveLength(1);
  });

  it("returns [] when every feed is valid and empty", async () => {
    const empty = feedWith("");
    serveFixtures({
      [FRONT_END_URL]: empty,
      [FULL_STACK_URL]: empty,
      [PROGRAMMING_URL]: empty,
    });
    await expect(createWeWorkRemotelyAdapter().fetch(new Date(0))).resolves.toEqual([]);
  });

  it("decodes CDATA descriptions and large entity-heavy descriptions", async () => {
    const big = "&lt;p&gt;x&lt;/p&gt;".repeat(5000);
    serveFixtures({
      [FRONT_END_URL]: feedWith(
        item("A: B", "https://x/1", `<description>${big}</description>`) +
          item("C: D", "https://x/2", "<description><![CDATA[<p>hi</p>]]></description>"),
      ),
      [FULL_STACK_URL]: feedWith(""),
      [PROGRAMMING_URL]: feedWith(""),
    });
    const postings = await createWeWorkRemotelyAdapter().fetch(new Date(0));
    expect(postings[0]?.descriptionHtml).toBe("<p>x</p>".repeat(5000));
    expect(postings[1]?.descriptionHtml).toBe("<p>hi</p>");
  });
});
