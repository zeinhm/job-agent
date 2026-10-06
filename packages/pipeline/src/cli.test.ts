import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAdapters } from "@job-agent/sources";
import { main } from "./cli.ts";

vi.mock("@job-agent/sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@job-agent/sources")>();
  return { ...actual, buildAdapters: vi.fn(actual.buildAdapters) };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

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

describe("discover command", () => {
  const exampleDir = join(dirname(fileURLToPath(import.meta.url)), "../../../config");

  function withEnv(): string {
    const dir = mkdtempSync(join(tmpdir(), "job-agent-cli-"));
    copyFileSync(join(exampleDir, "salary.example.yaml"), join(dir, "salary.yaml"));
    copyFileSync(join(exampleDir, "companies.example.yaml"), join(dir, "companies.yaml"));
    vi.stubEnv("JOB_AGENT_CONFIG_DIR", dir);
    vi.stubEnv("JOB_AGENT_DB", ":memory:");
    return dir;
  }

  it("exits 1 with the valid names for an unknown --source", async () => {
    const dir = withEnv();
    try {
      const c = capture();
      expect(await main(["discover", "--source", "nope"], c.io)).toBe(1);
      expect(c.err.join("")).toContain("Unknown source: nope");
      expect(c.err.join("")).toContain("Valid sources:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 0 when no adapter is registered and none is requested", async () => {
    const dir = withEnv();
    try {
      vi.mocked(buildAdapters).mockReturnValueOnce([]);
      const c = capture();
      expect(await main(["discover", "--force"], c.io)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
