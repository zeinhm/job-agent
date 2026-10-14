import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BRAVE_KEY_ENV } from "@job-agent/sources";

const CAP_ENV = "JOB_AGENT_LLM_CAP_USD";
const root = resolve(import.meta.dirname, "../../..");
const read = (p: string): string => readFileSync(resolve(root, p), "utf8");

const running = read("docs/running.md");
const cron = read("scripts/crontab.example");
const envExample = read(".env.example");

/** Cron job lines only (no comments), in file order. */
const jobs = cron.split("\n").filter((l) => /^\d+ [\d*/]+ \* \* [\d*]/.test(l));
const commandsOf = (line: string): string[] =>
  [...line.matchAll(/pnpm -s job-agent (\S+)/g)].map((m) => m[1] as string);

/** Every non-test .ts file under packages/*\/src and bin scripts, as text. */
const sourceFiles = (dir: string): string[] =>
  readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory())
      return e.name === "node_modules" || e.name === "test" ? [] : sourceFiles(rel);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [rel] : [];
  });

/** Env names set by tests or scripts, not settings: not in .env.example. */
const INTERNAL_ENV = new Set([
  "JOB_AGENT_ENV_FILE",
  "JOB_AGENT_JOBSPY_SMOKE",
  "JOB_AGENT_CLI",
  "JOB_AGENT_DATA_DIR",
]);

describe("Phase 3 run docs", () => {
  const cliFull = read("packages/pipeline/src/cli.ts");
  const cli = cliFull.slice(cliFull.indexOf("const commands"), cliFull.indexOf("const usage"));
  const commandNames = [...cli.matchAll(/^ {2}(?:"([a-z-]+)"|([a-z]+)): (?:async )?\(/gm)].map(
    (m) => (m[1] ?? m[2]) as string,
  );
  const flagNames = [
    ...new Set(
      [
        ...cli.matchAll(
          /(?:^|[\s{,])"?(source|force|limit|no-reextract|reextract-only|reprocess|date|out-dir|include-unpaid)"?: \{/g,
        ),
      ].map((m) => m[1] as string),
    ),
  ];
  const commandsSection = running.slice(
    running.indexOf("\n## Commands"),
    running.indexOf("\n### Reprocessing"),
  );
  const commandRows = commandsSection
    .split("\n")
    .filter((l) => l.startsWith("| `"))
    .map((l) => l.split("|")[1]?.trim() ?? "");

  it("finds the commands and flags in cli.ts", () => {
    expect(commandNames).toEqual(
      expect.arrayContaining([
        "discover",
        "discover-companies",
        "enrich",
        "resolve-apply",
        "process",
        "digest",
        "status",
        "fx",
      ]),
    );
    expect(flagNames.sort()).toEqual(
      [
        "date",
        "force",
        "include-unpaid",
        "limit",
        "no-reextract",
        "out-dir",
        "reextract-only",
        "reprocess",
        "source",
      ].sort(),
    );
  });

  it("documents every cli.ts command and flag, and nothing else", () => {
    for (const name of commandNames) {
      expect(
        commandRows.some((r) => r.startsWith(`\`${name}`)),
        `command ${name}`,
      ).toBe(true);
    }
    for (const flag of flagNames) expect(running, `--${flag}`).toContain(`--${flag}`);
    // doc -> code: every command row and every --flag in a command row exists in cli.ts
    const cmdTable = commandRows.filter((r) => /^`[a-z-]+[ `]/.test(r));
    for (const row of cmdTable) {
      const name = /^`([a-z-]+)/.exec(row)?.[1] as string;
      expect(commandNames, `documented command ${name}`).toContain(name);
      for (const f of row.matchAll(/--([a-z-]+)/g))
        expect(flagNames, `documented flag ${f[0]}`).toContain(f[1]);
    }
  });

  it("documents the Phase 3 topics", () => {
    for (const needle of [
      "resolve-apply",
      "unknown_tier_ask",
      "--no-reextract",
      "--reextract-only",
      "--with-jobspy",
      "backoff after block",
      "max gap",
      "data/locks/hourly",
      "Automatic additions to companies.yaml",
      "workers/jobspy/.venv",
      "JOB_AGENT_ENV_FILE",
    ]) {
      expect(running, needle).toContain(needle);
    }
  });

  it("documents every source adapter with its interval, and every source env name", () => {
    const sources = read("packages/sources/src/registry.ts");
    expect(sources).toContain("createLinkedInAdapter");
    for (const name of [
      "linkedin",
      "indeed",
      "linkedin_posts",
      "web3career",
      "greenhouse",
      "lever",
      "ashby",
      "recruitee",
      "workable",
      "smartrecruiters",
      "himalayas",
      "remoteok",
      "remotive",
      "weworkremotely",
      "hn",
      "arbeitnow",
    ]) {
      expect(running, name).toContain(`\`${name}\``);
    }
  });

  it(".env.example lists every env name the code reads", () => {
    const files = [
      ...sourceFiles("packages/core/src"),
      ...sourceFiles("packages/pipeline/src"),
      ...sourceFiles("packages/sources/src"),
      ...sourceFiles("packages/sources/scripts"),
    ];
    const names = new Set<string>();
    for (const f of files) {
      for (const m of read(f).matchAll(
        /\b(JOB_AGENT_[A-Z_]+|[A-Z][A-Z0-9_]*_(?:API_KEY|TOKEN))\b/g,
      ))
        names.add(m[1] as string);
    }
    names.add(BRAVE_KEY_ENV);
    for (const n of [
      "OVERHEAD_TOKEN",
      "MAX_TOKEN",
      "CURRENCY_TOKEN",
      "TRACKING_KEY",
      "TIER_KEY",
      "API_KEY",
      "JOB_AGENT_GITHUB_TOKEN",
    ])
      names.delete(n);
    expect(names.size).toBeGreaterThanOrEqual(6);
    for (const n of names) {
      if (INTERNAL_ENV.has(n)) continue;
      expect(envExample, n).toMatch(new RegExp(`^#? ?${n}=$`, "m"));
    }
  });
});

describe("Phase 2 run docs", () => {
  it("documents every new command and env var", () => {
    for (const needle of [
      "discover-companies",
      "enrich",
      "config/cv.md",
      "ANTHROPIC_API_KEY",
      BRAVE_KEY_ENV,
      CAP_ENV,
      "only **lower**",
      "Reading the ranked digest",
      "Eval scripts",
      "--live",
    ]) {
      expect(running, needle).toContain(needle);
    }
  });

  it("lists the env vars in .env.example with empty values", () => {
    for (const name of ["ANTHROPIC_API_KEY", BRAVE_KEY_ENV, CAP_ENV]) {
      expect(envExample, name).toMatch(new RegExp(`^${name}=$`, "m"));
    }
    expect(envExample).toMatch(/can only lower/i);
    expect(envExample).not.toMatch(/sk-ant|=\S/);
  });

  it("runs fx daily, discover-companies weekly on Monday, then one hourly bin/run-hourly line, with no keys in the crontab", () => {
    const flat = jobs.flatMap(commandsOf);
    expect(flat).toEqual(["fx", "discover-companies"]);
    const hourly = jobs.filter((l) => l.includes("bin/run-hourly"));
    expect(hourly).toHaveLength(1);
    expect(hourly[0]).toMatch(/^5 \* \* \* \* /);
    const line = (cmd: string): string[] =>
      (jobs.find((j) => commandsOf(j)[0] === cmd) as string).split(" ");
    expect(line("fx").slice(0, 5)).toEqual(["50", "6", "*", "*", "*"]);
    // weekly, Monday 07:00; no daily discover-companies line
    expect(line("discover-companies").slice(0, 5)).toEqual(["0", "7", "*", "*", "1"]);
    expect(jobs.filter((j) => commandsOf(j).includes("discover-companies"))).toHaveLength(1);
    expect(running).toMatch(/discover-companies` weekly/);
    expect(cron).not.toMatch(/^[A-Z_]*(KEY|TOKEN)=/m);
    // the hourly script runs the steps in the documented order
    const script = read("bin/run-hourly");
    expect(script).toContain("for cmd in discover process enrich resolve-apply digest; do");
    expect(running).toContain("`discover`, `process`, `enrich`, `resolve-apply`, `digest`");
  });

  it("contains no real-looking secrets or personal data", () => {
    for (const text of [running, cron, envExample]) {
      expect(text).not.toMatch(/sk-ant-[A-Za-z0-9]/);
      expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    }
  });
});
