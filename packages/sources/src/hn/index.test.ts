import { SourceError, log, __testInjectTimeAndSleep } from "@job-agent/core";
import { readFileSync } from "node:fs";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHnAdapter } from "./index.ts";
import { buildAdapters } from "../registry.ts";
import { makeConfig } from "../test-utils.ts";

type Comment = {
  id: number;
  created_at: string;
  author: string | null;
  text: string | null;
  type: string;
  children: Comment[];
};
type Thread = { id: number; children: Comment[] };

const read = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../test/fixtures/hn/${name}`, import.meta.url), "utf-8"),
  ) as unknown;

const searchFixture = read("search.json");
const threadFixture = read("items.json") as Thread;

const API = "https://hn.algolia.com/api/v1";
const THREAD_ID = 49922569;
const server = setupServer();

const adapter = () => {
  const found = buildAdapters(makeConfig()).find((a) => a.name === "hn");
  if (!found) throw new Error("no hn adapter");
  return found;
};

function serve(thread: unknown = threadFixture, search: unknown = searchFixture) {
  server.use(
    http.get(`${API}/search_by_date`, () => HttpResponse.json(search as Record<string, unknown>)),
    http.get(`${API}/items/${THREAD_ID}`, () =>
      HttpResponse.json(thread as Record<string, unknown>),
    ),
  );
}

const comment = (id: number, text: string | null, over: Partial<Comment> = {}): Comment => ({
  id,
  created_at: "2026-10-02T10:00:00.000Z",
  author: "hnuser",
  text,
  type: "comment",
  children: [],
  ...over,
});

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

describe("hn adapter", () => {
  it("is named hn with a 360 minute interval", () => {
    expect(createHnAdapter()).toMatchObject({ name: "hn", minIntervalMinutes: 360 });
  });

  it("returns one RawPosting per top-level comment; replies produce none", async () => {
    serve();
    const postings = await adapter().fetch(new Date(0));
    expect(threadFixture.children).toHaveLength(20);
    expect(threadFixture.children.some((c) => c.children.length > 0)).toBe(true);
    expect(postings.map((p) => p.externalId)).toEqual(
      threadFixture.children.map((c) => String(c.id)),
    );
    expect(postings.every((p) => p.source === "hn")).toBe(true);
  });

  it("maps a comment fully", async () => {
    serve();
    const postings = await adapter().fetch(new Date(0));
    const raw = threadFixture.children.find((c) => c.id === 49922609);
    expect(postings.find((p) => p.externalId === "49922609")).toMatchObject({
      source: "hn",
      externalId: "49922609",
      url: "https://news.ycombinator.com/item?id=49922609",
      company: "Sidekick Labs",
      title: "Senior SWE, R&D Engineer, Intelligence Engineer",
      locationText: "REMOTE (US Timezones)",
      descriptionHtml: raw?.text,
      postedAt: new Date(raw?.created_at ?? "").toISOString(),
    });
  });

  it("falls back to unknown company for a comment without pipes", async () => {
    serve();
    const postings = await adapter().fetch(new Date(0));
    const posting = postings.find((p) => p.externalId === "49922584");
    expect(posting?.company).toBe("unknown");
    expect(posting?.title).toContain("PrairieLearn");
    expect(posting).not.toHaveProperty("locationText");
  });

  it("skips deleted and dead comments", async () => {
    serve({
      id: THREAD_ID,
      children: [
        comment(1, "Acme | Backend Engineer | REMOTE"),
        comment(2, null, { author: null }),
        comment(3, "dead text", { author: null }),
        comment(4, ""),
      ],
    });
    const postings = await adapter().fetch(new Date(0));
    expect(postings.map((p) => p.externalId)).toEqual(["1"]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("excludes comments before since", async () => {
    serve({
      id: THREAD_ID,
      children: [
        comment(1, "Old | Engineer | REMOTE", { created_at: "2026-10-01T16:00:00.000Z" }),
        comment(2, "New | Engineer | REMOTE", { created_at: "2026-10-05T16:00:00.000Z" }),
      ],
    });
    const postings = await adapter().fetch(new Date("2026-10-03T00:00:00Z"));
    expect(postings.map((p) => p.externalId)).toEqual(["2"]);
  });

  it("picks the Who is hiring thread, not Who wants to be hired", async () => {
    let requested = "";
    server.use(
      http.get(`${API}/search_by_date`, () => HttpResponse.json(searchFixture as never)),
      http.get(`${API}/items/:id`, ({ params }) => {
        requested = String(params.id);
        return HttpResponse.json(threadFixture as never);
      }),
    );
    await adapter().fetch(new Date(0));
    expect(requested).toBe(String(THREAD_ID));
  });

  it("rejects with SourceError when the search finds no thread", async () => {
    serve(threadFixture, { hits: [] });
    const err = await adapter()
      .fetch(new Date(0))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).source).toBe("hn");
  });

  it("rejects with SourceError when only other threads match", async () => {
    serve(threadFixture, {
      hits: [{ objectID: "1", title: "Ask HN: Who wants to be hired? (October 2026)" }],
    });
    await expect(adapter().fetch(new Date(0))).rejects.toBeInstanceOf(SourceError);
  });

  it("rejects with SourceError on an invalid search envelope", async () => {
    serve(threadFixture, { nope: true });
    await expect(adapter().fetch(new Date(0))).rejects.toBeInstanceOf(SourceError);
  });

  it("rejects with SourceError on an invalid thread envelope", async () => {
    serve({ id: THREAD_ID });
    await expect(adapter().fetch(new Date(0))).rejects.toBeInstanceOf(SourceError);
  });

  it("rejects with SourceError on 500 after retries", async () => {
    let calls = 0;
    server.use(
      http.get(`${API}/search_by_date`, () => {
        calls++;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    const err = await adapter()
      .fetch(new Date(0))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).source).toBe("hn");
    expect(calls).toBe(3);
  });

  it("rejects with SourceError when the thread request returns 500", async () => {
    server.use(
      http.get(`${API}/search_by_date`, () => HttpResponse.json(searchFixture as never)),
      http.get(`${API}/items/${THREAD_ID}`, () => new HttpResponse(null, { status: 500 })),
    );
    await expect(adapter().fetch(new Date(0))).rejects.toBeInstanceOf(SourceError);
  });

  it("skips one invalid comment with a warn", async () => {
    serve({
      id: THREAD_ID,
      children: [
        comment(1, "Acme | Backend Engineer | REMOTE"),
        comment(2, "Beta | Frontend Engineer | REMOTE"),
        { id: 3, text: "Bad | Engineer | REMOTE", author: "hnuser" },
      ],
    });
    const postings = await adapter().fetch(new Date(0));
    expect(postings.map((p) => p.externalId)).toEqual(["1", "2"]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ source: "hn", externalId: "3", path: "created_at" }),
    );
  });

  it("rejects with SourceError when more than 50% of comments are invalid", async () => {
    const bad = (id: number) => ({ id, text: "x | y", author: "hnuser" });
    serve({ id: THREAD_ID, children: [comment(1, "Acme | Engineer | REMOTE"), bad(2), bad(3)] });
    await expect(adapter().fetch(new Date(0))).rejects.toBeInstanceOf(SourceError);
  });

  it("accepts exactly 50% invalid comments", async () => {
    serve({
      id: THREAD_ID,
      children: [
        comment(1, "Acme | Engineer | REMOTE"),
        { id: 2, text: "x | y", author: "hnuser" },
      ],
    });
    await expect(adapter().fetch(new Date(0))).resolves.toHaveLength(1);
  });

  it("returns [] for a thread with no comments", async () => {
    serve({ id: THREAD_ID, children: [] });
    await expect(adapter().fetch(new Date(0))).resolves.toEqual([]);
  });
});
