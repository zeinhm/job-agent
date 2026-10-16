import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SourceError, SourceSkippedError } from "@job-agent/core";

export const WORKER_DIR = fileURLToPath(new URL("../../../../workers/jobspy/", import.meta.url));
export const DEFAULT_PYTHON = `${WORKER_DIR}.venv/bin/python`;
export const WORKER_SCRIPT = `${WORKER_DIR}run.py`;
export const DISABLED_UNDER_TESTS =
  "jobspy worker disabled under the test runner (VITEST is set); inject a spawn function";
export const NOT_INSTALLED = "jobspy worker not installed (see workers/jobspy/README.md)";
export const WORKER_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** One search, as the worker's JSON argument (see workers/jobspy/README.md). */
export interface WorkerSearch {
  site: "linkedin" | "indeed";
  search_term: string;
  location?: string;
  is_remote?: boolean;
  hours_old?: number;
  results_wanted: number;
  /** Paging: results to skip (page 2 of a full search). Omitted = 0. */
  offset?: number;
  country?: string;
}

/** Detail mode: one LinkedIn description fetch per id (the worker's `"mode": "details"`). */
export interface WorkerDetails {
  mode: "details";
  site: "linkedin";
  job_ids: string[];
}

export interface WorkerOutput {
  exitCode: number;
  stdout: string;
}

export type WorkerRunner = (search: WorkerSearch) => Promise<WorkerOutput>;
export type DetailRunner = (details: WorkerDetails) => Promise<WorkerOutput>;

export interface SpawnWorkerOptions {
  source: string;
  python?: string;
  script?: string;
  timeoutMs?: number;
  /**
   * Replaces node's spawn. Under the test runner (VITEST set) the default spawn is refused;
   * only an injected function runs.
   */
  spawnFn?: typeof spawn;
}

/** Spawns the venv python on run.py with the search as JSON on stdin. Missing venv = SourceSkippedError. */
export function createSpawnRunner(opts: SpawnWorkerOptions): WorkerRunner {
  return createJsonRunner<WorkerSearch>(opts);
}

/** Same spawn (same VITEST guard, venv check and timeout) for the detail mode. */
export function createDetailSpawnRunner(opts: SpawnWorkerOptions): DetailRunner {
  return createJsonRunner<WorkerDetails>(opts);
}

function createJsonRunner<T>(opts: SpawnWorkerOptions): (search: T) => Promise<WorkerOutput> {
  const python = opts.python ?? DEFAULT_PYTHON;
  const script = opts.script ?? WORKER_SCRIPT;
  const timeoutMs = opts.timeoutMs ?? WORKER_TIMEOUT_MS;
  const spawnProcess = opts.spawnFn ?? spawn;
  return (search) => {
    // Checked before existsSync, so it holds with or without the venv. No option or env variable switches it off.
    if (opts.spawnFn === undefined && process.env["VITEST"]) {
      return Promise.reject(new SourceSkippedError(opts.source, DISABLED_UNDER_TESTS));
    }
    if (!existsSync(python) || !existsSync(script)) {
      return Promise.reject(new SourceSkippedError(opts.source, NOT_INSTALLED));
    }
    return new Promise<WorkerOutput>((resolve, reject) => {
      const child = spawnProcess(python, [script], { stdio: ["pipe", "pipe", "ignore"] });
      let stdout = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() =>
          reject(
            new SourceError(opts.source, `jobspy worker timed out after ${timeoutMs / 1000}s`),
          ),
        );
      }, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.length > MAX_OUTPUT_BYTES) {
          child.kill("SIGKILL");
          finish(() => reject(new SourceError(opts.source, "jobspy worker output too large")));
        }
      });
      child.on("error", (err: NodeJS.ErrnoException) =>
        finish(() =>
          reject(
            err.code === "ENOENT"
              ? new SourceSkippedError(opts.source, NOT_INSTALLED)
              : new SourceError(opts.source, "could not start jobspy worker", { cause: err }),
          ),
        ),
      );
      child.on("close", (code) => finish(() => resolve({ exitCode: code ?? 1, stdout })));
      child.stdin.on("error", () => undefined); // a worker that exits before reading stdin is handled by its exit code
      child.stdin.end(JSON.stringify(search));
    });
  };
}
