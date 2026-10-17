import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ANSWER_KEYS, isAnswerKey } from "./answer-keys.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCANNED_DIRS = ["apps", "packages", "bin", "scripts"];
const SKIP_DIRS = new Set(["node_modules", ".venv", "dist", "coverage", ".git"]);
const SCANNED_EXT = /\.(ts|tsx|js|mjs|sh|yaml|yml)$/;

// Groups of the real bank plus the groups earlier code invented: a literal "<group>.<name>" in any of them must be a real key.
const GROUPS = new Set([
  ...ANSWER_KEYS.map((k) => k.split(".")[0] as string),
  "identity",
  "availability",
  "legal",
  "links",
  "preferences",
  "personal",
  "demographics",
  "compensation",
  "salary_expectations",
  "address",
  "social",
  "work",
]);
const KEY_LITERAL = new RegExp(`["'\`]((?:${[...GROUPS].join("|")})\\.[a-z][a-z0-9_]*)["'\`]`, "g");

function* sourceFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* sourceFiles(join(dir, e.name));
    } else if (SCANNED_EXT.test(e.name)) yield join(dir, e.name);
  }
}

describe("answer-keys.json is the key contract", () => {
  it("lists unique, well-formed keys", () => {
    expect(new Set(ANSWER_KEYS).size).toBe(ANSWER_KEYS.length);
    for (const k of ANSWER_KEYS) expect(k).toMatch(/^[a-z_]+\.[a-z0-9_]+$/);
    expect(isAnswerKey("contact.email")).toBe(true);
    expect(isAnswerKey(["contact", "mail"].join("."))).toBe(false);
  });

  it("every answer key literal in code, tests and fixtures is in the list", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const d of SCANNED_DIRS) {
      for (const file of sourceFiles(join(ROOT, d))) {
        scanned++;
        const text = readFileSync(file, "utf8");
        for (const m of text.matchAll(KEY_LITERAL)) {
          const key = m[1] as string;
          if (!isAnswerKey(key)) offenders.push(`${relative(ROOT, file)}: ${key}`);
        }
      }
    }
    expect(scanned).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });
});
