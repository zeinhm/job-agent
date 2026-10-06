import type { AppConfig, SourceAdapter } from "@job-agent/core";
import { createGreenhouseAdapter } from "./greenhouse/index.ts";
import { createRemotiveAdapter } from "./remotive/index.ts";

/** Builds every enabled adapter. Each adapter task adds one entry here and starts using `config`. */
export const buildAdapters = (config: AppConfig): SourceAdapter[] => {
  const adapters: SourceAdapter[] = [];

  const greenhouse = config.companies.filter((c) => c.ats === "greenhouse");
  if (greenhouse.length > 0) adapters.push(createGreenhouseAdapter(greenhouse));

  adapters.push(createRemotiveAdapter());

  return adapters;
};
