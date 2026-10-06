import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

type Command = (args: string[], io: Io) => Promise<number> | number;

// Commands are added by the tasks that own them: discover, fx, process, digest.
const commands: Record<string, Command> = {};

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
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, strict: false });
  const [name, ...rest] = positionals;
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
