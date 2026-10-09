import type { AppConfig, SourceAdapter } from "@job-agent/core";
import { createAshbyAdapter } from "./ashby/index.ts";
import { createGreenhouseAdapter } from "./greenhouse/index.ts";
import { createHimalayasAdapter } from "./himalayas/index.ts";
import { createHnAdapter } from "./hn/index.ts";
import { createLeverAdapter } from "./lever/index.ts";
import { createRemoteOkAdapter } from "./remoteok/index.ts";
import { createRemotiveAdapter } from "./remotive/index.ts";
import { createSmartRecruitersAdapter } from "./smartrecruiters/index.ts";
import { createWeb3CareerAdapter } from "./web3career/index.ts";
import { createWeWorkRemotelyAdapter } from "./weworkremotely/index.ts";
import { createWorkableAdapter } from "./workable/index.ts";

/** Builds every enabled adapter. Each adapter task adds one entry here and starts using `config`. */
export const buildAdapters = (config: AppConfig): SourceAdapter[] => {
  const adapters: SourceAdapter[] = [];

  const greenhouse = config.companies.filter((c) => c.ats === "greenhouse");
  if (greenhouse.length > 0) adapters.push(createGreenhouseAdapter(greenhouse));

  const leverCompanies = config.companies.filter((c) => c.ats === "lever");
  if (leverCompanies.length > 0) adapters.push(createLeverAdapter(leverCompanies));

  const ashby = config.companies.filter((c) => c.ats === "ashby");
  if (ashby.length > 0) adapters.push(createAshbyAdapter(ashby));

  const workable = config.companies.filter((c) => c.ats === "workable");
  if (workable.length > 0) adapters.push(createWorkableAdapter(workable));

  const smartrecruiters = config.companies.filter((c) => c.ats === "smartrecruiters");
  if (smartrecruiters.length > 0) adapters.push(createSmartRecruitersAdapter(smartrecruiters));

  adapters.push(createHimalayasAdapter());
  adapters.push(createRemoteOkAdapter());
  adapters.push(createRemotiveAdapter());
  adapters.push(createWeb3CareerAdapter());
  adapters.push(createWeWorkRemotelyAdapter());
  adapters.push(createHnAdapter());

  return adapters;
};
