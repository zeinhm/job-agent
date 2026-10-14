import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __testInjectTimeAndSleep } from "@job-agent/core";
import {
  BRAVE_DAILY_REQUEST_CAP,
  BraveCapReachedError,
  reserveBraveRequest,
  searchResults,
} from "./search.ts";

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
let requests = 0;
const server = setupServer(
  http.get(ENDPOINT, () => {
    requests++;
    return HttpResponse.json({ web: { results: [{ url: "https://jobs.example.test/1" }] } });
  }),
);
let dir: string;
let counter: string;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brave-usage-"));
  counter = join(dir, "brave-usage.json");
  vi.stubEnv("JOB_AGENT_BRAVE_USAGE", counter);
  __testInjectTimeAndSleep(
    () => new Date(),
    async () => {},
  );
  requests = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const today = () => new Date().toISOString().slice(0, 10);

describe("Brave daily counter", () => {
  it.each([
    ["not JSON", "{{ nope"],
    ["empty file", ""],
    ["wrong shape (object)", JSON.stringify({ foo: 1 })],
    ["wrong shape (null)", "null"],
    ["wrong shape (array)", "[]"],
    ["count is a string", JSON.stringify({ day: today(), count: "3" })],
    ["negative count", JSON.stringify({ day: today(), count: -5 })],
  ])("a corrupt counter (%s) counts as spent: throws, sends no request", async (_n, content) => {
    writeFileSync(counter, content);
    await expect(searchResults("q", "key")).rejects.toBeInstanceOf(BraveCapReachedError);
    expect(requests).toBe(0);
    expect(readFileSync(counter, "utf-8")).toBe(content);
  });

  it("a missing file counts as 0 used: the request goes out and the counter is created", async () => {
    expect(existsSync(counter)).toBe(false);
    const results = await searchResults("q", "key");
    expect(results).toEqual([{ url: "https://jobs.example.test/1" }]);
    expect(requests).toBe(1);
    expect(JSON.parse(readFileSync(counter, "utf-8"))).toEqual({ day: today(), count: 1 });
  });

  it("a counter from an earlier UTC day resets to 0", async () => {
    writeFileSync(counter, JSON.stringify({ day: "2020-01-01", count: BRAVE_DAILY_REQUEST_CAP }));
    await searchResults("q", "key");
    expect(requests).toBe(1);
    expect(JSON.parse(readFileSync(counter, "utf-8"))).toEqual({ day: today(), count: 1 });
  });

  it("today's counter at the cap throws; one below the cap is allowed", () => {
    const day = "2026-10-07";
    const now = new Date(`${day}T12:00:00Z`);
    writeFileSync(counter, JSON.stringify({ day, count: BRAVE_DAILY_REQUEST_CAP - 1 }));
    expect(() => reserveBraveRequest(now)).not.toThrow();
    expect(() => reserveBraveRequest(now)).toThrow(BraveCapReachedError);
  });
});
