import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const script = join(repo, "bin/run-hourly");
const SKIP = "run-hourly: previous run still active, skipped";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A temp data dir and a stub CLI that appends its command to calls.log; `failOn` makes one command exit 1, `slow` waits for a file. */
function setup(stub = "") {
  const work = mkdtempSync(join(tmpdir(), "job-agent-hourly-test-"));
  dirs.push(work);
  const data = join(work, "data");
  const calls = join(work, "calls.log");
  const cli = join(work, "fake-cli");
  writeFileSync(
    cli,
    `#!/usr/bin/env bash
echo "$1" >> "${calls}"
echo "output of $1"
${stub}
[ "$1" = "$FAIL_ON" ] && exit 1
exit 0
`,
  );
  chmodSync(cli, 0o755);
  const env = { ...process.env, JOB_AGENT_CLI: cli, JOB_AGENT_DATA_DIR: data, FAIL_ON: "" };
  const called = (): string[] =>
    existsSync(calls) ? readFileSync(calls, "utf-8").trim().split("\n") : [];
  return { work, data, env, called, lock: join(data, "locks", "hourly") };
}
const run = (env: NodeJS.ProcessEnv) =>
  spawnSync("bash", [script], { cwd: repo, encoding: "utf-8", env });

describe("bin/run-hourly", () => {
  it("runs discover, process, enrich, resolve-apply, digest in order, each logged to data/logs/<command>.log", () => {
    const s = setup();
    const res = run(s.env);
    expect(res.status).toBe(0);
    expect(s.called()).toEqual(["discover", "process", "enrich", "resolve-apply", "digest"]);
    for (const c of s.called())
      expect(readFileSync(join(s.data, "logs", `${c}.log`), "utf-8")).toBe(`output of ${c}\n`);
    expect(existsSync(s.lock)).toBe(false);
  });

  it("a second concurrent run exits 0 with the skip line and runs nothing", async () => {
    const gate = join(tmpdir(), `job-agent-hourly-gate-${process.pid}`);
    dirs.push(gate);
    const s = setup(
      `[ "$1" = discover ] && { touch "${gate}.started"; while [ ! -e "${gate}.release" ]; do sleep 0.05; done; }`,
    );
    dirs.push(`${gate}.started`, `${gate}.release`);
    const first = spawn("bash", [script], { cwd: repo, env: s.env, stdio: "ignore" });
    const firstDone = new Promise<number | null>((r) => first.on("exit", r));
    for (let i = 0; i < 200 && !existsSync(`${gate}.started`); i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(s.lock)).toBe(true);
    const second = run(s.env);
    expect(second.status).toBe(0);
    expect(second.stdout.trim()).toBe(SKIP);
    expect(s.called()).toEqual(["discover"]); // only the first run's step so far
    writeFileSync(`${gate}.release`, "");
    expect(await firstDone).toBe(0);
    expect(s.called()).toEqual(["discover", "process", "enrich", "resolve-apply", "digest"]);
    expect(existsSync(s.lock)).toBe(false);
  }, 30_000);

  it("keeps a fresh lock and skips", () => {
    const s = setup();
    mkdirSync(s.lock, { recursive: true });
    const res = run(s.env);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(SKIP);
    expect(s.called()).toEqual([]);
    expect(existsSync(s.lock)).toBe(true);
  });

  it("clears a lock older than 3 h with a log line and runs", () => {
    const s = setup();
    mkdirSync(s.lock, { recursive: true });
    const old = new Date(Date.now() - 4 * 3600 * 1000);
    utimesSync(s.lock, old, old);
    const res = run(s.env);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("stale lock");
    expect(res.stdout).not.toContain("skipped");
    expect(s.called()).toHaveLength(5);
    expect(existsSync(s.lock)).toBe(false);
  });

  it("removes the lock after a failing step, still runs the later steps, and exits 1", () => {
    const s = setup();
    const res = run({ ...s.env, FAIL_ON: "enrich" });
    expect(res.status).toBe(1);
    expect(s.called()).toEqual(["discover", "process", "enrich", "resolve-apply", "digest"]);
    expect(existsSync(s.lock)).toBe(false);
  });
});
