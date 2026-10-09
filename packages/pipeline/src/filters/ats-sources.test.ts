import { ATS_TYPES } from "@job-agent/core";
import { describe, expect, it } from "vitest";
import { ATS_SOURCE_NAMES } from "./keywords.ts";

describe("ATS_SOURCE_NAMES", () => {
  // ATS_TYPES is the enum behind `ats:` in companies.yaml; a hand-copied list would drift from it.
  it("lists exactly the ATS names the companies config accepts", () => {
    expect([...ATS_SOURCE_NAMES].sort()).toEqual([...ATS_TYPES].sort());
  });
});
