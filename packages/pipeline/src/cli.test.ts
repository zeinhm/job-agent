import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "./cli.ts";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
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

  it("exits 0 when every registered adapter returns no postings", async () => {
    server.use(
      http.get("https://himalayas.app/jobs/api", () =>
        HttpResponse.json({ jobs: [], nextCursor: null }),
      ),
    );
    const dir = withEnv();
    try {
      const c = capture();
      expect(await main(["discover", "--force"], c.io)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
