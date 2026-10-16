import { SourceBlockedError, SourceError } from "@job-agent/core";
import { z } from "zod";
import { createDetailSpawnRunner, type DetailRunner, type SpawnWorkerOptions } from "./worker.ts";

const SOURCE = "linkedin";

/** One detail request's outcome. A block is not a result: it throws SourceBlockedError. */
export type DetailResult = { kind: "ok"; description: string } | { kind: "failed"; reason: string };

/** Fetches the description of one LinkedIn posting (its external id, no `li-` prefix): one JobSpy detail request. */
export type DetailFetcher = (externalId: string) => Promise<DetailResult>;

export interface DetailFetcherOptions {
  /** Defaults to spawning workers/jobspy/.venv/bin/python run.py in its details mode. */
  runWorker?: DetailRunner;
  python?: string;
  script?: string;
  timeoutMs?: number;
  /** Replaces node's spawn (tests); see SpawnWorkerOptions. */
  spawnFn?: SpawnWorkerOptions["spawnFn"];
}

const errorLineSchema = z.object({
  error: z.string(),
  kind: z.enum(["blocked", "error"]).optional(),
  id: z.string().optional(),
});
const descriptionLineSchema = z.object({ id: z.string(), description: z.string().min(1) });

function parseLines(stdout: string): unknown[] {
  const out: unknown[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // not JSON: ignored, the exit code and the missing id line are reported by the caller
    }
  }
  return out;
}

/**
 * The LinkedIn detail fetcher. The worker (workers/jobspy/run.py, details mode) makes the one request through JobSpy;
 * no LinkedIn URL, cookie or selector lives in this repo's TypeScript.
 * Throws SourceBlockedError on a block, SourceSkippedError when the worker cannot run here, SourceError when the
 * worker itself failed (a tool problem, not the posting's fault).
 */
export function createLinkedInDetailFetcher(opts: DetailFetcherOptions = {}): DetailFetcher {
  const runWorker =
    opts.runWorker ??
    createDetailSpawnRunner({
      source: SOURCE,
      ...(opts.python ? { python: opts.python } : {}),
      ...(opts.script ? { script: opts.script } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
    });
  return async (externalId) => {
    const id = `li-${externalId}`;
    const { exitCode, stdout } = await runWorker({
      mode: "details",
      site: "linkedin",
      job_ids: [id],
    });
    const lines = parseLines(stdout);
    if (exitCode !== 0) {
      for (const line of lines) {
        const e = errorLineSchema.safeParse(line);
        if (!e.success) continue;
        if (e.data.kind === "blocked") throw new SourceBlockedError(SOURCE, e.data.error);
        throw new SourceError(SOURCE, `jobspy worker failed: ${e.data.error}`);
      }
      throw new SourceError(SOURCE, `jobspy worker exited ${exitCode}`);
    }
    for (const line of lines) {
      const d = descriptionLineSchema.safeParse(line);
      if (d.success && d.data.id === id) return { kind: "ok", description: d.data.description };
      const e = errorLineSchema.safeParse(line);
      if (e.success && e.data.id === id) return { kind: "failed", reason: e.data.error };
    }
    return { kind: "failed", reason: "no line for the id in the worker output" };
  };
}
