import { readFileSync } from "node:fs";
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
const jobs = cron.split("\n").filter((l) => /^\d+ [\d*/]+ \* \* \*/.test(l));
const commandsOf = (line: string): string[] =>
  [...line.matchAll(/pnpm -s job-agent (\S+)/g)].map((m) => m[1] as string);

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

  it("runs fx -> discover-companies daily, then one hourly bin/run-hourly line, with no keys in the crontab", () => {
    const flat = jobs.flatMap(commandsOf);
    expect(flat).toEqual(["fx", "discover-companies"]);
    const hourly = jobs.filter((l) => l.includes("bin/run-hourly"));
    expect(hourly).toHaveLength(1);
    expect(hourly[0]).toMatch(/^5 \* \* \* \* /);
    // daily jobs: fx runs before discover-companies
    const hm = (cmd: string): number => {
      const l = jobs.find((j) => commandsOf(j)[0] === cmd) as string;
      const [m, h] = l.split(" ");
      return Number(h) * 60 + Number(m);
    };
    expect(hm("fx")).toBeLessThan(hm("discover-companies"));
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
