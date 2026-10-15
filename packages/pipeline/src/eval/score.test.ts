import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ExtractionSchema, type Extraction } from "../intel/extract.ts";
import { EvalSetSchema, scoreCase, summarize, type CaseOutcome } from "./score.ts";

const BASE: Extraction = ExtractionSchema.parse({
  listedSalary: { min: 100000, max: 150000, currency: "USD", period: "year" },
  listedSalaryScope: null,
  hiringScope: "worldwide",
  regions: [],
  remoteRegions: [],
  allowedCountries: [],
  indonesiaExplicit: null,
  companyHq: "DE",
  companyType: "product",
  payPolicy: "location_agnostic",
  employment: "contractor",
  eorProvider: null,
  seniority: "senior",
  contactChannels: [],
  personalEmailDomain: null,
  asksForPaymentOrId: null,
  repoAssessmentEarly: null,
  urgencyLanguage: null,
  vagueDescription: null,
});

describe("scoreCase", () => {
  it("passes every listed field that matches and skips fields the case does not list", () => {
    const scores = scoreCase({ hiringScope: "worldwide", seniority: "senior" }, BASE);
    expect(scores).toEqual({ hiringScope: true, seniority: true });
  });

  it("matches enums exactly", () => {
    const scores = scoreCase({ hiringScope: "region", payPolicy: "location_agnostic" }, BASE);
    expect(scores).toEqual({ hiringScope: false, payPolicy: true });
  });

  it("treats an expected null as a claim that the posting does not say", () => {
    expect(scoreCase({ employment: null }, BASE)).toEqual({ employment: false });
    expect(scoreCase({ employment: null }, { ...BASE, employment: null })).toEqual({
      employment: true,
    });
  });

  it("compares booleans and country codes exactly", () => {
    expect(scoreCase({ indonesiaExplicit: true }, { ...BASE, indonesiaExplicit: null })).toEqual({
      indonesiaExplicit: false,
    });
    expect(scoreCase({ companyHq: "DE" }, BASE)).toEqual({ companyHq: true });
    expect(scoreCase({ companyHq: "US" }, BASE)).toEqual({ companyHq: false });
  });

  describe("listedSalary", () => {
    const want = { min: 100000, max: 150000, currency: "USD", period: "year" as const };

    it("accepts a difference inside the 1% tolerance", () => {
      const got = { ...want, min: 100900, max: 149000 };
      expect(scoreCase({ listedSalary: want }, { ...BASE, listedSalary: got })).toEqual({
        listedSalary: true,
      });
    });

    it("rejects a bound outside the tolerance", () => {
      const got = { ...want, max: 152000 };
      expect(scoreCase({ listedSalary: want }, { ...BASE, listedSalary: got })).toEqual({
        listedSalary: false,
      });
    });

    it("rejects a wrong currency or period, ignores currency case", () => {
      expect(
        scoreCase({ listedSalary: want }, { ...BASE, listedSalary: { ...want, currency: "EUR" } }),
      ).toEqual({ listedSalary: false });
      expect(
        scoreCase({ listedSalary: want }, { ...BASE, listedSalary: { ...want, period: "month" } }),
      ).toEqual({ listedSalary: false });
      expect(
        scoreCase({ listedSalary: want }, { ...BASE, listedSalary: { ...want, currency: "usd" } }),
      ).toEqual({ listedSalary: true });
    });

    it("scores a missing salary: null against null passes, null against a number fails", () => {
      expect(scoreCase({ listedSalary: null }, { ...BASE, listedSalary: null })).toEqual({
        listedSalary: true,
      });
      expect(scoreCase({ listedSalary: null }, BASE)).toEqual({ listedSalary: false });
      expect(scoreCase({ listedSalary: want }, { ...BASE, listedSalary: null })).toEqual({
        listedSalary: false,
      });
    });

    it("distinguishes a missing bound from a number", () => {
      const open = { ...want, max: null };
      expect(scoreCase({ listedSalary: open }, { ...BASE, listedSalary: want })).toEqual({
        listedSalary: false,
      });
      expect(scoreCase({ listedSalary: open }, { ...BASE, listedSalary: open })).toEqual({
        listedSalary: true,
      });
    });
  });
});

describe("summarize", () => {
  const outcomes: CaseOutcome[] = [
    {
      id: "a",
      scores: { hiringScope: true, seniority: true },
      expectedFields: ["hiringScope", "seniority"],
    },
    { id: "b", scores: { hiringScope: false }, expectedFields: ["hiringScope"] },
    { id: "c", scores: null, expectedFields: ["hiringScope", "seniority"] },
  ];

  it("counts per field over the cases that expect it, and lists the failing ids", () => {
    expect(summarize(outcomes)).toEqual([
      { field: "hiringScope", correct: 1, total: 3, accuracy: 1 / 3, failingIds: ["b", "c"] },
      { field: "seniority", correct: 1, total: 2, accuracy: 0.5, failingIds: ["c"] },
    ]);
  });

  it("leaves out fields no case expects", () => {
    expect(summarize([]).length).toBe(0);
  });
});

describe("fixtures/eval/extract.json", () => {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("../../../../fixtures/eval/extract.json", import.meta.url), "utf8"),
  );

  it("matches the eval set schema with 20 to 30 cases", () => {
    const set = EvalSetSchema.parse(raw);
    expect(set.cases.length).toBeGreaterThanOrEqual(20);
    expect(set.cases.length).toBeLessThanOrEqual(30);
  });

  it("rejects a set with a duplicate id or an empty expectation", () => {
    const set = EvalSetSchema.parse(raw);
    const [first] = set.cases;
    if (first === undefined) throw new Error("eval set is empty");
    expect(EvalSetSchema.safeParse({ version: 1, cases: [first, first] }).success).toBe(false);
    expect(
      EvalSetSchema.safeParse({ version: 1, cases: [{ ...first, expected: {} }] }).success,
    ).toBe(false);
    expect(
      EvalSetSchema.safeParse({
        version: 1,
        cases: [{ ...first, expected: { seniority: "principal" } }],
      }).success,
    ).toBe(false);
  });

  it("holds no email address, phone number or IP address", () => {
    const text = JSON.stringify(raw);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    expect(text).not.toMatch(/\+\d[\d\s()-]{7,}/);
  });
});
