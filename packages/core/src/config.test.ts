import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.ts";

const exampleDir = join(dirname(fileURLToPath(import.meta.url)), "../../../config");

let dir: string;

function seed(): void {
  copyFileSync(join(exampleDir, "salary.example.yaml"), join(dir, "salary.yaml"));
  copyFileSync(join(exampleDir, "companies.example.yaml"), join(dir, "companies.yaml"));
}

function catchError(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected function to throw");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "job-agent-config-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("loads the example files copied to real names", () => {
    seed();
    expect(loadConfig(dir)).toEqual({
      salary: {
        floor_idr_month: 10000000,
        position_in_listed_range: 0.7,
        tiers: {
          indonesia: { ask_idr_month: 12000000 },
          regional: { ask_idr_month: 15000000 },
          global_adjusted: { ask_idr_month: 14000000 },
          global_flat: { ask_usd_year: 50000 },
        },
        unknown_policy: "research_then_regional",
        text_field_answer: "Open, happy to align with your compensation band for my location",
        review_salary_answers: true,
      },
      companies: [{ name: "Example Co", ats: "ashby", slug: "example" }],
    });
  });

  it("uses JOB_AGENT_CONFIG_DIR when no argument is given", () => {
    seed();
    vi.stubEnv("JOB_AGENT_CONFIG_DIR", dir);
    expect(loadConfig().companies).toHaveLength(1);
  });

  it("rejects an invalid salary value, naming file and key path but not the value", () => {
    seed();
    writeFileSync(
      join(dir, "salary.yaml"),
      "floor_idr_month: secret-abc\nposition_in_listed_range: 0.7\n",
    );
    const err = catchError(() => loadConfig(dir));
    expect(err.message).toContain("salary.yaml");
    expect(err.message).toContain("floor_idr_month");
    expect(err.message).not.toContain("secret-abc");
  });

  it("does not leak values from nested issues", () => {
    seed();
    writeFileSync(
      join(dir, "salary.yaml"),
      'floor_idr_month: 1\nposition_in_listed_range: 0.7\ntiers:\n  indonesia: { ask_idr_month: "hunter2" }\n',
    );
    const err = catchError(() => loadConfig(dir));
    expect(err.message).toContain("tiers.indonesia.ask_idr_month");
    expect(err.message).not.toContain("hunter2");
  });

  it("does not leak content of malformed YAML", () => {
    seed();
    writeFileSync(join(dir, "salary.yaml"), "floor_idr_month: [hunter2\n");
    const err = catchError(() => loadConfig(dir));
    expect(err.message).toContain("salary.yaml");
    expect(err.message).not.toContain("hunter2");
  });

  it("names the file when companies.yaml is missing", () => {
    seed();
    rmSync(join(dir, "companies.yaml"));
    expect(() => loadConfig(dir)).toThrow(/companies\.yaml/);
  });

  it("names the file when salary.yaml is missing", () => {
    seed();
    rmSync(join(dir, "salary.yaml"));
    expect(() => loadConfig(dir)).toThrow(/salary\.yaml/);
  });

  it.each(["smartrecruiters", "workable", "recruitee"])("accepts ats: %s", (ats) => {
    seed();
    writeFileSync(
      join(dir, "companies.yaml"),
      `companies:\n  - { name: X, ats: ${ats}, slug: x }\n`,
    );
    expect(loadConfig(dir).companies).toEqual([{ name: "X", ats, slug: "x" }]);
  });

  it("rejects an unknown ats value", () => {
    seed();
    writeFileSync(
      join(dir, "companies.yaml"),
      "companies:\n  - { name: X, ats: workday, slug: x }\n",
    );
    const err = catchError(() => loadConfig(dir));
    expect(err.message).toContain("companies.yaml");
    expect(err.message).toContain("companies.0.ats");
  });

  it("rejects an unknown key", () => {
    seed();
    writeFileSync(
      join(dir, "companies.yaml"),
      "companies:\n  - { name: X, ats: lever, slug: x, extra: 1 }\n",
    );
    expect(() => loadConfig(dir)).toThrow(/companies\.yaml/);
  });
});
