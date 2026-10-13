import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  EXTRACT_PROMPT_VERSION,
  ExtractionSchema,
  ROLE_FAMILIES,
  type Extraction,
} from "./extract.ts";
import { EXTRACT_SYSTEM_PROMPT } from "./prompts/extract.ts";
import { resolveFlags, TARGET_ROLE_FAMILIES, type ResolveInput } from "./resolve.ts";

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
  roleFamily: null,
  contactChannels: [],
  personalEmailDomain: null,
  asksForPaymentOrId: null,
  repoAssessmentEarly: null,
  urgencyLanguage: null,
  vagueDescription: null,
});

const run = (flags: string[], x: Partial<Extraction>, ruleDecision: "keep" | "reject" = "keep") =>
  resolveFlags({ ruleDecision, flags, extraction: { ...BLANK, ...x } } satisfies ResolveInput);

describe("resolve: location", () => {
  const f = ["location_unclear"];
  it("countries without Indonesia -> reject", () => {
    const r = run(f, { hiringScope: "countries", allowedCountries: ["US", "CA"] });
    expect(r.decision).toBe("reject");
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toContain("US, CA");
    expect(r.remainingFlags).toEqual([]);
  });
  it("countries including Indonesia -> keep", () => {
    const r = run(f, { hiringScope: "countries", allowedCountries: ["SG", "ID"] });
    expect(r.decision).toBe("keep");
    expect(r.reasons[0]).toContain("Indonesia");
  });
  it("worldwide -> keep", () => {
    const r = run(f, { hiringScope: "worldwide" });
    expect(r.decision).toBe("keep");
    expect(r.reasons[0]).toContain("worldwide");
  });
  it("region covering Indonesia (APAC, Southeast Asia) -> keep", () => {
    expect(run(f, { hiringScope: "region", regions: ["APAC"] }).decision).toBe("keep");
    expect(run(f, { hiringScope: "region", regions: ["Southeast Asia"] }).reasons).toHaveLength(1);
  });
  it("region not covering Indonesia (EMEA) -> reject", () => {
    expect(run(f, { hiringScope: "region", regions: ["EMEA"] }).decision).toBe("reject");
  });
  it("Indonesia named explicitly -> keep even with a country list", () => {
    const r = run(f, {
      hiringScope: "countries",
      allowedCountries: ["US"],
      indonesiaExplicit: true,
    });
    expect(r.decision).toBe("keep");
  });
  it("unknown facts leave the flag in place", () => {
    const r = run(f, {});
    expect(r).toEqual({ decision: "keep", reasons: [], remainingFlags: ["location_unclear"] });
  });
  it("an unknown region name settles nothing", () => {
    const r = run(f, { hiringScope: "region", regions: ["GMT +/- 3h"] });
    expect(r.remainingFlags).toEqual(["location_unclear"]);
    expect(r.reasons).toEqual([]);
  });
  it("indonesiaExplicit=false alone does not reject", () => {
    expect(run(f, { indonesiaExplicit: false }).remainingFlags).toEqual(["location_unclear"]);
  });
  it("scope without any places leaves the flag", () => {
    expect(run(f, { hiringScope: "countries" }).remainingFlags).toEqual(["location_unclear"]);
  });
});

describe("resolve: indonesia", () => {
  const f = ["indonesia_unclear"];
  it("HQ in Indonesia, no foreign signal -> reject as domestic", () => {
    const r = run(f, { companyHq: "ID" });
    expect(r.decision).toBe("reject");
    expect(r.reasons[0]).toContain("domestic");
  });
  it("HQ in Indonesia, IDR salary -> still domestic", () => {
    const listedSalary = { min: 1, max: 2, currency: "IDR", period: "month" as const };
    expect(run(f, { companyHq: "ID", listedSalary }).decision).toBe("reject");
  });
  it("HQ in Indonesia with foreign currency -> flag stays", () => {
    const listedSalary = { min: 1, max: 2, currency: "USD", period: "year" as const };
    const r = run(f, { companyHq: "ID", listedSalary });
    expect(r.remainingFlags).toEqual(["indonesia_unclear"]);
    expect(r.reasons).toEqual([]);
  });
  it("HQ in Indonesia with EOR -> flag stays", () => {
    expect(run(f, { companyHq: "ID", employment: "eor" }).remainingFlags).toEqual(f);
    expect(run(f, { companyHq: "ID", eorProvider: "Deel" }).remainingFlags).toEqual(f);
  });
  it("foreign HQ -> keep", () => {
    const r = run(f, { companyHq: "NL" });
    expect(r.decision).toBe("keep");
    expect(r.reasons[0]).toContain("NL");
  });
  it("unknown HQ leaves the flag", () => {
    expect(run(f, {}).remainingFlags).toEqual(f);
  });
});

describe("resolve: role family, no flags", () => {
  it.each([
    [
      "design",
      "reject",
      "Role: the posting is a design role, outside the target (frontend, fullstack).",
    ],
    [
      "backend",
      "reject",
      "Role: the posting is a backend role, outside the target (frontend, fullstack).",
    ],
    [
      "mobile",
      "reject",
      "Role: the posting is a mobile role, outside the target (frontend, fullstack).",
    ],
    [
      "data_ml",
      "reject",
      "Role: the posting is a data_ml role, outside the target (frontend, fullstack).",
    ],
    [
      "devops_sre",
      "reject",
      "Role: the posting is a devops_sre role, outside the target (frontend, fullstack).",
    ],
    [
      "security",
      "reject",
      "Role: the posting is a security role, outside the target (frontend, fullstack).",
    ],
    [
      "non_engineering",
      "reject",
      "Role: the posting is a non_engineering role, outside the target (frontend, fullstack).",
    ],
    ["not_a_job", "reject", "Role: the text is not a job posting."],
  ] as const)("%s -> %s", (roleFamily, decision, reason) => {
    expect(run([], { roleFamily })).toEqual({ decision, reasons: [reason], remainingFlags: [] });
  });
  it.each(["frontend", "fullstack"] as const)("%s -> keep, no reason", (roleFamily) => {
    expect(run([], { roleFamily })).toEqual({ decision: "keep", reasons: [], remainingFlags: [] });
  });
  it("null family -> keep, no reason added", () => {
    expect(run([], { roleFamily: null })).toEqual({
      decision: "keep",
      reasons: [],
      remainingFlags: [],
    });
  });
  it("a rule reject stays untouched", () => {
    expect(run([], { roleFamily: "design" }, "reject").reasons).toEqual([]);
  });
  it("another flag settling to keep does not rescue an out-of-target family", () => {
    const r = run(["location_unclear"], { hiringScope: "worldwide", roleFamily: "backend" });
    expect(r.decision).toBe("reject");
    expect(r.remainingFlags).toEqual([]);
    expect(r.reasons).toHaveLength(2);
  });
  it("target constant", () => {
    expect(TARGET_ROLE_FAMILIES).toEqual(["frontend", "fullstack"]);
  });
});

describe("resolve: role_unclear", () => {
  const f = ["role_unclear"];
  const unresolved = { decision: "keep", reasons: [], remainingFlags: f };
  it("target family + senior or lead -> keep, flag settled, reason names family and level", () => {
    const senior = run(f, { roleFamily: "fullstack", seniority: "senior" });
    expect(senior.decision).toBe("keep");
    expect(senior.reasons).toEqual(["Role: fullstack role at senior level."]);
    expect(senior.remainingFlags).toEqual([]);
    const lead = run(f, { roleFamily: "frontend", seniority: "lead" });
    expect(lead.decision).toBe("keep");
    expect(lead.reasons).toEqual(["Role: frontend role at lead level."]);
  });
  it("target family + mid -> reject", () => {
    const r = run(f, { roleFamily: "fullstack", seniority: "mid" });
    expect(r.decision).toBe("reject");
    expect(r.reasons[0]).toContain("mid level");
  });
  it("backend + senior -> reject with the family reason once", () => {
    const r = run(f, { roleFamily: "backend", seniority: "senior" });
    expect(r.decision).toBe("reject");
    expect(r.reasons).toEqual([
      "Role: the posting is a backend role, outside the target (frontend, fullstack).",
    ]);
    expect(r.remainingFlags).toEqual([]);
  });
  it("non-engineering and not_a_job -> reject, whatever the seniority", () => {
    for (const roleFamily of ["non_engineering", "not_a_job"] as const)
      for (const seniority of ["senior", "lead", "mid", null] as const) {
        const r = run(f, { roleFamily, seniority });
        expect(r.decision, `${roleFamily}/${seniority}`).toBe("reject");
        expect(r.remainingFlags).toEqual([]);
      }
  });
  it("target family + null seniority -> flag stays", () => {
    expect(run(f, { roleFamily: "fullstack", seniority: null })).toEqual(unresolved);
  });
  it("seniority alone never keeps: null family stays unresolved", () => {
    for (const seniority of ["senior", "lead", "mid"] as const)
      expect(run(f, { roleFamily: null, seniority }), seniority).toEqual(unresolved);
    expect(run(f, { companyType: "product" })).toEqual(unresolved);
  });
  it("no reason says 'matches the target' on any branch", () => {
    const levels = ["senior", "lead", "mid", null] as const;
    for (const roleFamily of [...ROLE_FAMILIES, null])
      for (const seniority of levels) {
        const r = run(f, { roleFamily, seniority });
        for (const reason of r.reasons)
          expect(reason, `${roleFamily}/${seniority}`).not.toContain("matches the target");
      }
  });
});

describe("extraction schema: roleFamily", () => {
  it("old intel rows without the field parse as null", () => {
    const old: Record<string, unknown> = { ...BLANK };
    delete old["roleFamily"];
    expect("roleFamily" in old).toBe(false);
    expect(ExtractionSchema.parse(old).roleFamily).toBeNull();
  });
  it("accepts the ten families and rejects anything else", () => {
    for (const roleFamily of ROLE_FAMILIES)
      expect(ExtractionSchema.parse({ ...BLANK, roleFamily }).roleFamily).toBe(roleFamily);
    expect(() => ExtractionSchema.parse({ ...BLANK, roleFamily: "sales" })).toThrow();
  });
  it("an extract-v3 row with 'engineering' parses as null and resolves with no family reject", () => {
    const old = ExtractionSchema.parse({ ...BLANK, roleFamily: "engineering" });
    expect(old.roleFamily).toBeNull();
    expect(resolveFlags({ ruleDecision: "keep", flags: [], extraction: old })).toEqual({
      decision: "keep",
      reasons: [],
      remainingFlags: [],
    });
  });
  it("the prompt defines the families and the Gameplay Animator example", () => {
    expect(EXTRACT_SYSTEM_PROMPT).toContain("roleFamily");
    for (const family of ROLE_FAMILIES) expect(EXTRACT_SYSTEM_PROMPT).toContain(`"${family}"`);
    expect(EXTRACT_SYSTEM_PROMPT).toMatch(/"Gameplay Animator"[^.]*"design"/);
    expect(EXTRACT_PROMPT_VERSION).toBe("extract-v4");
  });
});

describe("resolve: combination and guards", () => {
  it("one reject among several resolved flags rejects, with one line per change", () => {
    const r = run(["location_unclear", "indonesia_unclear", "role_unclear"], {
      hiringScope: "worldwide",
      companyHq: "ID",
      seniority: "senior",
      roleFamily: "fullstack",
    });
    expect(r.decision).toBe("reject");
    expect(r.reasons).toHaveLength(3);
  });
  it("flags it does not own are ignored", () => {
    const r = run(["salary_below_floor"], { hiringScope: "worldwide" });
    expect(r).toEqual({ decision: "keep", reasons: [], remainingFlags: [] });
  });
  it("never overturns a rule reject, even when every fact says keep", () => {
    const r = run(
      ["location_unclear", "indonesia_unclear", "role_unclear"],
      { hiringScope: "worldwide", companyHq: "NL", seniority: "senior", indonesiaExplicit: true },
      "reject",
    );
    expect(r.decision).toBe("reject");
    expect(r.reasons).toEqual([]);
  });
  it("without flags there is no change", () => {
    expect(run([], { hiringScope: "countries", allowedCountries: ["US"] })).toEqual({
      decision: "keep",
      reasons: [],
      remainingFlags: [],
    });
  });
});

const ISO: Record<string, string> = {
  "United States": "US",
  US: "US",
  Canada: "CA",
  Singapore: "SG",
  India: "IN",
  Indonesia: "ID",
  "United Kingdom": "GB",
  Romania: "RO",
  France: "FR",
  "Hong Kong": "HK",
  Taiwan: "TW",
  Australia: "AU",
  Japan: "JP",
  "New Zealand": "NZ",
  Thailand: "TH",
  Dubai: "AE",
  Ireland: "IE",
  "South Korea": "KR",
  Philippines: "PH",
  Argentina: "AR",
  Colombia: "CO",
  "Dominican Republic": "DO",
  Ecuador: "EC",
  Egypt: "EG",
  Honduras: "HN",
  Jamaica: "JM",
  Mexico: "MX",
  Nicaragua: "NI",
  Panama: "PA",
  Peru: "PE",
  "South Africa": "ZA",
  Malaysia: "MY",
};
const HQ: Record<string, string> = { UK: "GB", Indonesia: "ID", France: "FR", Canada: "CA" };

const Row = z.object({
  id: z.string(),
  source: z.string(),
  hiringScope: z.enum(["worldwide", "region", "countries"]).nullable(),
  places: z.array(z.string()),
  indonesiaExplicit: z.boolean().nullable(),
  companyHq: z.string().nullable(),
  employment: z.enum(["employee", "contractor", "eor", "unknown"]).nullable(),
  currency: z.string().nullable(),
  judgment: z.boolean(),
  expectedLocation: z.enum(["keep", "reject"]).optional(),
  expectedIndonesia: z.enum(["keep", "reject"]).nullable().optional(),
});
const rows = z
  .array(Row)
  .parse(
    JSON.parse(
      readFileSync(new URL("../../../../fixtures/golden/resolve.json", import.meta.url), "utf8"),
    ),
  );

function toExtraction(r: z.infer<typeof Row>): Partial<Extraction> {
  const place = (p: string) => {
    const iso = ISO[p];
    if (iso === undefined) throw new Error(`${r.id}: no ISO code for ${p}`);
    return iso;
  };
  return {
    hiringScope: r.hiringScope,
    ...(r.hiringScope === "countries"
      ? { allowedCountries: r.places.map(place) }
      : { regions: r.places }),
    indonesiaExplicit: r.indonesiaExplicit,
    companyHq: r.companyHq === null ? null : (HQ[r.companyHq] ?? r.companyHq),
    employment: r.employment === "unknown" ? null : r.employment,
    ...(r.currency !== null
      ? { listedSalary: { min: null, max: null, currency: r.currency, period: "year" as const } }
      : {}),
  };
}

describe("resolve golden set (R5 rows, t_dee70d65)", () => {
  const firm = rows.filter((r) => !r.judgment);
  const all = ["location_unclear", "indonesia_unclear"];

  it("has non-judgment rows with labels", () => {
    expect(rows).toHaveLength(55);
    expect(firm.length).toBeGreaterThanOrEqual(10);
    expect(firm.every((r) => r.expectedLocation !== undefined)).toBe(true);
  });

  it("location: all non-judgment rows match", () => {
    const bad = firm.filter((r) => {
      const res = run(["location_unclear"], toExtraction(r));
      return res.decision !== r.expectedLocation;
    });
    expect(bad.map((r) => r.id)).toEqual([]);
  });

  it("indonesia: all non-judgment rows match (null = stays unclear)", () => {
    const bad = firm.filter((r) => {
      const res = run(["indonesia_unclear"], toExtraction(r));
      const got = res.remainingFlags.length > 0 ? null : res.decision;
      return got !== (r.expectedIndonesia ?? null);
    });
    expect(bad.map((r) => r.id)).toEqual([]);
  });

  it("every settled row explains itself; judgment rows are printed", () => {
    for (const r of rows) {
      const res = run(all, toExtraction(r));
      expect(res.reasons.length + res.remainingFlags.length, r.id).toBeGreaterThanOrEqual(1);
      for (const line of res.reasons) expect(line.length, r.id).toBeGreaterThan(10);
    }
    const lines = rows
      .filter((r) => r.judgment)
      .map((r) => `  ${r.id}: ${run(all, toExtraction(r)).decision}`);
    console.log(["", "Resolve judgment rows:", ...lines, ""].join("\n"));
  });
});
