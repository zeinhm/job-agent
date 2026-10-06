import type { SourceAdapter } from "@job-agent/core";

export { buildAdapters } from "./registry.ts";

export const adapters: readonly SourceAdapter[] = [];

export function findAdapter(name: string): SourceAdapter | undefined {
  return adapters.find((a) => a.name === name);
}
