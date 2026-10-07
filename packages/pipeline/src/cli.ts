import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { defaultDbPath, fetchAndStoreFx, loadConfig, openDb } from "@job-agent/core";
import { buildAdapters } from "@job-agent/sources";
import { runDiscover } from "./discover.ts";

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

type Command = (args: string[], io: Io) => Promise<number> | number;

// Commands are added by the tasks that own them: process, digest.
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
