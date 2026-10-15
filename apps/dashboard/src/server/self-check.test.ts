import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDb } from "@job-agent/core";
import { parseArgs } from "./args.ts";
import { selfCheck } from "./self-check.ts";

const mainTs = join(dirname(fileURLToPath(import.meta.url)), "main.ts");

describe("selfCheck", () => {
  it("prints one line per request and returns 0 on a healthy DB", async () => {
    const lines: string[] = [];
    const code = await selfCheck(openDb(":memory:"), (l) => lines.push(l));
    expect(code).toBe(0);
    expect(lines).toEqual(["self-check /api/health 200", "self-check /api/queue 200 items=0"]);
  });

  it("returns 1 when a request fails", async () => {
    const db = openDb(":memory:");
    db.$client.close();
    const lines: string[] = [];
    const code = await selfCheck(db, (l) => lines.push(l));
    expect(code).toBe(1);
    expect(lines).toContain("self-check /api/health 503");
  });
});

describe("main.ts --self-check", () => {
  it("exits 0 and prints the check line, on a throwaway DB", () => {
    const work = mkdtempSync(join(tmpdir(), "dash-selfcheck-"));
    try {
      const res = spawnSync("pnpm", ["-s", "exec", "tsx", mainTs, "--self-check"], {
        encoding: "utf-8",
        env: { ...process.env, JOB_AGENT_DB: join(work, "t.db") },
      });
      expect(res.stdout.trim().split("\n")).toEqual([
        "self-check /api/health 200",
        "self-check /api/queue 200 items=0",
      ]);
      expect(res.status).toBe(0);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it("exits 2 with usage on an unknown flag (no way to pick a host)", () => {
    const res = spawnSync("pnpm", ["-s", "exec", "tsx", mainTs, "--host", "0.0.0.0"], {
      encoding: "utf-8",
      env: { ...process.env, JOB_AGENT_DB: ":memory:" },
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("usage: pnpm dashboard");
  }, 30_000);
});

describe("parseArgs", () => {
  it("defaults to port 4510", () => {
    expect(parseArgs([])).toEqual({ port: 4510, selfCheck: false });
  });
  it("reads --port and --self-check", () => {
    expect(parseArgs(["--port", "4511", "--self-check"])).toEqual({ port: 4511, selfCheck: true });
  });
  it("rejects bad ports and unknown flags", () => {
    for (const argv of [
      ["--port"],
      ["--port", "x"],
      ["--port", "0"],
      ["--port", "70000"],
      ["--host", "0.0.0.0"],
    ]) {
      expect(parseArgs(argv)).toBeUndefined();
    }
  });
});
