import { beforeEach, describe, expect, it } from "vitest";
import { fx_rates, openDb, type Db } from "@job-agent/core";
import { parseSalary, toIdrMonth } from "./index.ts";

const p = (salaryText: string) => parseSalary({ salaryText });

describe("parseSalary text formats", () => {
  it.each([
    ["$120k - $150k", { min: 120_000, max: 150_000, currency: "USD", period: "year" }],
    [
      "$120,000–$150,000 USD per year",
      { min: 120_000, max: 150_000, currency: "USD", period: "year" },
    ],
    ["120k-150k USD", { min: 120_000, max: 150_000, currency: "USD", period: "year" }],
    ["€60k", { min: 60_000, max: 60_000, currency: "EUR", period: "year" }],
    ["£50-60k", { min: 50_000, max: 60_000, currency: "GBP", period: "year" }],
    ["USD 5,000/month", { min: 5000, max: 5000, currency: "USD", period: "month" }],
    ["$40-50/hr", { min: 40, max: 50, currency: "USD", period: "hour" }],
    ["$45 per hour", { min: 45, max: 45, currency: "USD", period: "hour" }],
    ["S$8,000 / month", { min: 8000, max: 8000, currency: "SGD", period: "month" }],
    ["A$150k", { min: 150_000, max: 150_000, currency: "AUD", period: "year" }],
    ["CA$130,000", { min: 130_000, max: 130_000, currency: "CAD", period: "year" }],
    [
      "IDR 20.000.000 - 30.000.000 / bulan",
      { min: 20_000_000, max: 30_000_000, currency: "IDR", period: "month" },
    ],
    ["Rp 25jt/bulan", { min: 25_000_000, max: 25_000_000, currency: "IDR", period: "month" }],
    ["Rp 25,5jt/bulan", { min: 25_500_000, max: 25_500_000, currency: "IDR", period: "month" }],
    ["up to $90k", { max: 90_000, currency: "USD", period: "year" }],
    ["from €4,000/mo", { min: 4000, currency: "EUR", period: "month" }],
    ["$100k + equity", { min: 100_000, max: 100_000, currency: "USD", period: "year" }],
  ])("%s", (text, expected) => {
    expect(p(text)).toEqual(expected);
  });

  it("maps every currency symbol", () => {
    expect(p("AU$100k")).toMatchObject({ currency: "AUD" });
    expect(p("C$100k")).toMatchObject({ currency: "CAD" });
    expect(p("Rp 25jt/bulan")).toMatchObject({ currency: "IDR" });
    expect(p("CHF 100,000")).toMatchObject({ currency: "CHF" });
  });

  it("accepts period synonyms", () => {
    for (const w of ["yr", "annual", "pa", "per annum"]) {
      expect(p(`$100,000 ${w}`)).toMatchObject({ period: "year" });
    }
    for (const w of ["mo", "monthly", "bulan"]) {
      expect(p(`$5,000/${w}`)).toMatchObject({ period: "month" });
    }
    for (const w of ["hr", "hourly"]) {
      expect(p(`$50/${w}`)).toMatchObject({ period: "hour" });
    }
  });

  it("returns unknown when there is no number", () => {
    expect(p("Competitive")).toEqual({ status: "unknown" });
    expect(p("DOE")).toEqual({ status: "unknown" });
    expect(p("")).toEqual({ status: "unknown" });
    expect(parseSalary({})).toEqual({ status: "unknown" });
  });

  it("returns unparsed instead of guessing", () => {
    expect(p("8,000")).toEqual({ status: "unparsed" }); // no currency
    expect(p("$8,000")).toEqual({ status: "unparsed" }); // amount fits no period
    expect(p("$1,000 - $150,000")).toEqual({ status: "unparsed" }); // inconsistent inference
    expect(p("¥10,000,000")).toEqual({ status: "unparsed" }); // unknown currency
    expect(p("JPY 10,000,000")).toEqual({ status: "unparsed" });
    expect(p("$2,000/week")).toEqual({ status: "unparsed" });
    expect(p("$300 per day")).toEqual({ status: "unparsed" });
    expect(p("$100k - €120k")).toEqual({ status: "unparsed" }); // mixed currency
    expect(p("$150k - $120k")).toEqual({ status: "unparsed" }); // min > max
    expect(p("$100k negotiable")).toEqual({ status: "unparsed" }); // leftover words
    expect(p("€4.000/mo")).toEqual({ status: "unparsed" }); // ambiguous separator
    expect(p("Rp 500.000")).toEqual({ status: "unparsed" }); // IDR outside month range
    expect(p("Rp 500jt")).toEqual({ status: "unparsed" });
    expect(p("IDR 500,000/month")).toEqual({ status: "unparsed" }); // 3-digit comma group is ambiguous
    expect(p("Rp 25/bulan")).toEqual({ status: "unparsed" }); // explicit period, implausible amount
    expect(p("Rp 500jt/bulan")).toEqual({ status: "unparsed" });
  });

  it("infers period by amount thresholds", () => {
    expect(p("$20,000")).toMatchObject({ period: "year" });
    expect(p("$19,999")).toEqual({ status: "unparsed" });
    expect(p("$300")).toMatchObject({ period: "hour" });
    expect(p("$301")).toEqual({ status: "unparsed" });
    expect(p("IDR 1.000.000")).toMatchObject({ period: "month" });
    expect(p("IDR 200.000.000")).toMatchObject({ period: "month" });
    expect(p("IDR 200.000.001")).toEqual({ status: "unparsed" });
  });
});

describe("parseSalary structured", () => {
  it("beats a contradictory salaryText", () => {
    expect(
      parseSalary({
        salary: { min: 5000, max: 7000, currency: "USD", period: "month" },
        salaryText: "$40-50/hr",
      }),
    ).toEqual({ min: 5000, max: 7000, currency: "USD", period: "month" });
  });

  it("falls back to text when structured has no amounts", () => {
    expect(
      parseSalary({ salary: { currency: "USD", period: "year" }, salaryText: "£50-60k" }),
    ).toMatchObject({ currency: "GBP" });
  });

  it("rejects invalid structured data", () => {
    expect(parseSalary({ salary: { min: 0, currency: "USD", period: "year" } })).toEqual({
      status: "unparsed",
    });
    expect(parseSalary({ salary: { min: 9, max: 5, currency: "USD", period: "year" } })).toEqual({
      status: "unparsed",
    });
    expect(parseSalary({ salary: { min: 5, currency: "$", period: "year" } })).toEqual({
      status: "unparsed",
    });
  });
});

describe("toIdrMonth", () => {
  let db: Db;
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
  const on = "2026-10-06";

  beforeEach(() => {
    db = openDb(":memory:");
    seed("2026-10-05", "IDR", "16000");
    seed("2026-10-04", "EUR", "0.9");
  });

  it("$120k - $150k -> 160,000,000-200,000,000", () => {
    expect(toIdrMonth(p("$120k - $150k"), db, on)).toEqual({
      status: "listed",
      idrMonthMin: 160_000_000,
      idrMonthMax: 200_000_000,
      fxDate: "2026-10-05",
    });
  });

  it("$40-50/hr -> hour x 160", () => {
    expect(toIdrMonth(p("$40-50/hr"), db, on)).toMatchObject({
      idrMonthMin: 102_400_000,
      idrMonthMax: 128_000_000,
    });
  });

  it("€60k -> 88,888,889 and fxDate is the oldest rate date used", () => {
    expect(toIdrMonth(p("€60k"), db, on)).toEqual({
      status: "listed",
      idrMonthMin: 88_888_889,
      idrMonthMax: 88_888_889,
      fxDate: "2026-10-04",
    });
  });

  it("month is taken as is; one-sided ranges keep one side", () => {
    expect(toIdrMonth(p("USD 5,000/month"), db, on)).toMatchObject({ idrMonthMin: 80_000_000 });
    expect(toIdrMonth(p("up to $90k"), db, on)).toEqual({
      status: "listed",
      idrMonthMax: 120_000_000,
      fxDate: "2026-10-05",
    });
    expect(toIdrMonth(p("from €4,000/mo"), db, on)).toEqual({
      status: "listed",
      idrMonthMin: 71_111_111,
      fxDate: "2026-10-04",
    });
  });

  it("IDR needs no FX row", () => {
    const empty = openDb(":memory:");
    expect(toIdrMonth(p("Rp 25jt/bulan"), empty, on)).toEqual({
      status: "listed",
      idrMonthMin: 25_000_000,
      idrMonthMax: 25_000_000,
      fxDate: null,
    });
  });

  it("no FX row for the currency -> no_fx, not a number", () => {
    expect(toIdrMonth(p("£50-60k"), db, on)).toEqual({ status: "no_fx" });
  });

  it("no rate on or before the date -> no_fx", () => {
    expect(toIdrMonth(p("$120k"), db, "2026-10-01")).toEqual({ status: "no_fx" });
  });

  it("passes unknown and unparsed through", () => {
    expect(toIdrMonth(p("Competitive"), db, on)).toEqual({ status: "unknown" });
    expect(toIdrMonth(p("8,000"), db, on)).toEqual({ status: "unparsed" });
  });
});
