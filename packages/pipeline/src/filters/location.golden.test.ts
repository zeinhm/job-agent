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
  /** Set when the label contradicts the card's binding precedence rules; the label itself is kept. */
  disputed: z.string().optional(),
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
  disputed: boolean;
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
      disputed: c.disputed !== undefined,
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
  const gated = rows.filter((r) => !r.disputed);

  it("loads a usable fixture", () => {
    expect(cases.length).toBeGreaterThanOrEqual(50);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const cls of CLASSES)
      expect(
        cases.some((c) => c.expected === cls),
        cls,
      ).toBe(true);
  });

  it("every disputed case is a real mismatch and carries an explanation", () => {
    for (const c of cases) {
      if (c.disputed === undefined) continue;
      const row = rows.find((r) => r.id === c.id);
      expect(c.disputed.length, c.id).toBeGreaterThan(20);
      expect(row?.actual, `${c.id} is marked disputed but matches its label`).not.toBe(c.expected);
    }
  });

  it("every result has a non-empty reason", () => {
    for (const r of rows) expect(r.reason.length, r.id).toBeGreaterThan(0);
  });

  it("meets the accuracy and false-reject gates and prints the confusion matrix", () => {
    const all = stats(rows);
    const g = stats(gated);
    const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
    const report = [
      "",
      `Location golden set: ${rows.length} cases, ${rows.length - gated.length} disputed (listed below)`,
      "",
      `Confusion matrix, all ${rows.length} cases (accuracy ${pct(all.accuracy)}, false rejects ${all.falseRejects.length}):`,
      confusionMatrix(rows),
      "",
      `Confusion matrix, gated ${gated.length} undisputed cases (accuracy ${pct(g.accuracy)}, false rejects ${g.falseRejects.length}):`,
      confusionMatrix(gated),
      "",
      "Misclassified cases:",
      ...rows
        .filter((r) => r.expected !== r.actual)
        .map(
          (r) =>
            `  ${r.id} expected ${r.expected}, got ${r.actual}${r.disputed ? " [disputed]" : " [UNEXPECTED]"}: ${r.reason}`,
        ),
      "",
    ].join("\n");
    console.log(report);

    expect(gated.filter((r) => r.expected !== r.actual).map((r) => r.id)).toEqual([]);
    expect(g.accuracy).toBeGreaterThanOrEqual(MIN_ACCURACY);
    expect(g.falseRejectRate).toBeLessThanOrEqual(MAX_FALSE_REJECT_RATE);
  });
});
