import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { normalizeCompanyName } from "./company.ts";

const rows = z
  .array(z.object({ a: z.string(), b: z.string(), same: z.boolean(), note: z.string().min(1) }))
  .parse(JSON.parse(readFileSync(new URL("./company.golden.json", import.meta.url), "utf8")));

describe("company name golden rows", () => {
  it("has at least 30 rows with both outcomes", () => {
    expect(rows.length).toBeGreaterThanOrEqual(30);
    expect(rows.some((r) => r.same)).toBe(true);
    expect(rows.some((r) => !r.same)).toBe(true);
  });

  it.each(rows.map((r) => [`${r.a} | ${r.b}`, r] as const))("%s", (_label, r) => {
    const a = normalizeCompanyName(r.a);
    const b = normalizeCompanyName(r.b);
    expect(a).not.toBe("");
    expect(b).not.toBe("");
    if (r.same) expect(a).toBe(b);
    else expect(a).not.toBe(b);
  });
});
