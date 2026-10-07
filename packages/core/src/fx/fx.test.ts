import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../db/index.ts";
import { fx_rates } from "../db/schema.ts";
import { SourceError } from "../errors.ts";
import { __testInjectTimeAndSleep } from "../http.ts";
import { createFixtureServer, http, HttpResponse } from "../test-utils.ts";
import { FX_URL, fetchAndStoreFx, getRate, toIdr } from "./index.ts";

let db: Db;
let server: ReturnType<typeof createFixtureServer> | undefined;

beforeEach(() => {
  db = openDb(":memory:");
  let t = 0;
  __testInjectTimeAndSleep(
    () => new Date(t),
    async (ms) => {
      t += ms;
    },
  );
});
afterEach(() => {
  server?.close();
  server = undefined;
  db.$client.close();
});

function seed(date: string, quote: string, rate: string) {
  db.insert(fx_rates)
    .values({
      id: `${date}-${quote}`,
      date,
      base: "USD",
      quote,
      rate,
      source: "t",
      fetched_at: "x",
    })
    .run();
}

describe("fetchAndStoreFx", () => {
  it("stores one row per quote with the source date and is idempotent", async () => {
    server = createFixtureServer([{ url: FX_URL, fixture: "fx/er-api-usd.json" }]);
    await fetchAndStoreFx(db);
    await fetchAndStoreFx(db);
    const rows = db.select().from(fx_rates).all();
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((r) => r.date))).toEqual(new Set(["2026-10-06"]));
    expect(rows.find((r) => r.quote === "IDR")?.rate).toBe("17892.583535");
    expect(rows.every((r) => r.base === "USD")).toBe(true);
  });

  it("writes nothing on HTTP failure", async () => {
    server = createFixtureServer([]);
    server.use(http.get(FX_URL, () => new HttpResponse(null, { status: 404 })));
    await expect(fetchAndStoreFx(db)).rejects.toThrow();
    expect(db.select().from(fx_rates).all()).toHaveLength(0);
  });

  it("writes nothing when a quote is missing", async () => {
    server = createFixtureServer([]);
    server.use(
      http.get(FX_URL, () =>
        HttpResponse.json({
          result: "success",
          base_code: "USD",
          time_last_update_unix: 1791244951,
          rates: { IDR: 16000 },
        }),
      ),
    );
    await expect(fetchAndStoreFx(db)).rejects.toThrow(SourceError);
    expect(db.select().from(fx_rates).all()).toHaveLength(0);
  });
});

describe("getRate", () => {
  it("picks the latest date <= onDate (Fri and Mon, query Sun -> Fri)", () => {
    seed("2026-10-02", "IDR", "16000"); // Fri
    seed("2026-10-05", "IDR", "16500"); // Mon
    expect(getRate(db, "IDR", "2026-10-04")).toBe(16000); // Sun
    expect(getRate(db, "IDR", "2026-10-05")).toBe(16500);
  });

  it("returns null when nothing is stored on or before the date, or for unknown quotes", () => {
    seed("2026-10-05", "IDR", "16500");
    expect(getRate(db, "IDR", "2026-10-04")).toBeNull();
    expect(getRate(db, "XXX", "2026-10-06")).toBeNull();
  });
});

describe("toIdr", () => {
  beforeEach(() => {
    seed("2026-10-05", "IDR", "16000");
    seed("2026-10-05", "EUR", "0.9");
  });

  it("converts via USD", () => {
    expect(toIdr(db, 1000, "EUR", "2026-10-06")).toBeCloseTo(17_777_777.78, 2);
    expect(toIdr(db, 1000, "USD", "2026-10-06")).toBe(16_000_000);
    expect(toIdr(db, 1000, "IDR", "2026-10-06")).toBe(1000);
  });

  it("returns null for unknown currency, missing rate or missing IDR", () => {
    expect(toIdr(db, 1000, "GBP", "2026-10-06")).toBeNull();
    expect(toIdr(db, 1000, "EUR", "2026-10-01")).toBeNull();
    expect(toIdr(db, 1000, "USD", "2026-10-01")).toBeNull();
  });
});
