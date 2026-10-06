import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fx_rates, openDb } from "@job-agent/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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
      const c = capture();
      expect(await main(["discover", "--force"], c.io)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fx command", () => {
  const fixture = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../core/test/fixtures/fx/er-api-usd.json"),
    "utf-8",
  );

  function withDb(): { dir: string; db: string } {
    const dir = mkdtempSync(join(tmpdir(), "job-agent-fx-"));
    const db = join(dir, "t.db");
    vi.stubEnv("JOB_AGENT_DB", db);
    return { dir, db };
  }

  function countRows(path: string): number {
    const db = openDb(path);
    try {
      return db.select().from(fx_rates).all().length;
    } finally {
      db.$client.close();
    }
  }

  it("stores the fixture rates, prints them, and is idempotent", async () => {
    const { dir, db } = withDb();
    try {
      vi.stubGlobal("fetch", async () => new Response(fixture, { status: 200 }));
      const c = capture();
      expect(await main(["fx"], c.io)).toBe(0);
      expect(c.out.join("")).toContain("2026-10-06 USD/IDR 17892.583535");
      expect(countRows(db)).toBe(7);
      expect(await main(["fx"], capture().io)).toBe(0);
      expect(countRows(db)).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 with the error and writes no rows on HTTP failure", async () => {
    const { dir, db } = withDb();
    try {
      vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
      const c = capture();
      expect(await main(["fx"], c.io)).toBe(1);
      expect(c.err.join("")).toContain("fx failed");
      expect(countRows(db)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
