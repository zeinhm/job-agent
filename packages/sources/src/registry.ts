import type { AppConfig, SourceAdapter } from "@job-agent/core";
import { createAshbyAdapter } from "./ashby/index.ts";
import { createGreenhouseAdapter } from "./greenhouse/index.ts";
import { createHimalayasAdapter } from "./himalayas/index.ts";
import { createLeverAdapter } from "./lever/index.ts";
import { createRemoteOkAdapter } from "./remoteok/index.ts";
import { createRemotiveAdapter } from "./remotive/index.ts";
import { createWeb3CareerAdapter } from "./web3career/index.ts";
import { createWeWorkRemotelyAdapter } from "./weworkremotely/index.ts";

/** Builds every enabled adapter. Each adapter task adds one entry here and starts using `config`. */
export const buildAdapters = (config: AppConfig): SourceAdapter[] => {
  const adapters: SourceAdapter[] = [];

  const greenhouse = config.companies.filter((c) => c.ats === "greenhouse");
  if (greenhouse.length > 0) adapters.push(createGreenhouseAdapter(greenhouse));

  const leverCompanies = config.companies.filter((c) => c.ats === "lever");
  if (leverCompanies.length > 0) adapters.push(createLeverAdapter(leverCompanies));

  const ashby = config.companies.filter((c) => c.ats === "ashby");
  if (ashby.length > 0) adapters.push(createAshbyAdapter(ashby));

  adapters.push(createHimalayasAdapter());
  adapters.push(createRemoteOkAdapter());
  adapters.push(createRemotiveAdapter());
  adapters.push(createWeb3CareerAdapter());
  adapters.push(createWeWorkRemotelyAdapter());

  return adapters;
};
