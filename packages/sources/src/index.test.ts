import { describe, expect, it } from "vitest";
import { adapters, findAdapter } from "./index.ts";

describe("adapter registry", () => {
  it("starts empty", () => {
    expect(adapters).toEqual([]);
  });

  it("returns undefined for an unknown adapter", () => {
    expect(findAdapter("nope")).toBeUndefined();
  });
});
