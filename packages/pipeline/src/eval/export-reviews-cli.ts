import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "@job-agent/core";
import { loadEnvFile } from "../env.ts";
import { runExportReviews } from "./export-reviews.ts";

/** pnpm runs scripts from the package dir: relative default paths would point at the wrong place. */
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../..");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadEnvFile((t) => process.stderr.write(t));
  process.exitCode = runExportReviews({
    args: process.argv.slice(2),
    openDb: () => openDb(process.env["JOB_AGENT_DB"] ?? resolve(REPO_ROOT, "data/job-agent.db")),
    repoRoot: REPO_ROOT,
    cwd: process.env["INIT_CWD"] ?? process.cwd(),
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
  });
}
