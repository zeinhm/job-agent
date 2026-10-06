import type { AppConfig, SourceAdapter } from "@job-agent/core";

/** Builds every enabled adapter. Each adapter task adds one entry here and starts using `config`. */
export const buildAdapters: (config: AppConfig) => SourceAdapter[] = () => [];
