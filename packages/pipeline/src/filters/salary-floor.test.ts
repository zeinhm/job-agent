import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { IdrMonth } from "../salary/index.ts";
import { applySalaryFloor } from "./salary-floor.ts";

// Example config value (config/salary.example.yaml), never the real config.
const FLOOR = 10_000_000;

const listed = (idrMonthMin?: number, idrMonthMax?: number): IdrMonth => ({
  status: "listed",
  ...(idrMonthMin === undefined ? {} : { idrMonthMin }),
  ...(idrMonthMax === undefined ? {} : { idrMonthMax }),
  fxDate: null,
});

describe("applySalaryFloor", () => {
  it("rejects when max is below the floor", () => {
    const r = applySalaryFloor(listed(5_000_000, 9_999_999), FLOOR);
    expect(r.reject).toBe(true);
    expect(r.flag).toBeUndefined();
  });

  it("keeps when max equals the floor", () => {
    expect(applySalaryFloor(listed(5_000_000, 10_000_000), FLOOR).reject).toBe(false);
  });

  it("keeps when only min is listed, even far below the floor", () => {
    const r = applySalaryFloor(listed(5_000_000), FLOOR);
    expect(r.reject).toBe(false);
    expect(r.flag).toBeUndefined();
  });

  it("keeps a range that straddles the floor", () => {
    expect(applySalaryFloor(listed(5_000_000, 12_000_000), FLOOR).reject).toBe(false);
  });

  it("rejects a single number below the floor and keeps one at it", () => {
    expect(applySalaryFloor(listed(9_000_000, 9_000_000), FLOOR).reject).toBe(true);
    expect(applySalaryFloor(listed(10_000_000, 10_000_000), FLOOR).reject).toBe(false);
  });

  it("rejects when only max is listed and below the floor", () => {
    expect(applySalaryFloor(listed(undefined, 9_000_000), FLOOR).reject).toBe(true);
  });

  it("keeps a listed salary with no numbers and flags it unknown", () => {
    expect(applySalaryFloor(listed(), FLOOR)).toMatchObject({
      reject: false,
      flag: "salary_unknown",
    });
  });

  it.each([
    ["unknown", "salary_unknown"],
    ["unparsed", "salary_unparsed"],
    ["no_fx", "salary_no_fx"],
  ] as const)("keeps %s with flag %s", (status, flag) => {
    expect(applySalaryFloor({ status }, FLOOR)).toMatchObject({ reject: false, flag });
  });

  it("never puts the floor value in reason", () => {
    const inputs: IdrMonth[] = [
      listed(5_000_000, 9_999_999),
      listed(5_000_000, 10_000_000),
      listed(5_000_000),
      listed(),
      { status: "unknown" },
      { status: "unparsed" },
      { status: "no_fx" },
    ];
    for (const floor of [FLOOR, 12_345_678]) {
      for (const input of inputs) {
        const { reason } = applySalaryFloor(input, floor);
        expect(reason).not.toMatch(/\d{4,}/);
        expect(reason).not.toContain(String(floor));
      }
    }
  });

  it("does not import the config loader or FX", () => {
    const src = readFileSync(new URL("./salary-floor.ts", import.meta.url), "utf8");
    const imports = [...src.matchAll(/^import .* from "(.*)";$/gm)].map((m) => m[1]);
    expect(imports).toEqual(["../salary/index.ts"]);
    expect(src).not.toMatch(/loadConfig|@job-agent\/core|toIdr|fx_rates/);
  });
});
