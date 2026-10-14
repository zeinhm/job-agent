import { eq } from "drizzle-orm";
import { analysis, companies, openDb, postings, source_runs, type Db } from "@job-agent/core";
import { createIndeedAdapter } from "@job-agent/sources";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BLOCK_BACKOFF_HOURS, runDiscover } from "./discover.ts";
import { normalizeCompanyName } from "./normalize/index.ts";
import { runProcess } from "./process.ts";

const T0 = new Date("2026-10-14T10:00:00.000Z");
const minutes = (n: number) => n * 60_000;

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});
afterEach(() => db.$client.close());

const job = (key: string, extra: Record<string, unknown> = {}) => ({
  id: `in-${key}`,
  site: "indeed",
  job_url: `https://www.indeed.com/viewjob?jk=${key}`,
  job_url_direct: null,
  title: "Senior Frontend Engineer",
  company: "Example Co",
  location: "Remote",
  date_posted: "2026-10-14T00:00:00.000",
  is_remote: true,
  description: "Build a React app.",
  ...extra,
});

function discover(
  adapter: ReturnType<typeof createIndeedAdapter>,
  at: Date,
  force = false,
): Promise<number> {
  return runDiscover({
    db,
    adapters: [adapter],
    source: "indeed",
    force,
    now: () => at,
    out: () => undefined,
    err: () => undefined,
  });
}
const runs = () => db.select().from(source_runs).where(eq(source_runs.source, "indeed")).all();

describe("indeed through discover", () => {
  it("a block is an error run, then 6 h of skipped runs even with --force", async () => {
    let calls = 0;
    const adapter = createIndeedAdapter({
      sleep: async () => undefined,
      now: () => T0,
      runWorker: async () => {
        calls++;
        return { exitCode: 2, stdout: '{"error":"status code 403","kind":"blocked"}' };
      },
    });
    expect(await discover(adapter, T0)).toBe(1);
    expect(runs()[0]).toMatchObject({
      status: "error",
      error_message: "blocked: [indeed] status code 403",
    });
    expect(BLOCK_BACKOFF_HOURS).toBe(6);
    expect(await discover(adapter, new Date(T0.getTime() + minutes(300)), true)).toBe(0);
    expect(runs().at(-1)).toMatchObject({
      status: "skipped",
      error_message: "backoff after block until 2026-10-14T16:00:00.000Z",
    });
    expect(calls).toBe(1);
  });

  it("stores saturated for a paged source (ok and blocked-with-postings), null for others", async () => {
    const full = Array.from({ length: 50 }, (_, i) => JSON.stringify(job(`k${i}`))).join("\n");
    let call = 0;
    const adapter = createIndeedAdapter({
      sleep: async () => undefined,
      now: () => T0,
      runWorker: async () =>
        ++call === 1 ? { exitCode: 0, stdout: full } : { exitCode: 0, stdout: "" },
    });
    expect(await discover(adapter, T0)).toBe(0);
    expect(runs()[0]).toMatchObject({ status: "ok", saturated: 1 });

    let n = 0;
    const blocking = createIndeedAdapter({
      sleep: async () => undefined,
      now: () => T0,
      runWorker: async () =>
        ++n === 1
          ? { exitCode: 0, stdout: full }
          : { exitCode: 2, stdout: '{"error":"status code 403","kind":"blocked"}' },
    });
    await discover(blocking, new Date(T0.getTime() + minutes(300)), true);
    expect(runs().at(-1)).toMatchObject({ status: "error", saturated: 1 });

    const other = { name: "other", minIntervalMinutes: 0, fetch: async () => [] };
    await runDiscover({
      db,
      adapters: [other],
      source: "other",
      force: true,
      now: () => T0,
      out: () => undefined,
      err: () => undefined,
    });
    expect(
      db.select().from(source_runs).where(eq(source_runs.source, "other")).all()[0]?.saturated,
    ).toBeNull();
  });

  it("a second run within 2 h records skipped without calling the worker", async () => {
    let calls = 0;
    const adapter = createIndeedAdapter({
      sleep: async () => undefined,
      now: () => T0,
      runWorker: async () => {
        calls++;
        return { exitCode: 0, stdout: "" };
      },
    });
    expect(await discover(adapter, T0)).toBe(0);
    expect(calls).toBe(2);
    expect(await discover(adapter, new Date(T0.getTime() + minutes(119)))).toBe(0);
    expect(runs().map((r) => r.status)).toEqual(["ok", "skipped"]);
    expect(calls).toBe(2);
    await discover(adapter, new Date(T0.getTime() + minutes(120)));
    expect(runs().map((r) => r.status)).toEqual(["ok", "skipped", "ok"]);
    expect(calls).toBe(4);
  });

  it("an Indonesia-search posting from a domestic company is rejected by the Indonesia rule", async () => {
    const adapter = createIndeedAdapter({
      sleep: async () => undefined,
      now: () => T0,
      runWorker: async (s) => ({
        exitCode: 0,
        stdout:
          s.country === "indonesia"
            ? JSON.stringify(
                job("idn1", {
                  company: "PT Contoh Maju",
                  location: "Jakarta, Indonesia",
                  min_amount: 30000000,
                  max_amount: 40000000,
                  currency: "IDR",
                  interval: "monthly",
                }),
              )
            : "",
      }),
    });
    // The company is known to be headquartered in Indonesia (normalize links the posting to this row).
    db.insert(companies)
      .values({
        id: "c-contoh",
        name: "PT Contoh Maju",
        normalized_name: normalizeCompanyName("PT Contoh Maju"),
        hq_country: "ID",
        created_at: T0.toISOString(),
      })
      .run();
    await discover(adapter, T0);
    const row = db.select().from(postings).get();
    expect(row).toMatchObject({ source: "indeed", external_id: "idn1" });
    runProcess({
      db,
      floorIdrMonth: 10_000_000,
      now: () => T0,
      out: () => undefined,
      err: () => undefined,
    });
    const a = db.select().from(analysis).get();
    expect(a).toMatchObject({ decision: "reject", indonesia_rule: "domestic" });
  });
});
