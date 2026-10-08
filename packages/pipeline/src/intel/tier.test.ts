import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type SalaryConfig } from "@job-agent/core";
import { afterAll, describe, expect, it } from "vitest";
import { ExtractionSchema, type Extraction } from "./extract.ts";
import type { CompanyPayPolicy } from "./registry.ts";
import { decideTierAndAsk, type TierFx } from "./tier.ts";

// The numbers of config/salary.example.yaml (fake persona), loaded through the real config loader.
const configDir = mkdtempSync(join(tmpdir(), "job-agent-tier-"));
const exampleDir = new URL("../../../../config/", import.meta.url).pathname;
copyFileSync(join(exampleDir, "salary.example.yaml"), join(configDir, "salary.yaml"));
copyFileSync(join(exampleDir, "companies.example.yaml"), join(configDir, "companies.yaml"));
const SALARY: SalaryConfig = loadConfig(configDir).salary;
afterAll(() => rmSync(configDir, { recursive: true, force: true }));

const FX: TierFx = {
  idrPerUsd: 17_900,
  perUsd: { EUR: 0.9, CAD: 1.4, GBP: 0.8, INR: 88, SGD: 1.3 },
};
const NO_REGISTRY: CompanyPayPolicy = { policy: "unknown", source: null };

const BLANK: Extraction = ExtractionSchema.parse({
  listedSalary: null,
  listedSalaryScope: null,
  hiringScope: null,
  regions: [],
  remoteRegions: [],
  allowedCountries: [],
  indonesiaExplicit: null,
  companyHq: null,
  companyType: null,
  payPolicy: null,
  employment: null,
  eorProvider: null,
  seniority: null,
  contactChannels: [],
  personalEmailDomain: null,
  asksForPaymentOrId: null,
  repoAssessmentEarly: null,
  urgencyLanguage: null,
  vagueDescription: null,
});

const decide = (x: Partial<Extraction>, registry: CompanyPayPolicy = NO_REGISTRY, fx = FX) =>
  decideTierAndAsk({ ...BLANK, ...x }, registry, SALARY, fx);

const usdYear = (min: number | null, max: number | null): Extraction["listedSalary"] => ({
  min,
  max,
  currency: "USD",
  period: "year",
});
const toIdrMonth = (usd: number) => (usd * FX.idrPerUsd) / 12;

describe("listed location-agnostic range", () => {
  it("ask = min + 0.7 x (max - min)", () => {
    const r = decide({
      listedSalary: usdYear(100_000, 140_000),
      listedSalaryScope: "all_locations",
    });
    expect(r.branch).toBe("listed_agnostic");
    expect(r.tier).toBe("global_flat");
    expect(r.askIdrMonth).toBe(Math.round(toIdrMonth(128_000)));
    expect(r.askText).toBeNull();
  });

  it("property: never above max, never below floor, over many ranges and periods", () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 500; i++) {
      const period = i % 3 === 0 ? "year" : i % 3 === 1 ? "month" : "hour";
      const scale = period === "year" ? 200_000 : period === "month" ? 15_000 : 120;
      const a = rnd() * scale;
      const b = a + rnd() * scale;
      const r = decide({
        listedSalary: { min: a, max: b, currency: "USD", period },
        listedSalaryScope: "all_locations",
      });
      const monthly = { year: 1 / 12, month: 1, hour: 160 }[period];
      const maxIdr = b * monthly * FX.idrPerUsd;
      expect(r.branch).toBe("listed_agnostic");
      expect(r.askIdrMonth).toBeGreaterThanOrEqual(SALARY.floor_idr_month);
      if (maxIdr >= SALARY.floor_idr_month) expect(r.askIdrMonth).toBeLessThanOrEqual(maxIdr);
      expect((r.askUsdYear * FX.idrPerUsd) / 12).toBeGreaterThanOrEqual(SALARY.floor_idr_month);
    }
  });

  it("a range wholly under the floor is raised to the floor and says so", () => {
    const r = decide({ listedSalary: usdYear(5_000, 6_000), listedSalaryScope: "all_locations" });
    expect(r.askIdrMonth).toBe(SALARY.floor_idr_month);
    expect(r.askReason).toContain("raised to floor");
  });

  it("single figure, min only and max only stay within the listed numbers", () => {
    const one = decide({
      listedSalary: usdYear(120_000, 120_000),
      listedSalaryScope: "all_locations",
    });
    expect(one.askIdrMonth).toBe(Math.round(toIdrMonth(120_000)));
    const minOnly = decide({
      listedSalary: usdYear(100_000, null),
      listedSalaryScope: "all_locations",
    });
    expect(minOnly.askIdrMonth).toBe(Math.round(toIdrMonth(100_000)));
    const maxOnly = decide({
      listedSalary: usdYear(null, 100_000),
      listedSalaryScope: "all_locations",
    });
    expect(maxOnly.askIdrMonth).toBeLessThanOrEqual(toIdrMonth(100_000));
  });

  it("converts other currencies with the given rate", () => {
    const r = decide({
      listedSalary: { min: 90_000, max: 108_000, currency: "EUR", period: "year" },
      listedSalaryScope: "all_locations",
    });
    // EUR 0.9 per USD -> 100k-120k USD, ask 114k USD
    expect(r.askIdrMonth).toBe(Math.round(toIdrMonth(114_000)));
  });

  it("hourly ranges are normalised x160 hours per month (USD and other currencies)", () => {
    const expected = 74 * 160 * FX.idrPerUsd; // 60-80 USD/h -> 74 USD/h at position 0.7
    const usd = decide({
      listedSalary: { min: 60, max: 80, currency: "USD", period: "hour" },
      listedSalaryScope: "all_locations",
    });
    expect(Math.abs(usd.askIdrMonth - expected)).toBeLessThanOrEqual(1);
    // EUR 0.9 per USD: 54-72 EUR/h is the same 60-80 USD/h
    const eur = decide({
      listedSalary: { min: 54, max: 72, currency: "EUR", period: "hour" },
      listedSalaryScope: "all_locations",
    });
    expect(Math.abs(eur.askIdrMonth - expected)).toBeLessThanOrEqual(1);
  });

  it("monthly ranges are not rescaled", () => {
    const r = decide({
      listedSalary: { min: 8_000, max: 10_000, currency: "USD", period: "month" },
      listedSalaryScope: "all_locations",
    });
    expect(Math.abs(r.askIdrMonth - 9_400 * FX.idrPerUsd)).toBeLessThanOrEqual(1);
  });

  it("an unconvertible currency ignores the range and says why", () => {
    const r = decide({
      listedSalary: { min: 1, max: 2, currency: "XYZ", period: "year" },
      listedSalaryScope: "all_locations",
    });
    expect(r.branch).toBe("unknown");
    expect(r.askReason).toContain("no FX rate");
  });

  it("an agnostic policy with an unspecified-scope range counts as agnostic", () => {
    const r = decide({
      listedSalary: usdYear(100_000, 120_000),
      listedSalaryScope: "unspecified",
      payPolicy: "location_agnostic",
    });
    expect(r.branch).toBe("listed_agnostic");
  });

  it("a location-dependent range is not agnostic even with a flat claim", () => {
    const r = decide({
      listedSalary: usdYear(100_000, 120_000),
      listedSalaryScope: "location_dependent",
      payPolicy: "location_agnostic",
    });
    expect(r.branch).toBe("flat");
  });
});

describe("US pay-transparency trap", () => {
  it("branch us_legal_note_unknown, never global_flat, even with an agnostic claim", () => {
    for (const payPolicy of [null, "location_agnostic", "location_adjusted"] as const) {
      const r = decide({
        listedSalary: usdYear(150_000, 220_000),
        listedSalaryScope: "us_only_or_legal_note",
        payPolicy,
        hiringScope: "worldwide",
      });
      expect(r.branch).toBe("us_legal_note_unknown");
      expect(r.tier).not.toBe("global_flat");
      expect(r.askText).toBe(SALARY.text_field_answer);
      expect(r.askIdrMonth).toBe(SALARY.tiers.regional.ask_idr_month);
    }
  });
});

describe("US pay-transparency trap via registry", () => {
  it("a registry flat policy does not make a US-only range global_flat", () => {
    const r = decide(
      { listedSalary: usdYear(150_000, 220_000), listedSalaryScope: "us_only_or_legal_note" },
      { policy: "location_agnostic", source: "manual" },
    );
    expect(r.branch).toBe("us_legal_note_unknown");
    expect(r.tier).toBe("regional");
    expect(r.askIdrMonth).toBe(SALARY.tiers.regional.ask_idr_month);
    expect(r.askText).toBe(SALARY.text_field_answer);
  });
});

describe("no listed range", () => {
  it("unknown policy -> text answer plus the regional number", () => {
    const r = decide({ hiringScope: "worldwide" });
    expect(r.branch).toBe("unknown");
    expect(r.tier).toBe("regional");
    expect(r.askText).toBe(SALARY.text_field_answer);
    expect(r.askIdrMonth).toBe(SALARY.tiers.regional.ask_idr_month);
  });

  it("registry flat -> global_flat with the configured USD ask", () => {
    const r = decide(
      {},
      { policy: "location_agnostic", source: "careers:https://example.com/pay" },
    );
    expect(r.branch).toBe("flat");
    expect(r.tier).toBe("global_flat");
    expect(r.askUsdYear).toBe(SALARY.tiers.global_flat.ask_usd_year);
    expect(r.askText).toBeNull();
    expect(r.askReason).toContain("registry careers:");
  });

  it("posting-stated flat policy works without a registry entry", () => {
    expect(decide({ payPolicy: "location_agnostic" }).branch).toBe("flat");
  });

  it("registry wins over the posting's claim", () => {
    const r = decide(
      { payPolicy: "location_agnostic" },
      { policy: "location_adjusted", source: "manual" },
    );
    expect(r.branch).toBe("adjusted");
  });

  it("adjusted tier mapping", () => {
    const adj = { payPolicy: "location_adjusted" } as const;
    expect(decide({ ...adj, hiringScope: "worldwide" }).tier).toBe("global_adjusted");
    expect(decide({ ...adj, hiringScope: "region", regions: ["APAC"] }).tier).toBe("regional");
    expect(decide({ ...adj, hiringScope: "worldwide", companyType: "agency" }).tier).toBe(
      "regional",
    );
    expect(decide({ ...adj, companyType: "talent_marketplace" }).tier).toBe("regional");
    // no stated policy: a location-dependent range is an adjusted signal, an agency alone is not
    expect(decide({ companyType: "agency" }).branch).toBe("unknown");
    expect(
      decide({ listedSalary: usdYear(1, 2), listedSalaryScope: "location_dependent" }).branch,
    ).toBe("adjusted");
    expect(
      decide({
        ...adj,
        hiringScope: "countries",
        allowedCountries: ["ID"],
        indonesiaExplicit: true,
      }).tier,
    ).toBe("indonesia");
    expect(decide({ ...adj, employment: "eor", indonesiaExplicit: true }).tier).toBe("indonesia");
    const indo = decide({ ...adj, employment: "eor", indonesiaExplicit: true });
    expect(indo.askIdrMonth).toBe(SALARY.tiers.indonesia.ask_idr_month);
  });
});

describe("floor always applies", () => {
  it("raises every tier ask that is below a higher floor, compared in IDR", () => {
    const high: SalaryConfig = { ...SALARY, floor_idr_month: 100_000_000 };
    const inputs: Partial<Extraction>[] = [
      { payPolicy: "location_adjusted", hiringScope: "worldwide" },
      { payPolicy: "location_agnostic" },
      {},
      { listedSalary: usdYear(50_000, 60_000), listedSalaryScope: "all_locations" },
      { listedSalary: usdYear(50_000, 60_000), listedSalaryScope: "us_only_or_legal_note" },
    ];
    for (const x of inputs) {
      const r = decideTierAndAsk({ ...BLANK, ...x }, NO_REGISTRY, high, FX);
      expect(r.askIdrMonth).toBeGreaterThanOrEqual(high.floor_idr_month);
      expect((r.askUsdYear * FX.idrPerUsd) / 12).toBeGreaterThanOrEqual(high.floor_idr_month);
      expect(r.askReason).toContain("raised to floor");
    }
  });

  it("USD figure converted back is never under the floor for odd rates", () => {
    for (const idrPerUsd of [15_321.7, 16_999.99, 17_900, 18_432.1]) {
      const r = decide({ payPolicy: "location_agnostic" }, NO_REGISTRY, { idrPerUsd });
      expect((r.askUsdYear * idrPerUsd) / 12).toBeGreaterThanOrEqual(SALARY.floor_idr_month);
      expect(r.askIdrMonth).toBeGreaterThanOrEqual(SALARY.floor_idr_month);
    }
  });
});

describe("ask_reason", () => {
  it("names the branch, tier and the inputs, but not the floor or configured asks", () => {
    const r = decide({
      listedSalary: usdYear(100_000, 140_000),
      listedSalaryScope: "all_locations",
      hiringScope: "worldwide",
      companyType: "product",
    });
    expect(r.askReason).toContain("branch=listed_agnostic");
    expect(r.askReason).toContain("tier=global_flat");
    expect(r.askReason).toContain("listed 100000-140000 USD/year");
    expect(r.askReason).toContain("scope=all_locations");
    expect(r.askReason).toContain("hiring=worldwide");
    expect(r.askReason).toContain("company=product");
    expect(r.askReason).toContain("position 0.7");
    expect(r.askReason).not.toContain(String(SALARY.floor_idr_month));
  });
});

describe("R5 golden set (t_dee70d65)", () => {
  interface Row {
    id: string;
    judgment: boolean;
    registryPolicy: "location_agnostic" | "location_adjusted" | "unknown";
    expectedBranch: string;
    extraction: unknown;
  }
  const rows = (
    JSON.parse(
      readFileSync(new URL("../../../../fixtures/golden/tier.json", import.meta.url), "utf8"),
    ) as { rows: Row[] }
  ).rows;

  const run = (row: Row) =>
    decideTierAndAsk(
      ExtractionSchema.parse(row.extraction),
      row.registryPolicy === "unknown"
        ? NO_REGISTRY
        : { policy: row.registryPolicy, source: "manual" },
      SALARY,
      FX,
    );

  it("has the 55 rows with 12 hard ones", () => {
    expect(rows).toHaveLength(55);
    expect(rows.filter((r) => !r.judgment)).toHaveLength(12);
  });

  it("branch matches for every non-judgment row", () => {
    for (const row of rows.filter((r) => !r.judgment)) {
      expect({ id: row.id, branch: run(row).branch }).toEqual({
        id: row.id,
        branch: row.expectedBranch,
      });
    }
  });

  it("branch matches for the judgment rows too", () => {
    const mismatches = rows
      .filter((r) => r.judgment)
      .filter((r) => run(r).branch !== r.expectedBranch)
      .map((r) => `${r.id}: ${run(r).branch} != ${r.expectedBranch}`);
    expect(mismatches).toEqual([]);
  });

  it("every ask is at or above the floor in IDR and no US-note row is global_flat", () => {
    for (const row of rows) {
      const r = run(row);
      expect(r.askIdrMonth).toBeGreaterThanOrEqual(SALARY.floor_idr_month);
      expect((r.askUsdYear * FX.idrPerUsd) / 12).toBeGreaterThanOrEqual(SALARY.floor_idr_month);
      if (row.expectedBranch === "us_legal_note_unknown") expect(r.tier).not.toBe("global_flat");
    }
  });
});
