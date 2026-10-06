import type { AppConfig, SourceAdapter } from "@job-agent/core";
import { createGreenhouseAdapter } from "./greenhouse/index.ts";
import { createLeverAdapter } from "./lever/index.ts";
import { createWeWorkRemotelyAdapter } from "./weworkremotely/index.ts";

/** Builds every enabled adapter. Each adapter task adds one entry here and starts using `config`. */
export const buildAdapters = (config: AppConfig): SourceAdapter[] => {
  const adapters: SourceAdapter[] = [];

  const greenhouse = config.companies.filter((c) => c.ats === "greenhouse");
  if (greenhouse.length > 0) adapters.push(createGreenhouseAdapter(greenhouse));

  const leverCompanies = config.companies.filter((c) => c.ats === "lever");
  if (leverCompanies.length > 0) adapters.push(createLeverAdapter(leverCompanies));

  adapters.push(createWeWorkRemotelyAdapter());

  return adapters;
};
