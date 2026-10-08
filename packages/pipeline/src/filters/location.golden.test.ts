import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { classifyLocation, type LocationClass } from "./location.ts";

const CLASSES = ["worldwide", "apac_ok", "restricted", "unclear"] as const;

const GoldenCase = z.object({
  id: z.string(),
  locationText: z.string(),
  descriptionSnippet: z.string(),
  expected: z.enum(CLASSES),
  source: z.string(),
  added: z.literal("phase2").optional(),
});

const cases = z
  .array(GoldenCase)
  .parse(
    JSON.parse(
      readFileSync(new URL("../../../../fixtures/golden/location.json", import.meta.url), "utf8"),
    ),
  );

const MIN_ACCURACY = 0.9;
const MAX_FALSE_REJECT_RATE = 0.02;

type Row = {
  id: string;
  expected: LocationClass;
  actual: LocationClass;
  reason: string;
};

function run(): Row[] {
  return cases.map((c) => {
    const result = classifyLocation({
      locationText: c.locationText,
      descriptionText: c.descriptionSnippet,
    });
    return {
      id: c.id,
      expected: c.expected,
      actual: result.class,
      reason: result.reason,
    };
  });
}

function confusionMatrix(rows: Row[]): string {
  const width = 11;
  const cell = (s: string | number) => String(s).padEnd(width);
  const lines = [cell("expected\\got") + CLASSES.map(cell).join("")];
  for (const exp of CLASSES) {
    const counts = CLASSES.map(
      (act) => rows.filter((r) => r.expected === exp && r.actual === act).length,
    );
    lines.push(cell(exp) + counts.map(cell).join(""));
  }
  return lines.join("\n");
}

function stats(rows: Row[]) {
  const correct = rows.filter((r) => r.expected === r.actual).length;
  const notRestricted = rows.filter((r) => r.expected !== "restricted");
  const falseRejects = notRestricted.filter((r) => r.actual === "restricted");
  return {
    accuracy: correct / rows.length,
    falseRejects,
    falseRejectRate: falseRejects.length / notRestricted.length,
  };
}

describe("location golden set", () => {
  const rows = run();

  it("loads a usable fixture", () => {
    expect(cases.length).toBeGreaterThanOrEqual(50);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const cls of CLASSES)
      expect(
        cases.some((c) => c.expected === cls),
        cls,
      ).toBe(true);
  });

  it("has at least 15 phase2 rows", () => {
    expect(cases.filter((c) => c.added === "phase2").length).toBeGreaterThanOrEqual(15);
  });

  it("every result has a non-empty reason", () => {
    for (const r of rows) expect(r.reason.length, r.id).toBeGreaterThan(0);
  });

  it("meets the accuracy and false-reject gates and prints the confusion matrix", () => {
    const s = stats(rows);
    const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
    const report = [
      "",
      `Location golden set: ${rows.length} cases`,
      "",
      `Confusion matrix (accuracy ${pct(s.accuracy)}, false rejects ${s.falseRejects.length}):`,
      confusionMatrix(rows),
      "",
      "Misclassified cases:",
      ...rows
        .filter((r) => r.expected !== r.actual)
        .map((r) => `  ${r.id} expected ${r.expected}, got ${r.actual}: ${r.reason}`),
      "",
    ].join("\n");
    console.log(report);

    expect(rows.filter((r) => r.expected !== r.actual).map((r) => r.id)).toEqual([]);
    expect(s.accuracy).toBeGreaterThanOrEqual(MIN_ACCURACY);
    expect(s.falseRejectRate).toBeLessThanOrEqual(MAX_FALSE_REJECT_RATE);
  });
});
