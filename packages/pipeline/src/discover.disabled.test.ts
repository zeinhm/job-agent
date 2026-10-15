import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  __testInjectTimeAndSleep,
  disabledSources,
  openDb,
  source_runs,
  type AppConfig,
  type Db,
} from "@job-agent/core";
import { buildAdapters } from "@job-agent/sources";
import { runDigest } from "./digest/index.ts";
import { runDiscover } from "./discover.ts";

const BRAVE = "https://api.search.brave.com/res/v1/web/search";
const server = setupServer();
let braveCalls = 0;
let db: Db;

const config = (sources?: AppConfig["sources"]): AppConfig => ({
  salary: {} as AppConfig["salary"],
  companies: [],
  sources,
});

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  braveCalls = 0;
  let now = 0;
  __testInjectTimeAndSleep(
    () => new Date(now),
    async (ms) => {
      now += ms;
    },
  );
  process.env["BRAVE_API_KEY"] = "test-key";
  server.use(
    http.get(BRAVE, () => {
      braveCalls++;
      return HttpResponse.json({ web: { results: [] } });
    }),
  );
  db = openDb(":memory:");
});
afterEach(() => {
  server.resetHandlers();
  delete process.env["BRAVE_API_KEY"];
  db.$client.close();
});

describe("linkedin_posts disabled by default", () => {
  it("a forced run of linkedin_posts with the default config makes zero Brave requests", async () => {
    const cfg = config();
    const out: string[] = [];
    const code = await runDiscover({
      db,
      adapters: buildAdapters(cfg),
      disabled: disabledSources(cfg),
      source: "linkedin_posts",
      force: true,
      out: (t) => out.push(t),
      err: (t) => out.push(t),
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("linkedin_posts: disabled");
    expect(braveCalls).toBe(0);
    expect(db.select().from(source_runs).all()).toEqual([]);
  });

  it("makes Brave requests once sources.linkedin_posts is true", async () => {
    const cfg = config({ linkedin_posts: true });
    expect(disabledSources(cfg)).toEqual([]);
    const code = await runDiscover({
      db,
      adapters: buildAdapters(cfg),
      disabled: disabledSources(cfg),
      source: "linkedin_posts",
      force: true,
      out: () => {},
      err: () => {},
    });
    expect(code).toBe(0);
    expect(braveCalls).toBeGreaterThan(0);
  });

  it("Source health shows it as disabled, never skipped, error or LATE", () => {
    const out = mkdtempSync(join(tmpdir(), "digest-disabled-"));
    // An old run from before it was switched off must not turn into a LATE / NO SUCCESSFUL RUN line.
    db.insert(source_runs)
      .values({
        id: "r1",
        source: "linkedin_posts",
        started_at: "2026-10-01T00:00:00.000Z",
        finished_at: "2026-10-01T00:00:01.000Z",
        status: "ok",
        found: 0,
        new: 0,
        error_message: null,
        saturated: null,
      })
      .run();
    const path = runDigest({
      db,
      outDir: out,
      now: () => new Date("2026-10-15T03:00:00.000Z"),
      disabledSources: disabledSources(config()),
      out: () => {},
    });
    const text = readFileSync(path, "utf8");
    const health = text.slice(text.indexOf("## Source health"));
    expect(health).toContain("- **linkedin_posts**: disabled");
    expect(health).not.toContain("LATE");
    expect(health).not.toContain("NO SUCCESSFUL RUN");
  });
});
