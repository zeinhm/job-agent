import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const pnpmfile = resolve(import.meta.dirname, "../../../.pnpmfile.cjs");
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pnpmfile-test-"));
  dirs.push(dir);
  return dir;
}

function load(cwd: string) {
  return spawnSync(process.execPath, ["-e", `require(${JSON.stringify(pnpmfile)})`], {
    cwd,
    encoding: "utf8",
  });
}

function hooksPath(cwd: string): string {
  return spawnSync("git", ["config", "--get", "core.hooksPath"], {
    cwd,
    encoding: "utf8",
  }).stdout.trim();
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe(".pnpmfile.cjs (runs on every pnpm install, even no-op ones)", () => {
  it("sets core.hooksPath to .githooks in a git repo", () => {
    const repo = tempDir();
    spawnSync("git", ["init", "-q"], { cwd: repo });
    expect(hooksPath(repo)).toBe("");
    expect(load(repo).status).toBe(0);
    expect(hooksPath(repo)).toBe(".githooks");
  });

  it("is a harmless no-op outside a git repo", () => {
    const dir = tempDir();
    const result = load(dir);
    expect(result.status).toBe(0);
    expect(hooksPath(dir)).toBe("");
  });
});
