import type { SourceAdapter } from "@job-agent/core";

export { buildAdapters, pollingCompanies, type DiscoveredCompany } from "./registry.ts";

export const adapters: readonly SourceAdapter[] = [];

export function findAdapter(name: string): SourceAdapter | undefined {
  return adapters.find((a) => a.name === name);
}

export * from "./discovery/index.ts";
export { createIndeedAdapter, createLinkedInAdapter, SEARCH_GAP_MS } from "./jobspy/index.ts";
export {
  createLinkedInDetailFetcher,
  type DetailFetcher,
  type DetailResult,
} from "./jobspy/details.ts";
export { createLinkedinPostsAdapter, UNKNOWN_COMPANY } from "./linkedin-posts/index.ts";
export { parseGreenhouseJob } from "./greenhouse/index.ts";
export { parseLeverJob } from "./lever/index.ts";
export { findAshbyJob } from "./ashby/index.ts";
export { findWorkableJob } from "./workable/index.ts";
export { findRecruiteeOffer } from "./recruitee/index.ts";
