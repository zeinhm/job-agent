import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { classifyRole, type RoleClass } from "./role.ts";

const CLASSES = ["keep", "reject", "unclear"] as const;

const GoldenCase = z.object({
  id: z.string(),
  title: z.string(),
  snippet: z.string(),
  label: z.enum(CLASSES),
  reason: z.string(),
  judgment: z.boolean().optional(),
  source: z.string(),
});

const cases = z
  .array(GoldenCase)
  .parse(
    JSON.parse(
      readFileSync(
        new URL("../../../../fixtures/golden/role-relevance.json", import.meta.url),
        "utf8",
      ),
    ),
  );

type Row = {
  id: string;
  title: string;
  expected: RoleClass;
  actual: RoleClass;
  reason: string;
  judgment: boolean;
};

const rows: Row[] = cases.map((c) => {
  const result = classifyRole({ title: c.title, descriptionText: c.snippet });
  return {
    id: c.id,
    title: c.title,
    expected: c.label,
    actual: result.class,
    reason: result.reason,
    judgment: c.judgment === true,
  };
});

function confusionMatrix(list: Row[]): string {
  const cell = (s: string | number) => String(s).padEnd(11);
  const lines = [cell("expected\\got") + CLASSES.map(cell).join("")];
  for (const exp of CLASSES) {
    lines.push(
      cell(exp) +
        CLASSES.map((act) => list.filter((r) => r.expected === exp && r.actual === act).length)
          .map(cell)
          .join(""),
    );
  }
  return lines.join("\n");
}

describe("role relevance golden set", () => {
  it("loads a usable fixture", () => {
    expect(cases.length).toBeGreaterThanOrEqual(60);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const cls of CLASSES)
      expect(
        cases.some((c) => c.label === cls),
        cls,
      ).toBe(true);
    expect(cases.some((c) => c.judgment === true)).toBe(true);
  });

  it("every result has a non-empty reason", () => {
    for (const r of rows) expect(r.reason.length, r.id).toBeGreaterThan(0);
  });

  it("passes 100% of non-judgment rows and reports the judgment rows", () => {
    const firm = rows.filter((r) => !r.judgment);
    const judged = rows.filter((r) => r.judgment);
    console.log(
      [
        "",
        `Role golden set: ${rows.length} cases (${firm.length} firm, ${judged.length} judgment)`,
        "",
        "Confusion matrix (firm rows):",
        confusionMatrix(firm),
        "",
        "Judgment rows (reported, not gated):",
        ...judged.map(
          (r) =>
            `  ${r.id} "${r.title}" expected ${r.expected}, got ${r.actual} ` +
            `${r.expected === r.actual ? "(agrees)" : "(DIFFERS)"}: ${r.reason}`,
        ),
        "",
      ].join("\n"),
    );
    expect(
      firm.filter((r) => r.expected !== r.actual).map((r) => `${r.id} ${r.title}: ${r.actual}`),
    ).toEqual([]);
  });
});
