import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "@job-agent/core";
import { runExportReviews } from "./export-reviews.ts";

/** pnpm runs scripts from the package dir: a relative default DB path would point at the wrong place. */
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../..");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDb(process.env["JOB_AGENT_DB"] ?? resolve(REPO_ROOT, "data/job-agent.db"));
  try {
    process.exitCode = runExportReviews({
      args: process.argv.slice(2),
      db,
      repoRoot: REPO_ROOT,
      out: (t) => process.stdout.write(t),
      err: (t) => process.stderr.write(t),
    });
  } finally {
    db.$client.close();
  }
}
