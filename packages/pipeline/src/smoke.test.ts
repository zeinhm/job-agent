import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A fake CLI that logs its calls: `discover --source remotive` fails, everything else succeeds.
function run(env: Record<string, string> = {}) {
  const work = mkdtempSync(join(tmpdir(), "job-agent-smoke-test-"));
  dirs.push(work);
  const cli = join(work, "fake-cli");
  const log = join(work, "calls.log");
  writeFileSync(
    cli,
    `#!/usr/bin/env bash
[ $# -eq 0 ] && exit 0 # usage probe
echo "$* | DB=$JOB_AGENT_DB CFG=$JOB_AGENT_CONFIG_DIR KEY=\${ANTHROPIC_API_KEY:-}" >> "${log}"
if [ "$1" = discover ] && [ "$4" = remotive ]; then echo "remotive: error, boom"; exit 1; fi
if [ "$1" = process ] && [ -n "$FAIL_PROCESS" ]; then exit 1; fi
if [ "$1" = digest ]; then echo "$3/2026-01-01.md"; fi
exit 0
`,
  );
  chmodSync(cli, 0o755);
  const smokeDir = join(work, "smoke");
  const res = spawnSync("bash", [join(repo, "bin/smoke"), smokeDir], {
    cwd: repo,
    encoding: "utf-8",
    env: {
      ...process.env,
      WEB3_CAREER_TOKEN: "",
      ANTHROPIC_API_KEY: "sk-x",
      JOB_AGENT_CLI: cli,
      ...env,
    },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n") : [];
  return { res, calls, smokeDir };
}

describe("bin/smoke", () => {
  it("polls each keyless source one by one, keeps going after a failure, and exits 0", () => {
    const { res, calls } = run();
    expect(res.status).toBe(0);
    const discovered = calls.filter((c) => c.startsWith("discover")).map((c) => c.split(" ")[3]);
    expect(discovered).toEqual([
      "himalayas",
      "remoteok",
      "remotive",
      "weworkremotely",
      "hn",
      "arbeitnow",
      "greenhouse",
    ]);
    for (const c of calls.filter((c) => c.startsWith("discover"))) expect(c).toContain("--force");
    const order = calls.map((c) => c.split(" ")[0]);
    expect(order.slice(-3)).toEqual(["process", "digest", "status"]);
    expect(res.stdout).toContain("remotive: error, boom");
    expect(res.stdout).toContain("web3career: skipped");
  });

  it("writes the digest inside the smoke dir and uses only the temp DB and config", () => {
    const { calls, smokeDir, res } = run();
    const digest = calls.find((c) => c.startsWith("digest"));
    expect(digest).toContain(`--out-dir ${smokeDir}/digests`);
    expect(res.stdout).toContain(`digests: ${smokeDir}/digests`);
    for (const c of calls) {
      expect(c).toContain(`DB=${smokeDir}/smoke.db`);
      expect(c).toContain(`CFG=${smokeDir}/config`);
      expect(c).not.toContain("KEY=sk-x");
    }
    expect(existsSync(join(smokeDir, "config", "salary.yaml"))).toBe(true);
    expect(readFileSync(join(smokeDir, "config", "companies.yaml"), "utf-8")).toBe(
      "companies:\n  - { name: GitLab, ats: greenhouse, slug: gitlab }\n",
    );
  });

  it("polls web3career only when its token is already set", () => {
    const { calls } = run({ WEB3_CAREER_TOKEN: "t" });
    expect(calls.filter((c) => c.includes("--source web3career"))).toHaveLength(1);
  });

  it("exits 1 when process fails but still tries the digest", () => {
    const { res, calls } = run({ FAIL_PROCESS: "1" });
    expect(res.status).toBe(1);
    expect(calls.some((c) => c.startsWith("digest"))).toBe(true);
  });
});
