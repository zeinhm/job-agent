import type { Logger } from "@job-agent/core";

/** A source adapter. Concrete adapters are added by their own tasks. */
export interface SourceAdapter {
  readonly name: string;
  fetch(since: Date, log?: Logger): Promise<unknown[]>;
}

export const adapters: readonly SourceAdapter[] = [];

export function findAdapter(name: string): SourceAdapter | undefined {
  return adapters.find((a) => a.name === name);
}
