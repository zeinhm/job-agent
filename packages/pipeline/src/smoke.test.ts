import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
function run(env: Record<string, string> = {}, flags: string[] = []) {
  const work = mkdtempSync(join(tmpdir(), "job-agent-smoke-test-"));
  dirs.push(work);
  const cli = join(work, "fake-cli");
  const log = join(work, "calls.log");
  const dash = join(work, "fake-dash");
  writeFileSync(
    cli,
    `#!/usr/bin/env bash
[ $# -eq 0 ] && { printf 'Usage:\\n  enrich\\n  resolve-apply\\n  fetch-questions\\n'; exit 0; } # usage probe
echo "$* | DB=$JOB_AGENT_DB CFG=$JOB_AGENT_CONFIG_DIR ENVFILE=$JOB_AGENT_ENV_FILE KEY=\${ANTHROPIC_API_KEY:-} BRAVE=\${BRAVE_API_KEY:-}" >> "${log}"
if [ "$1" = discover ] && [ "$4" = remotive ]; then echo "remotive: error, boom"; exit 1; fi
if [ "$1" = process ] && [ -n "$FAIL_PROCESS" ]; then exit 1; fi
if [ "$1" = digest ]; then echo "$3/2026-01-01.md"; fi
exit 0
`,
  );
  chmodSync(cli, 0o755);
  // The dashboard command logs into the same file as "dashboard <args>"; FAIL_DASH makes the self-check fail.
  writeFileSync(
    dash,
    `#!/usr/bin/env bash
echo "dashboard $* | DB=$JOB_AGENT_DB CFG=$JOB_AGENT_CONFIG_DIR ENVFILE=$JOB_AGENT_ENV_FILE KEY=\${ANTHROPIC_API_KEY:-} BRAVE=\${BRAVE_API_KEY:-}" >> "${log}"
[ -n "$FAIL_DASH" ] && exit 1
exit 0
`,
  );
  chmodSync(dash, 0o755);
  const smokeDir = join(work, "smoke");
  const res = spawnSync("bash", [join(repo, "bin/smoke"), ...flags, smokeDir], {
    cwd: repo,
    encoding: "utf-8",
    env: {
      ...process.env,
      WEB3_CAREER_TOKEN: "",
      ANTHROPIC_API_KEY: "sk-x",
      JOB_AGENT_CLI: cli,
      JOB_AGENT_DASH_CLI: dash,
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
      "linkedin_posts",
    ]);
    for (const c of calls.filter((c) => c.startsWith("discover"))) expect(c).toContain("--force");
    const order = calls.map((c) => c.split(" ")[0]);
    expect(order.slice(-9)).toEqual([
      "process",
      "enrich",
      "resolve-apply",
      "answers",
      "fetch-questions",
      "match-questions",
      "digest",
      "dashboard",
      "status",
    ]);
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

  it("never polls linkedin or indeed without --with-jobspy", () => {
    const { calls, res } = run();
    const sources = calls.filter((c) => c.startsWith("discover")).map((c) => c.split(" ")[3]);
    expect(sources).not.toContain("linkedin");
    expect(sources).not.toContain("indeed");
    expect(res.stdout).not.toContain("linkedin:");
    expect(res.stdout).not.toContain("indeed");
  });

  it("runs resolve-apply after enrich and before the digest", () => {
    const { calls } = run();
    const order = calls.map((c) => c.split(" ")[0]);
    expect(order.indexOf("enrich")).toBeGreaterThan(order.indexOf("process"));
    expect(order.indexOf("resolve-apply")).toBe(order.indexOf("enrich") + 1);
    expect(order.indexOf("answers")).toBe(order.indexOf("resolve-apply") + 1);
    expect(order.indexOf("fetch-questions")).toBe(order.indexOf("answers") + 1);
    expect(order.indexOf("match-questions")).toBe(order.indexOf("fetch-questions") + 1);
    expect(order.indexOf("digest")).toBe(order.indexOf("match-questions") + 1);
  });

  it("runs answers import, match-questions and dashboard --self-check on the temp DB, no keys", () => {
    const { calls, smokeDir, res } = run({ BRAVE_API_KEY: "brave-x" });
    expect(res.status).toBe(0);
    const imp = calls.find((c) => c.startsWith("answers"));
    expect(imp).toContain("answers import |");
    const match = calls.find((c) => c.startsWith("match-questions"));
    const dash = calls.find((c) => c.startsWith("dashboard"));
    expect(dash).toContain("dashboard --self-check |");
    for (const c of [imp, match, dash]) {
      expect(c).toContain(`DB=${smokeDir}/smoke.db`);
      expect(c).toContain(`CFG=${smokeDir}/config`);
      expect(c).toContain("ENVFILE=/dev/null ");
      expect(c).toContain("KEY= BRAVE=");
    }
    expect(res.stdout).toContain("== dashboard --self-check");
  });

  it("exits 1 when the dashboard self-check fails, but still prints the status", () => {
    const { res, calls } = run({ FAIL_DASH: "1" });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("!! 'dashboard --self-check' exited 1");
    expect(calls.some((c) => c.startsWith("status"))).toBe(true);
  });

  it("--demo runs seed-demo before any discover; without it there is no seed-demo", () => {
    const demo = run({}, ["--demo"]);
    expect(demo.res.status).toBe(0);
    const order = demo.calls.map((c) => c.split(" ")[0]);
    expect(order.filter((c) => c === "seed-demo")).toHaveLength(1);
    expect(order.indexOf("seed-demo")).toBeLessThan(order.indexOf("discover"));
    expect(demo.calls.find((c) => c.startsWith("seed-demo"))).toContain(
      `DB=${demo.smokeDir}/smoke.db`,
    );
    expect(run().calls.some((c) => c.startsWith("seed-demo"))).toBe(false);
    // Combinable with --with-jobspy.
    expect(run({}, ["--with-jobspy", "--demo"]).calls.some((c) => c.startsWith("seed-demo"))).toBe(
      true,
    );
  });

  it("runs fetch-questions --limit 3 on the temp DB", () => {
    const { calls, smokeDir } = run();
    const call = calls.find((c) => c.startsWith("fetch-questions"));
    expect(call).toContain("fetch-questions --limit 3 |");
    expect(call).toContain(`DB=${smokeDir}/smoke.db`);
  });

  it("never passes a Brave key on, so linkedin_posts skips", () => {
    const { calls } = run({ BRAVE_API_KEY: "brave-x" });
    expect(calls.filter((c) => c.includes("--source linkedin_posts"))).toHaveLength(1);
    for (const c of calls) expect(c).not.toContain("BRAVE=brave-x");
  });

  it("--with-jobspy adds one forced linkedin and one forced indeed discover, or says the venv is missing", () => {
    const { calls, res } = run({}, ["--with-jobspy"]);
    expect(res.status).toBe(0);
    const linkedin = calls.filter((c) => c.split(" ")[3] === "linkedin");
    const indeed = calls.filter((c) => c.split(" ")[3] === "indeed");
    if (existsSync(join(repo, "workers/jobspy/.venv/bin/python"))) {
      expect(linkedin).toHaveLength(1);
      expect(linkedin[0]).toContain("--force");
      expect(indeed).toHaveLength(1);
      expect(indeed[0]).toContain("--force");
    } else {
      expect(linkedin).toHaveLength(0);
      expect(indeed).toHaveLength(0);
      expect(res.stdout).toContain("linkedin, indeed: skipped (workers/jobspy/.venv missing");
    }
    expect(calls.filter((c) => c.startsWith("discover"))).toHaveLength(
      8 + linkedin.length + indeed.length,
    );
  });

  it("exits 1 when process fails but still tries the digest", () => {
    const { res, calls } = run({ FAIL_PROCESS: "1" });
    expect(res.status).toBe(1);
    expect(calls.some((c) => c.startsWith("digest"))).toBe(true);
  });

  it("points the CLI at /dev/null instead of .env, whatever JOB_AGENT_ENV_FILE says", () => {
    const { calls } = run({ JOB_AGENT_ENV_FILE: "/some/fake/.env" });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toContain("ENVFILE=/dev/null ");
  });

  it("`dash` runs the dashboard command with the smoke DB and configs, no keys, and passes args on", () => {
    const work = mkdtempSync(join(tmpdir(), "job-agent-smoke-test-"));
    dirs.push(work);
    const dir = join(work, "smoke");
    mkdirSync(dir);
    writeFileSync(join(dir, "smoke.db"), "");
    const fake = join(work, "fake-dash");
    writeFileSync(
      fake,
      `#!/usr/bin/env bash
echo "ARGS=$* DB=$JOB_AGENT_DB CFG=$JOB_AGENT_CONFIG_DIR ENVFILE=$JOB_AGENT_ENV_FILE KEY=\${ANTHROPIC_API_KEY:-} BRAVE=\${BRAVE_API_KEY:-}"
`,
    );
    chmodSync(fake, 0o755);
    const res = spawnSync(
      "bash",
      [join(repo, "bin/smoke"), "dash", dir, "--self-check", "--port", "4511"],
      {
        cwd: repo,
        encoding: "utf-8",
        env: {
          ...process.env,
          JOB_AGENT_DASH_CLI: fake,
          ANTHROPIC_API_KEY: "sk-x",
          BRAVE_API_KEY: "b-x",
        },
      },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(
      `ARGS=--self-check --port 4511 DB=${dir}/smoke.db CFG=${dir}/config ENVFILE=/dev/null KEY= BRAVE=\n`,
    );
  });

  it("`dash` refuses a dir without smoke.db", () => {
    const work = mkdtempSync(join(tmpdir(), "job-agent-smoke-test-"));
    dirs.push(work);
    const res = spawnSync("bash", [join(repo, "bin/smoke"), "dash", work], {
      cwd: repo,
      encoding: "utf-8",
    });
    expect(res.status).toBe(2);
    expect(res.stdout).toContain("no smoke.db");
  });

  it("with the real CLI and a fake .env holding a key, `bin/smoke run enrich` still skips (no key seen)", () => {
    const work = mkdtempSync(join(tmpdir(), "job-agent-smoke-test-"));
    dirs.push(work);
    const dir = join(work, "smoke");
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(join(dir, "smoke.db"), "");
    for (const f of readdirSync(join(repo, "config")).filter((n) => n.includes(".example."))) {
      copyFileSync(join(repo, "config", f), join(dir, "config", f.replace(".example", "")));
    }
    const fakeEnv = join(work, ".env");
    writeFileSync(fakeEnv, "ANTHROPIC_API_KEY=sk-ant-fake\n");
    const env: NodeJS.ProcessEnv = { ...process.env, JOB_AGENT_ENV_FILE: fakeEnv };
    delete env.ANTHROPIC_API_KEY;
    delete env.JOB_AGENT_CLI;
    const res = spawnSync("bash", [join(repo, "bin/smoke"), "run", dir, "enrich"], {
      cwd: repo,
      encoding: "utf-8",
      env,
    });
    expect(res.stdout).toContain("ANTHROPIC_API_KEY not set, LLM stages skipped");
    // Control: the same CLI run directly (no bin/smoke) loads the key from that file, so no skip line.
    const direct = spawnSync("pnpm", ["-s", "job-agent", "enrich"], {
      cwd: repo,
      encoding: "utf-8",
      env: {
        ...env,
        JOB_AGENT_DB: join(dir, "smoke.db"),
        JOB_AGENT_CONFIG_DIR: join(dir, "config"),
      },
    });
    expect(direct.stdout).not.toContain("ANTHROPIC_API_KEY not set");
  }, 60_000);
});
