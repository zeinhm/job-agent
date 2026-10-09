import { SourceError, log, __testInjectTimeAndSleep } from "@job-agent/core";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { setupServer } from "msw/node";
import { http, HttpResponse, type JsonBodyType } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWeb3CareerAdapter } from "./index.ts";

const fixtureText = readFileSync(
  new URL("../../test/fixtures/web3career-live-2026-10-08.json", import.meta.url),
  "utf-8",
);
const envelope = JSON.parse(fixtureText) as [string, string, Record<string, unknown>[]];
const jobs = envelope[2];

const API = "https://web3.career/api/v1";
const TOKEN = "tok-SECRET-1234567890";
const server = setupServer();
const adapter = createWeb3CareerAdapter();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  vi.stubEnv("WEB3_CAREER_TOKEN", TOKEN);
  let now = 0;
  __testInjectTimeAndSleep(
    () => new Date(now),
    async (ms) => {
      now += ms;
    },
  );
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
});

const serve = (body: JsonBodyType) => server.use(http.get(API, () => HttpResponse.json(body)));
const wrap = (list: unknown[]) => ["title", "notes", list];

describe("web3career adapter", () => {
  it("returns one RawPosting per fixture job", async () => {
    serve(envelope);
    const postings = await adapter.fetch(new Date(0));
    expect(postings).toHaveLength(jobs.length);
    expect(postings.every((p) => p.source === "web3career")).toBe(true);
    expect(adapter.name).toBe("web3career");
  });

  it("sends the remote-only query with the token", async () => {
    let seen: URL | undefined;
    server.use(
      http.get(API, ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json(envelope);
      }),
    );
    await adapter.fetch(new Date(0));
    expect(seen?.searchParams.get("token")).toBe(TOKEN);
    expect(seen?.searchParams.get("remote")).toBe("true");
    expect(seen?.searchParams.get("limit")).toBe("100");
  });

  it("keeps apply_url unmodified as both url and applyUrl", async () => {
    serve(envelope);
    const postings = await adapter.fetch(new Date(0));
    expect(postings.map((p) => p.applyUrl)).toEqual(jobs.map((j) => j["apply_url"]));
    expect(postings.map((p) => p.url)).toEqual(jobs.map((j) => j["apply_url"]));
  });

  it("maps a job with a posted string salary", async () => {
    serve(envelope);
    const posting = (await adapter.fetch(new Date(0))).find((p) => p.externalId === "155044");
    expect(posting).toMatchObject({
      source: "web3career",
      externalId: "155044",
      title: "Machine Learning Engineer ($400k - $600k salary)",
      company: "Baton Corporation",
      salary: { min: 400000, max: 600000, currency: "USD", period: "year" },
    });
    expect(posting?.postedAt).toBe(new Date(1791361925 * 1000).toISOString());
  });

  it("ignores estimated salaries", async () => {
    serve(envelope);
    const posting = (await adapter.fetch(new Date(0))).find((p) => p.externalId === "155045");
    expect(jobs.find((j) => j["id"] === 155045)?.["estimated_min_salary"]).toBeTruthy();
    expect(posting).not.toHaveProperty("salary");
    expect(posting).not.toHaveProperty("salaryText");
  });

  it("decodes HTML entities in titles and company names", async () => {
    serve(envelope);
    const posting = (await adapter.fetch(new Date(0))).find((p) => p.externalId === "155026");
    expect(posting?.title).toBe("Enterprise Blockchain Architect (Digital Assets & Tokenization)");
  });

  it("strips the web3.career apply instruction from every description", async () => {
    serve(envelope);
    const postings = await adapter.fetch(new Date(0));
    expect(jobs.every((j) => String(j["description"]).includes("CANDYSHOP"))).toBe(true);
    for (const p of postings) {
      expect(p.descriptionHtml).toBeTruthy();
      expect(p.descriptionHtml).not.toContain("CANDYSHOP");
      expect(p.descriptionHtml).not.toContain("When applying");
    }
  });

  it("trusts only a positive is_remote flag", async () => {
    serve(envelope);
    const byId = new Map((await adapter.fetch(new Date(0))).map((p) => [p.externalId, p]));
    expect(byId.get("155034")?.remote).toBe(true);
    expect(byId.get("155045")).not.toHaveProperty("remote");
  });

  it("maps month and hour units case-insensitively and drops unknown units", async () => {
    const base = { ...jobs[0], salary_min_value: "30.0", salary_max_value: "45.0" };
    serve(
      wrap([
        { ...base, id: 1, salary_unit: "HOUR" },
        { ...base, id: 2, salary_unit: "MONTH" },
        { ...base, id: 3, salary_unit: "WEEK" },
      ]),
    );
    const byId = new Map((await adapter.fetch(new Date(0))).map((p) => [p.externalId, p]));
    expect(byId.get("1")?.salary).toEqual({ min: 30, max: 45, currency: "USD", period: "hour" });
    expect(byId.get("2")?.salary?.period).toBe("month");
    expect(byId.get("3")).not.toHaveProperty("salary");
  });

  it("excludes jobs posted before since", async () => {
    serve(envelope);
    const cutoff = new Date(1791361848 * 1000);
    const ids = (await adapter.fetch(cutoff)).map((p) => p.externalId).sort();
    expect(ids).toEqual(["155034", "155043", "155044", "155045"]);
  });

  it("throws SourceError naming the variable when the token is missing", async () => {
    vi.stubEnv("WEB3_CAREER_TOKEN", "");
    const err = await adapter.fetch(new Date(0)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).message).toContain("WEB3_CAREER_TOKEN not set");
  });

  it("never exposes the token in errors or logs when the request fails", async () => {
    const lines: string[] = [];
    vi.mocked(log.warn).mockImplementation((msg, fields) => {
      lines.push(JSON.stringify({ msg, fields }));
    });
    server.use(http.get(API, () => new HttpResponse(null, { status: 500 })));
    const err = await adapter.fetch(new Date(0)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(inspect(err, { depth: 10, showHidden: true })).not.toContain(TOKEN);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("treats 302 as a rejected token without following it", async () => {
    let calls = 0;
    let followed = false;
    server.use(
      http.get(API, () => {
        calls++;
        return new HttpResponse(null, {
          status: 302,
          headers: { location: "https://web3.career/login?token=" + TOKEN },
        });
      }),
      http.get("https://web3.career/login", () => {
        followed = true;
        return HttpResponse.json(envelope);
      }),
    );
    const lines: string[] = [];
    vi.mocked(log.warn).mockImplementation((msg, fields) => {
      lines.push(JSON.stringify({ msg, fields }));
    });
    const err = await adapter.fetch(new Date(0)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).message).toContain("token rejected (HTTP 302)");
    expect(inspect(err, { depth: 10, showHidden: true })).not.toContain(TOKEN);
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(followed).toBe(false);
    expect(calls).toBe(1);
  });

  it.each([401, 403])("treats %i as a rejected token", async (status) => {
    server.use(http.get(API, () => new HttpResponse(null, { status })));
    const err = await adapter.fetch(new Date(0)).catch((e: unknown) => e);
    expect((err as SourceError).message).toContain(`token rejected (HTTP ${status})`);
    expect(inspect(err, { depth: 10, showHidden: true })).not.toContain(TOKEN);
  });

  it("parses salary strings and keeps null salary null", async () => {
    serve(envelope);
    const byId = new Map((await adapter.fetch(new Date(0))).map((p) => [p.externalId, p]));
    expect(byId.get("155044")?.salary).toEqual({
      min: 400000,
      max: 600000,
      currency: "USD",
      period: "year",
    });
    for (const id of ["155045", "155043", "155034", "155026"]) {
      expect(byId.get(id)).not.toHaveProperty("salary");
    }
  });

  it("strips the apply instruction whatever the code word or case", async () => {
    const variants = [
      "<p>x</p>\n When applying, mention the word BANANA to show you read the job post completely.",
      "<p>x</p> WHEN APPLYING, MENTION THE WORD pear TO SHOW YOU READ THE JOB POST COMPLETELY.",
    ];
    serve(wrap(variants.map((description, i) => ({ ...jobs[0], id: 900 + i, description }))));
    for (const p of await adapter.fetch(new Date(0))) {
      expect(p.descriptionHtml?.toLowerCase()).not.toContain("mention the word");
      expect(p.descriptionHtml).toBe("<p>x</p>");
    }
  });

  it("no description from the fixture contains the instruction", async () => {
    serve(envelope);
    for (const p of await adapter.fetch(new Date(0))) {
      expect(p.descriptionHtml?.toLowerCase()).not.toContain("mention the word");
    }
  });

  it("takes the location from location, never from country", async () => {
    serve(envelope);
    const byId = new Map((await adapter.fetch(new Date(0))).map((p) => [p.externalId, p]));
    // Fixture row 155026: country "united-states" but location names New Jersey.
    expect(jobs.find((j) => j["id"] === 155026)?.["country"]).toBe("united-states");
    expect(byId.get("155026")?.locationText).toBe("United States New Jersey US");
    expect(byId.get("155045")?.locationText).toBe("Hong Kong");
  });

  it("parses the fixture into 5 valid postings with none rejected", async () => {
    serve(envelope);
    const postings = await adapter.fetch(new Date(0));
    expect(postings).toHaveLength(5);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("rejects with SourceError on 500 after retries", async () => {
    let calls = 0;
    server.use(
      http.get(API, () => {
        calls++;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    const err = await adapter.fetch(new Date(0)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).source).toBe("web3career");
    expect(calls).toBe(3);
  });

  it("rejects with SourceError on an invalid envelope", async () => {
    serve({ jobs: [] });
    await expect(adapter.fetch(new Date(0))).rejects.toBeInstanceOf(SourceError);
    serve(["only", "strings"]);
    await expect(adapter.fetch(new Date(0))).rejects.toBeInstanceOf(SourceError);
    serve([[jobs[0]], "strings", "x"]);
    await expect(adapter.fetch(new Date(0))).rejects.toBeInstanceOf(SourceError);
  });

  it("skips one invalid job with a warn", async () => {
    const bad = { ...jobs[0], id: "bad-1", apply_url: undefined };
    serve(wrap([...jobs, bad]));
    const postings = await adapter.fetch(new Date(0));
    expect(postings).toHaveLength(jobs.length);
    expect(postings.map((p) => p.externalId)).not.toContain("bad-1");
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ source: "web3career", externalId: "bad-1", path: "apply_url" }),
    );
  });

  it("rejects with SourceError when more than 50% of jobs are invalid", async () => {
    const bad = (id: string) => ({ id, title: "t" });
    serve(wrap([jobs[0], bad("b1"), bad("b2")]));
    await expect(adapter.fetch(new Date(0))).rejects.toBeInstanceOf(SourceError);
  });

  it("accepts exactly 50% invalid jobs", async () => {
    serve(wrap([jobs[0], { id: "b1", title: "t" }]));
    await expect(adapter.fetch(new Date(0))).resolves.toHaveLength(1);
  });

  it("returns [] for a valid empty response", async () => {
    serve(wrap([]));
    await expect(adapter.fetch(new Date(0))).resolves.toEqual([]);
  });
});
