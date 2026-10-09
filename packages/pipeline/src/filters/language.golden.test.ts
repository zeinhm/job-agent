import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { classifyLanguage } from "./language.ts";

const GoldenCase = z.object({
  id: z.string(),
  title: z.string(),
  snippet: z.string(),
  label: z.enum(["ok", "reject"]),
  reason: z.string(),
  source: z.string().min(1),
});

const cases = z
  .array(GoldenCase)
  .parse(
    JSON.parse(
      readFileSync(new URL("../../../../fixtures/golden/language.json", import.meta.url), "utf8"),
    ),
  );

describe("language golden set", () => {
  it("loads a usable fixture", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(cases.some((c) => c.label === "ok")).toBe(true);
    expect(cases.some((c) => c.label === "reject")).toBe(true);
  });

  it("passes 100% of rows", () => {
    const wrong = cases
      .map((c) => ({ c, r: classifyLanguage({ title: c.title, descriptionText: c.snippet }) }))
      .filter(({ c, r }) => r.class !== c.label)
      .map(({ c, r }) => `${c.id} "${c.title}": expected ${c.label}, got ${r.class} (${r.reason})`);
    expect(wrong).toEqual([]);
  });
});
