import { describe, expect, it } from "vitest";
import { main } from "./cli.ts";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) } };
}

describe("main", () => {
  it("prints usage and returns 1 for an unknown command", async () => {
    const c = capture();
    expect(await main(["foo"], c.io)).toBe(1);
    expect(c.err.join("")).toContain("Unknown command: foo");
    expect(c.err.join("")).toContain("Usage: job-agent");
  });

  it("prints usage and returns 1 when no command is given", async () => {
    const c = capture();
    expect(await main([], c.io)).toBe(1);
    expect(c.err.join("")).toContain("Usage: job-agent");
  });
});
