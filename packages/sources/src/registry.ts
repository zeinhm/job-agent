import type { AppConfig, CompanyConfig, SourceAdapter } from "@job-agent/core";
import { createArbeitnowAdapter } from "./arbeitnow/index.ts";
import { createAshbyAdapter } from "./ashby/index.ts";
import { createGreenhouseAdapter } from "./greenhouse/index.ts";
import { createHimalayasAdapter } from "./himalayas/index.ts";
import { createHnAdapter } from "./hn/index.ts";
import { createLeverAdapter } from "./lever/index.ts";
import { createRecruiteeAdapter } from "./recruitee/index.ts";
import { createRemoteOkAdapter } from "./remoteok/index.ts";
import { createRemotiveAdapter } from "./remotive/index.ts";
import { createSmartRecruitersAdapter } from "./smartrecruiters/index.ts";
import { createWeb3CareerAdapter } from "./web3career/index.ts";
import { createWeWorkRemotelyAdapter } from "./weworkremotely/index.ts";
import { createWorkableAdapter } from "./workable/index.ts";

/** A `companies` table row reduced to what polling needs. */
export interface DiscoveredCompany {
  name: string;
  ats_type: CompanyConfig["ats"] | null;
  ats_slug: string | null;
  verified: boolean | null;
}

/**
 * Config companies plus verified DB companies with an ATS set. Config entries come first and win:
 * the same ats + slug (case-insensitive) is kept once.
 */
export const pollingCompanies = (
  config: AppConfig,
  discovered: readonly DiscoveredCompany[] = [],
): CompanyConfig[] => {
  const seen = new Set<string>();
  const result: CompanyConfig[] = [];
  const add = (c: CompanyConfig) => {
    const key = `${c.ats}:${c.slug.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(c);
  };
  for (const c of config.companies) add(c);
  for (const d of discovered) {
    if (d.verified === true && d.ats_type && d.ats_slug) {
      add({ name: d.name, ats: d.ats_type, slug: d.ats_slug });
    }
  }
  return result;
};

/** Builds every enabled adapter. Each adapter task adds one entry here and starts using `companies`. */
export const buildAdapters = (
  config: AppConfig,
  discovered: readonly DiscoveredCompany[] = [],
): SourceAdapter[] => {
  const adapters: SourceAdapter[] = [];
  const companies = pollingCompanies(config, discovered);

  const greenhouse = companies.filter((c) => c.ats === "greenhouse");
  if (greenhouse.length > 0) adapters.push(createGreenhouseAdapter(greenhouse));

  const leverCompanies = companies.filter((c) => c.ats === "lever");
  if (leverCompanies.length > 0) adapters.push(createLeverAdapter(leverCompanies));

  const ashby = companies.filter((c) => c.ats === "ashby");
  if (ashby.length > 0) adapters.push(createAshbyAdapter(ashby));

  const recruitee = companies.filter((c) => c.ats === "recruitee");
  if (recruitee.length > 0) adapters.push(createRecruiteeAdapter(recruitee));

  const workable = companies.filter((c) => c.ats === "workable");
  if (workable.length > 0) adapters.push(createWorkableAdapter(workable));

  const smartrecruiters = companies.filter((c) => c.ats === "smartrecruiters");
  if (smartrecruiters.length > 0) adapters.push(createSmartRecruitersAdapter(smartrecruiters));

  adapters.push(createHimalayasAdapter());
  adapters.push(createRemoteOkAdapter());
  adapters.push(createRemotiveAdapter());
  adapters.push(createWeb3CareerAdapter());
  adapters.push(createWeWorkRemotelyAdapter());
  adapters.push(createHnAdapter());
  adapters.push(createArbeitnowAdapter());

  return adapters;
};
