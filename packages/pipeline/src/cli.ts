import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { defaultDbPath, fetchAndStoreFx, loadConfig, openDb, source_runs } from "@job-agent/core";
import { buildAdapters } from "@job-agent/sources";
import { runDigest } from "./digest/index.ts";
import { runDiscover } from "./discover.ts";
import { runEnrich } from "./enrich.ts";
import { runProcess } from "./process.ts";

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
      return await runDiscover({
        db,
        adapters: buildAdapters(loadConfig()),
        source: values.source,
        force: values.force,
        out: io.out,
        err: io.err,
      });
    } finally {
      db.$client.close();
    }
  },
  enrich: async (args, io) => {
    let limit: number | undefined;
    try {
      const { values } = parseArgs({ args, options: { limit: { type: "string" } } });
      if (values.limit !== undefined) limit = Number(values.limit);
    } catch (e) {
      io.err(`enrich: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    const db = openDb(defaultDbPath());
    try {
      return await runEnrich({ db, limit, out: io.out, err: io.err });
    } finally {
      db.$client.close();
    }
  },
  process: (_args, io) => {
    const db = openDb(defaultDbPath());
    try {
      return runProcess({ db, out: io.out, err: io.err });
    } finally {
      db.$client.close();
    }
  },
  digest: (args, io) => {
    const { values } = parseArgs({
      args,
      options: { date: { type: "string" }, "out-dir": { type: "string" } },
    });
    const db = openDb(defaultDbPath());
    try {
      runDigest({
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
        .all<{ name: string }>(
          sql`select name from sqlite_master where type = 'table' order by name`,
        )
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
      for (const r of [...latest.values()].sort((a, b) => a.source.localeCompare(b.source))) {
        const detail = r.error_message ? `, ${r.error_message}` : "";
        io.out(`  ${r.source}: ${r.status}, found ${r.found}, new ${r.new}${detail}\n`);
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
  }\n`;

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
  process.exitCode = await main(process.argv.slice(2));
}
