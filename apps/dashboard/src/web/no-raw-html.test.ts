import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Backs up the ESLint rule: posting text is rendered as text only (phase-4-conventions section 4).
describe("no raw HTML rendering", () => {
  it("never uses the React raw-HTML prop anywhere in src/web", () => {
    const banned = ["dangerously", "SetInnerHTML"].join("");
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(
      (f) => /\.(tsx?|jsx?|html)$/.test(f) && !f.endsWith("no-raw-html.test.ts"),
    );
    expect(files.length).toBeGreaterThan(5);
    expect(files.filter((f) => readFileSync(`${dir}/${f}`, "utf8").includes(banned))).toEqual([]);
  });
});
