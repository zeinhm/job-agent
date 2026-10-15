import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "@job-agent/core";
import { loadEnvFile } from "../env.ts";
import { runEvalFit } from "./fit.ts";

/** pnpm runs scripts from the package dir: a relative default DB path would point at the wrong place. */
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../..");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadEnvFile((t) => process.stderr.write(t));
  process.exitCode = await runEvalFit({
    args: process.argv.slice(2),
    openDb: () => openDb(process.env["JOB_AGENT_DB"] ?? resolve(REPO_ROOT, "data/job-agent.db")),
    configDir: process.env["JOB_AGENT_CONFIG_DIR"] ?? resolve(REPO_ROOT, "config"),
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
  });
}
