import type { AppConfig } from "@job-agent/core";
import { describe, expect, it } from "vitest";
import { buildAdapters } from "./registry.ts";

describe("buildAdapters", () => {
  it("returns only the companyless adapters when no companies are configured", () => {
    const config: AppConfig = {
      salary: {
        floor_idr_month: 1,
        position_in_listed_range: 0.5,
        tiers: {
          indonesia: { ask_idr_month: 1 },
          regional: { ask_idr_month: 1 },
          global_adjusted: { ask_idr_month: 1 },
          global_flat: { ask_usd_year: 1 },
        },
        unknown_policy: "x",
        text_field_answer: "x",
        review_salary_answers: false,
      },
      companies: [],
    };
    expect(buildAdapters(config).map((a) => a.name)).toEqual(["remotive"]);
  });
});
