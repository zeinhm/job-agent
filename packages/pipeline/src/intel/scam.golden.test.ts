import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ExtractionSchema } from "./extract.ts";
import {
  reasonPoints,
  formatReason,
  SCAM_THRESHOLD,
  SCAM_WEIGHTS,
  scoreScam,
  type ScamInput,
  type ScamWeights,
} from "./scam.ts";

const Row = z.object({
  id: z.string(),
  label: z.enum(["scam", "unclear", "legit"]),
  excerpt: z.string(),
  signals: z.array(z.string()),
  scoreBand: z.tuple([z.number(), z.number()]),
  judgment: z.boolean(),
  inputs: z.object({
    companyName: z.string().optional(),
    companyDomain: z.string().optional(),
    applyUrl: z.string().optional(),
    verification: z.enum(["verified", "missing", "unknown"]).optional(),
    domainAge: z.object({ domain: z.string(), days: z.number().nullable() }).optional(),
    extraction: z.record(z.string(), z.unknown()).optional(),
  }),
});

const rows = z
  .array(Row)
  .parse(
    JSON.parse(
      readFileSync(new URL("../../../../fixtures/golden/scam.json", import.meta.url), "utf8"),
    ),
  );

const BASE_EXTRACTION = ExtractionSchema.parse({
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

function inputOf(r: z.infer<typeof Row>): ScamInput {
  const i = r.inputs;
  return {
    title: "Role",
    companyName: i.companyName ?? "Example Co",
    companyDomain: i.companyDomain ?? null,
    descriptionText: r.excerpt,
    applyUrl: i.applyUrl ?? null,
    extraction: i.extraction
      ? ExtractionSchema.parse({ ...BASE_EXTRACTION, ...i.extraction })
      : null,
    domainAge: i.domainAge ?? null,
    verification: i.verification ?? "unknown",
  };
}

/** Firm rows that break the contract: scam < threshold, legit >= threshold. */
function failures(weights: ScamWeights): string[] {
  return rows
    .filter((r) => !r.judgment)
    .flatMap((r) => {
      const { score } = scoreScam(inputOf(r), weights);
      if (r.label === "scam" && score < SCAM_THRESHOLD) return [`${r.id} scam scored ${score}`];
      if (r.label === "legit" && score >= SCAM_THRESHOLD) return [`${r.id} legit scored ${score}`];
      return [];
    });
}

describe("scam golden set (R6)", () => {
  it("loads all label kinds, with firm and judgment rows", () => {
    expect(rows.length).toBeGreaterThanOrEqual(37);
    for (const l of ["scam", "unclear", "legit"] as const) {
      expect(rows.some((r) => r.label === l)).toBe(true);
    }
    expect(rows.some((r) => r.judgment)).toBe(true);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it("every firm scam row scores >= 60 and every firm legit row < 60", () => {
    expect(failures(SCAM_WEIGHTS)).toEqual([]);
  });

  it("reports judgment rows without gating them", () => {
    const lines = rows
      .filter((r) => r.judgment)
      .map((r) => {
        const { score } = scoreScam(inputOf(r));
        const [lo, hi] = r.scoreBand;
        return `  ${r.id} ${r.label} scored ${score} (band ${lo}-${hi}) ${score >= lo && score <= hi ? "ok" : "DIFFERS"}`;
      });
    console.log(["", "Scam golden set, judgment rows:", ...lines, ""].join("\n"));
    expect(lines.length).toBeGreaterThan(0);
  });

  it("every point in the score has a reason line, and the reasons sum to the score", () => {
    for (const r of rows) {
      const result = scoreScam(inputOf(r));
      const lines = result.reasons.map(formatReason);
      const sum = lines.reduce((s, l) => s + reasonPoints(l), 0);
      expect(sum, r.id).toBe(result.score);
      for (const reason of result.reasons) expect(reason.text.length, r.id).toBeGreaterThan(0);
    }
  });

  it("the expected signals fire on firm scam rows", () => {
    for (const r of rows.filter((x) => x.label === "scam" && !x.judgment)) {
      const fired = new Set(scoreScam(inputOf(r)).reasons.map((x) => x.signal));
      const missing = r.signals
        .map((s) => s.split(":")[0] ?? s)
        .filter((s) => !["vague", "placeholder_pay"].includes(s) && !fired.has(s));
      expect(missing, r.id).toEqual([]);
    }
  });

  it("break-check: zeroing any single weight that a firm scam row relies on makes the golden test fail", () => {
    for (const key of [
      "upfront_payment",
      "chat_contact",
      "repo_assessment",
      "id_early",
      "personal_email",
    ] as const) {
      const broken: ScamWeights = { ...SCAM_WEIGHTS, [key]: 0 };
      expect(failures(broken), `${key} = 0`).not.toEqual([]);
    }
  });

  it("break-check: without the verification discount a verified legit row no longer scores 0", () => {
    const row = rows.find((r) => r.id === "gs-002");
    if (!row) throw new Error("gs-002 missing from the golden set");
    expect(scoreScam(inputOf(row)).score).toBe(0);
    expect(scoreScam(inputOf(row), { ...SCAM_WEIGHTS, ats_verified: 0 }).score).toBeGreaterThan(0);
  });
});
