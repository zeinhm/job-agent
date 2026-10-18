import { describe, expect, it } from "vitest";
import { MAX_PRINTED, errorLine, errorWhere, refusalLine, sanitizeText } from "./safe-output.ts";

describe("sanitizeText", () => {
  it("removes control characters, newlines and Unicode line separators: a page cannot forge a line", () => {
    const forged = "Why us?\ndry-run: status=filled\r  \u0000\u001b[31m​ end";
    const text = sanitizeText(forged);
    expect(text).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(text).toBe("Why us?dry-run: status=filled[31m end");
  });

  it(`cuts at ${MAX_PRINTED} characters`, () => {
    expect(sanitizeText("a".repeat(500))).toHaveLength(MAX_PRINTED);
    expect(sanitizeText("short")).toBe("short");
  });
});

describe("error printing", () => {
  it("prints the command, the error name and the top frame path:line, never the message or stack text", () => {
    const e = new TypeError('fill("SECRET") failed');
    const line = errorLine("dry-run", e);
    expect(line).toMatch(
      /^dry-run: error TypeError at packages\/apply\/src\/dryrun\/safe-output\.test\.ts:\d+\n$/,
    );
    expect(line).not.toContain("SECRET");
  });

  it("cuts the path to start at node_modules/ and drops file://", () => {
    const e = new Error("msg");
    e.stack =
      "Error: msg\n    at f (file:///Users/someone/proj/node_modules/.pnpm/pw/lib/a.js:12:5)";
    expect(errorWhere(e)).toBe("Error at node_modules/.pnpm/pw/lib/a.js:12");
  });

  it("falls back to the bare file name outside apps/, packages/ and node_modules/, and to the name without a frame", () => {
    const e = new Error("msg");
    e.stack = "Error: msg\n    at /tmp/elsewhere/a.js:3:1";
    expect(errorWhere(e)).toBe("Error at a.js:3");
    e.stack = "Error: SECRET";
    expect(errorWhere(e)).toBe("Error");
  });

  it("a message line that looks like a stack frame is never read as the frame", () => {
    for (const msg of [
      "typed\n    at x (SECRETVALUE:12:3)",
      "a\n    at SECRETTWO:5:1",
      "Error",
      "\n    at SECRETTHREE:1:1",
    ]) {
      const where = errorWhere(new Error(msg));
      expect(where).not.toContain("SECRET");
      expect(where).toMatch(/^Error at packages\/apply\/src\/dryrun\/safe-output\.test\.ts:\d+$/);
    }
    expect(errorWhere(new Error(""))).toMatch(/^Error at packages\//);
    const forged = new Error("a\n    at SECRETFOUR:1:1");
    forged.stack = "Error: other\n    at SECRETFOUR:1:1"; // message missing from the stack
    expect(errorWhere(forged)).toBe("Error");
  });

  it("non-Errors print NonError; a forged name prints Error", () => {
    expect(errorWhere("SECRET")).toBe("NonError");
    expect(errorWhere(null)).toBe("NonError");
    expect(errorWhere({ name: "x", message: "SECRET" })).toBe("NonError");
    const e = new Error("x");
    e.name = "Evil\nname";
    expect(errorWhere(e)).toMatch(/^Error( at |$)/);
  });

  it("a refusal is one sanitised line", () => {
    expect(refusalLine("dry-run", "no posting a\nb")).toBe("dry-run: refused: no posting ab\n");
  });
});
