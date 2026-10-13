import { readFileSync } from "node:fs";
import { outputConfigFor } from "@job-agent/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CompanyResearchWireSchema, toCompanyResearch } from "./company-research.ts";
import { ExtractionSchema, ExtractionWireSchema, toExtraction } from "./extract.ts";
import { FitSchema } from "./fit.ts";

/** The API rejects more than 16 union-typed parameters (HTTP 400); we keep headroom. */
const MAX_UNIONS = 12;

/** Counts nodes with a type array or anyOf/oneOf at every depth. */
function countUnions(node: unknown): number {
  if (Array.isArray(node)) return node.reduce<number>((n, v) => n + countUnions(v), 0);
  if (node === null || typeof node !== "object") return 0;
  const obj = node as Record<string, unknown>;
  const own = Array.isArray(obj["type"]) || "anyOf" in obj || "oneOf" in obj ? 1 : 0;
  return own + Object.values(obj).reduce<number>((n, v) => n + countUnions(v), 0);
}

const unionsIn = (schema: z.ZodType): number => countUnions(outputConfigFor(schema).format.schema);

describe("structured-output schemas sent to the API", () => {
  it.each([
    ["extraction", ExtractionWireSchema],
    ["fit", FitSchema],
    ["company pay-policy research", CompanyResearchWireSchema],
  ])("%s has at most %i union-typed parameters", (_name, schema) => {
    expect(unionsIn(schema)).toBeLessThanOrEqual(MAX_UNIONS);
  });

  it("the counter catches the old nullable extraction schema (18)", () => {
    expect(unionsIn(ExtractionSchema)).toBe(18);
  });
});

describe("wire output maps back to the stored values", () => {
  const text = (name: string): unknown => {
    const msg = JSON.parse(
      readFileSync(new URL(`../../test/fixtures/anthropic/${name}`, import.meta.url), "utf-8"),
    ) as { content: { text: string }[] };
    return JSON.parse(msg.content[0]?.text ?? "null");
  };

  it("extraction: unknown/yes/no/''/0 become null/true/false/null/null", () => {
    const got = toExtraction(ExtractionWireSchema.parse(text("extract-ok.json")));
    expect(ExtractionSchema.parse(got)).toEqual(got);
    expect(got).toMatchObject({
      listedSalary: { min: 90000, max: 130000, currency: "USD", period: "year" },
      indonesiaExplicit: null,
      eorProvider: null,
      personalEmailDomain: null,
      asksForPaymentOrId: false,
      repoAssessmentEarly: null,
      companyHq: "DE",
      employment: "contractor",
      roleFamily: "fullstack",
    });
  });

  it("extraction: roleFamily 'unknown' becomes null and every family passes through", () => {
    const base = text("extract-ok.json") as object;
    const family = (roleFamily: string) =>
      toExtraction(ExtractionWireSchema.parse({ ...base, roleFamily })).roleFamily;
    expect(family("unknown")).toBeNull();
    expect(family("design")).toBe("design");
    expect(() => ExtractionWireSchema.parse({ ...base, roleFamily: "engineering" })).toThrow();
  });

  it("extraction: a one-sided salary keeps the missing bound null", () => {
    const wire = ExtractionWireSchema.parse({
      ...(text("extract-ok.json") as object),
      listedSalary: { min: 50000, max: 0, currency: "USD", period: "year" },
    });
    expect(toExtraction(wire).listedSalary).toEqual({
      min: 50000,
      max: null,
      currency: "USD",
      period: "year",
    });
  });

  it("research: empty quote and unknown classification become null", () => {
    expect(
      toCompanyResearch(CompanyResearchWireSchema.parse(text("company-research-none.json"))),
    ).toEqual({
      quote: null,
      classification: null,
    });
  });
});
