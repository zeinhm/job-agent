import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultEnvFile, loadEnvFile } from "./env.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function envFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "job-agent-env-test-"));
  dirs.push(dir);
  const p = join(dir, ".env");
  writeFileSync(p, content);
  return p;
}
function load(path: string, env: NodeJS.ProcessEnv) {
  const lines: string[] = [];
  loadEnvFile((t) => lines.push(t), path, env);
  return lines;
}

describe("loadEnvFile", () => {
  it("loads a missing variable, ignores comments and quotes", () => {
    const env: NodeJS.ProcessEnv = {};
    const err = load(
      envFile('# note\nFAKE_KEY=fake-value-1\nexport FAKE_QUOTED="fake value 2"\n\n'),
      env,
    );
    expect(env.FAKE_KEY).toBe("fake-value-1");
    expect(env.FAKE_QUOTED).toBe("fake value 2");
    expect(err).toEqual([]);
  });

  it("never overwrites a variable already set, even an empty one", () => {
    const env: NodeJS.ProcessEnv = { FAKE_KEY: "from-shell", FAKE_EMPTY: "" };
    load(envFile("FAKE_KEY=from-file\nFAKE_EMPTY=from-file\nFAKE_NEW=from-file\n"), env);
    expect(env).toEqual({ FAKE_KEY: "from-shell", FAKE_EMPTY: "", FAKE_NEW: "from-file" });
  });

  it("is silent for a missing file", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(load(join(tmpdir(), "job-agent-no-such-dir", ".env"), env)).toEqual([]);
    expect(env).toEqual({});
  });

  it("reports one line naming the file for an invalid line, without any value", () => {
    const env: NodeJS.ProcessEnv = {};
    const path = envFile(
      "FAKE_A=secret-value-aaa\nthis is secret-value-bbb\nFAKE_C=secret-value-ccc\n",
    );
    const err = load(path, env);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain(path);
    expect(err[0]).not.toMatch(/secret-value|FAKE_/);
    expect(env.FAKE_A).toBe("secret-value-aaa");
    expect(env.FAKE_C).toBe("secret-value-ccc");
  });

  it("reports one line naming the file when it cannot be read, and continues", () => {
    const dir = mkdtempSync(join(tmpdir(), "job-agent-env-test-"));
    dirs.push(dir);
    const err = load(dir, {}); // a directory: EISDIR, not ENOENT
    expect(err).toHaveLength(1);
    expect(err[0]).toContain(dir);
  });

  it("prints no key, value or count in any message", () => {
    const path = envFile("FAKE_A=secret-value-aaa\n=oops-value\n???\n");
    const err = load(path, {}).join("").replace(path, "<file>");
    expect(err).not.toMatch(/secret-value|oops-value|FAKE_A|\d/);
  });
});

describe("defaultEnvFile", () => {
  it("honours JOB_AGENT_ENV_FILE, else <repo root>/.env regardless of cwd", () => {
    expect(defaultEnvFile({ JOB_AGENT_ENV_FILE: "/x/y.env" })).toBe("/x/y.env");
    expect(defaultEnvFile({})).toMatch(/\/\.env$/);
    expect(defaultEnvFile({})).not.toContain("packages");
  });
});
