import type { AppConfig, SourceAdapter } from "@job-agent/core";
import { createLeverAdapter } from "./lever/index.ts";

/** Builds every enabled adapter. Each adapter task adds one entry here and starts using `config`. */
export const buildAdapters: (config: AppConfig) => SourceAdapter[] = (config) => {
  const adapters: SourceAdapter[] = [];

  const leverCompanies = config.companies.filter((c) => c.ats === "lever");
  if (leverCompanies.length > 0) adapters.push(createLeverAdapter(leverCompanies));

  return adapters;
};
