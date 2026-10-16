import { dirname, join } from "node:path";
import { defaultDbPath, loadConfig, openDb } from "@job-agent/core";
import { parseArgs } from "./args.ts";
import { selfCheck } from "./self-check.ts";
import { startServer } from "./server.ts";

const USAGE = "usage: pnpm dashboard [--port <n>] [--self-check]";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(USAGE);
    process.exit(2);
  }
  const dbPath = defaultDbPath();
  const db = openDb(dbPath);
  if (args.selfCheck) {
    process.exit(await selfCheck(db, (line) => console.log(line)));
  }
  try {
    const server = await startServer(db, {
      port: args.port,
      // data/exports next to the DB; the product never writes config/.
      exportsDir: join(dirname(dbPath), "exports"),
      dataDir: dirname(dbPath),
      salary: () => loadConfig().salary,
    });
    console.log(`dashboard: http://127.0.0.1:${server.port}/`);
    const stop = () => void server.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "error";
    console.error(`dashboard: cannot listen on 127.0.0.1:${args.port} (${code})`);
    process.exit(1);
  }
}

await main();
