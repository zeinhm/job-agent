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

  it("runs the cron steps in the order fx -> discover-companies -> discover -> process -> enrich -> digest", () => {
    const flat = jobs.flatMap(commandsOf);
    expect(flat.slice(0, 2)).toEqual(["fx", "discover-companies"]);
    expect(jobs.map(commandsOf)).toContainEqual(["discover", "process", "enrich"]);
    expect(jobs.map(commandsOf)).toContainEqual(["discover", "process", "enrich", "digest"]);
    // daily jobs: fx runs before discover-companies, which runs before the first discover
    const hm = (cmd: string): number => {
      // "discover" = the daily digest run (a fixed hour), not the every-2-hours job
      const l = jobs.find(
        (j) => commandsOf(j)[0] === cmd && (cmd !== "discover" || commandsOf(j).includes("digest")),
      ) as string;
      const [m, h] = l.split(" ");
      return Number(h) * 60 + Number(m);
    };
    expect(hm("fx")).toBeLessThan(hm("discover-companies"));
    expect(hm("discover-companies")).toBeLessThan(hm("discover"));
  });

  it("contains no real-looking secrets or personal data", () => {
    for (const text of [running, cron, envExample]) {
      expect(text).not.toMatch(/sk-ant-[A-Za-z0-9]/);
      expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    }
  });
});
