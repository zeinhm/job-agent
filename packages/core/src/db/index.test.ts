import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDbPath, openDb } from "./index.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("openDb", () => {
  it("opens an in-memory database and applies migrations", () => {
    const db = openDb(":memory:");
    expect(db.$client.open).toBe(true);
    expect(db.$client.pragma("user_version", { simple: true })).toBe(0);
    db.$client.close();
  });

  it("creates the parent directory of a file path", () => {
    const dir = mkdtempSync(join(tmpdir(), "job-agent-"));
    try {
      const file = join(dir, "nested", "deeper", "test.db");
      const db = openDb(file);
      db.$client.close();
      expect(existsSync(file)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("defaultDbPath", () => {
  it("falls back to data/job-agent.db", () => {
    vi.stubEnv("JOB_AGENT_DB", undefined);
    expect(defaultDbPath()).toBe("data/job-agent.db");
  });

  it("honours JOB_AGENT_DB", () => {
    vi.stubEnv("JOB_AGENT_DB", "/tmp/custom.db");
    expect(defaultDbPath()).toBe("/tmp/custom.db");
  });
});
