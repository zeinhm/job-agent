import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import {
  defaultDbPath,
  disabledSources,
  fetchAndStoreFx,
  loadConfig,
  loadDisabledSources,
  openDb,
  source_runs,
} from "@job-agent/core";
import { buildAdapters } from "@job-agent/sources";
import { loadPollableCompanies, syncConfigCompanies } from "./companies.ts";
import { runResolveApply } from "./apply-links/index.ts";
import { runDigest } from "./digest/index.ts";
import { runDiscover } from "./discover.ts";
import { freshnessSuffix } from "./digest/freshness.ts";
import { runDiscoverCompanies } from "./discover-companies.ts";
import { loadEnvFile } from "./env.ts";
import { runEnrich } from "./enrich.ts";
import { runProcess } from "./process.ts";
import { runReprocess } from "./reprocess.ts";

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

type Command = (args: string[], io: Io) => Promise<number> | number;

const commands: Record<string, Command> = {
  discover: async (args, io) => {
    const { values } = parseArgs({
      args,
      options: { source: { type: "string" }, force: { type: "boolean", default: false } },
    });
    const db = openDb(defaultDbPath());
    try {
      const config = loadConfig();
      syncConfigCompanies(db, config);
      return await runDiscover({
        db,
        adapters: buildAdapters(config, loadPollableCompanies(db)),
        disabled: disabledSources(config),
        source: values.source,
        force: values.force,
        out: io.out,
        err: io.err,
      });
    } finally {
      db.$client.close();
    }
  },
  "discover-companies": async (_args, io) => {
    const db = openDb(defaultDbPath());
    try {
      return await runDiscoverCompanies({ db, out: io.out, err: io.err });
    } finally {
      db.$client.close();
    }
  },
  enrich: async (args, io) => {
    let limit: number | undefined;
    let noReextract = false;
    let reextractOnly = false;
    try {
      const { values } = parseArgs({
        args,
        options: {
          limit: { type: "string" },
          "no-reextract": { type: "boolean", default: false },
          "reextract-only": { type: "boolean", default: false },
        },
      });
      if (values.limit !== undefined) limit = Number(values.limit);
      noReextract = values["no-reextract"] === true;
      reextractOnly = values["reextract-only"] === true;
    } catch (e) {
      io.err(`enrich: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    let salary;
    try {
      salary = loadConfig().salary;
    } catch (e) {
      io.err(`enrich: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    const db = openDb(defaultDbPath());
    try {
      return await runEnrich({
        db,
        salary,
        limit,
        noReextract,
        reextractOnly,
        out: io.out,
        err: io.err,
      });
    } finally {
      db.$client.close();
    }
  },
  "resolve-apply": async (args, io) => {
    let limit: number | undefined;
    try {
      const { values } = parseArgs({ args, options: { limit: { type: "string" } } });
      if (values.limit !== undefined) limit = Number(values.limit);
    } catch (e) {
      io.err(`resolve-apply: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    const db = openDb(defaultDbPath());
    try {
      return await runResolveApply({
        db,
        limit,
        saveAts: {
          configDir: process.env["JOB_AGENT_CONFIG_DIR"] ?? "config",
          backupDir: join(dirname(defaultDbPath()), "backups"),
        },
        out: io.out,
        err: io.err,
      });
    } finally {
      db.$client.close();
    }
  },
  process: (args, io) => {
    let reprocess = false;
    try {
      const { values } = parseArgs({
        args,
        options: { reprocess: { type: "boolean", default: false } },
      });
      reprocess = values.reprocess === true;
    } catch (e) {
      io.err(`process: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    const db = openDb(defaultDbPath());
    try {
      const code = runProcess({ db, out: io.out, err: io.err });
      if (!reprocess) return code;
      return Math.max(code, runReprocess({ db, out: io.out, err: io.err }));
    } finally {
      db.$client.close();
    }
  },
  digest: (args, io) => {
    const { values } = parseArgs({
      args,
      options: {
        date: { type: "string" },
        "out-dir": { type: "string" },
        "include-unpaid": { type: "boolean" },
      },
    });
    const db = openDb(defaultDbPath());
    try {
      runDigest({
        disabledSources: loadDisabledSources(),
        ...(values["include-unpaid"] === true ? { includeUnpaid: true } : {}),
        db,
        ...(values.date !== undefined ? { date: values.date } : {}),
        ...(values["out-dir"] !== undefined ? { outDir: values["out-dir"] } : {}),
        out: io.out,
      });
      return 0;
    } catch (e) {
      io.err(`digest failed: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    } finally {
      db.$client.close();
    }
  },
  status: (_args, io) => {
    const db = openDb(defaultDbPath());
    try {
      const tables = db
        .all<{
          name: string;
        }>(sql`select name from sqlite_master where type = 'table' order by name`)
        .filter(({ name }) => !name.startsWith("sqlite_") && !name.startsWith("__"));
      io.out("row counts\n");
      for (const { name } of tables) {
        const row = db.get<{ n: number }>(sql.raw(`select count(*) as n from "${name}"`));
        io.out(`  ${name}: ${row.n}\n`);
      }
      // Latest run per source; started_at is ISO so string order is time order.
      const runs = db.select().from(source_runs).orderBy(source_runs.started_at).all();
      const latest = new Map(runs.map((r) => [r.source, r]));
      io.out("source status (latest run)\n");
      const disabled = loadDisabledSources();
      for (const r of [...latest.values()].sort((a, b) => a.source.localeCompare(b.source))) {
        if (disabled.includes(r.source)) {
          io.out(`  ${r.source}: disabled\n`);
          continue;
        }
        const detail = r.error_message ? `, ${r.error_message}` : "";
        const fresh = freshnessSuffix(db, r.source, new Date());
        io.out(
          `  ${r.source}: ${r.status}, found ${r.found}, new ${r.new}${detail}${fresh !== undefined ? ` — ${fresh}` : ""}\n`,
        );
      }
      return 0;
    } finally {
      db.$client.close();
    }
  },
  fx: async (_args, io) => {
    const db = openDb(defaultDbPath());
    try {
      const rows = await fetchAndStoreFx(db);
      for (const r of rows) io.out(`${r.date} USD/${r.quote} ${r.rate}\n`);
      return 0;
    } catch (e) {
      io.err(`fx failed: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    } finally {
      db.$client.close();
    }
  },
};

const usage = (): string =>
  `Usage: job-agent <command> [options]\n\nCommands:\n${
    Object.keys(commands)
      .map((name) => `  ${name}`)
      .join("\n") || "  (none yet)"
  }\n\nOptions:\n  process --reprocess  re-apply the current rules and resolve to every stored posting (no LLM call)\n`;

export async function main(
  argv: string[],
  io: Io = {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
  },
): Promise<number> {
  // The command is the first argument; the rest (flags with values) belongs to the command's own parser.
  const [name, ...rest] = argv;
  const command = name === undefined ? undefined : commands[name];
  if (name === undefined || command === undefined) {
    if (name !== undefined) io.err(`Unknown command: ${name}\n`);
    io.err(usage());
    return 1;
  }
  return command(rest, io);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Before any command, so cron needs no keys in the crontab. Not inside main(): tests call main() and must not read a real .env.
  loadEnvFile((t) => process.stderr.write(t));
  process.exitCode = await main(process.argv.slice(2));
}
