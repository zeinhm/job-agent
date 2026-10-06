import type { AppConfig } from "@job-agent/core";

/** Inline test config (fake persona values only). */
export function makeConfig(companies: AppConfig["companies"] = []): AppConfig {
  return {
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
    companies,
  };
}
