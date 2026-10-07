import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { classifyIndonesia } from "./indonesia.ts";

const CLASSES = ["not_applicable", "foreign_hiring_id", "domestic", "unclear"] as const;

const GoldenCase = z.object({
  id: z.string(),
  company: z.string(),
  locationText: z.string(),
  descriptionText: z.string(),
  companyHqCountry: z.string().nullable(),
  companyDomain: z.string().nullable(),
  salaryCurrency: z.string().nullable(),
  expected: z.enum(CLASSES),
  judgment: z.boolean(),
  source: z.string(),
});

const cases = z
  .array(GoldenCase)
  .parse(
    JSON.parse(
      readFileSync(new URL("../../../../fixtures/golden/indonesia.json", import.meta.url), "utf8"),
    ),
  );

const rows = cases.map((c) => ({ c, result: classifyIndonesia(c) }));
const line = (r: (typeof rows)[number]) =>
  `  ${r.c.id} (${r.c.company}) expected ${r.c.expected}, got ${r.result.value}: ${r.result.reason}`;

describe("indonesia golden set", () => {
  it("loads a usable fixture", () => {
    expect(cases.length).toBeGreaterThanOrEqual(15);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const cls of CLASSES)
      expect(
        cases.some((c) => c.expected === cls),
        cls,
      ).toBe(true);
  });

  it("every result has a non-empty reason", () => {
    for (const r of rows) expect(r.result.reason.length, r.c.id).toBeGreaterThan(0);
  });

  it("matches 100% of cases not marked judgment", () => {
    const firm = rows.filter((r) => !r.c.judgment);
    expect(firm.length).toBeGreaterThan(0);
    expect(firm.filter((r) => r.c.expected !== r.result.value).map(line)).toEqual([]);
  });

  it("prints judgment cases", () => {
    const judgment = rows.filter((r) => r.c.judgment);
    console.log(
      [
        "",
        `Indonesia golden set: ${rows.length} cases`,
        "Judgment cases:",
        ...judgment.map(line),
        "",
      ].join("\n"),
    );
    expect(judgment.length).toBeGreaterThan(0);
  });
});
