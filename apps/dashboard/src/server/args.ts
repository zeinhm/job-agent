const DEFAULT_PORT = 4510;

export function parseArgs(argv: string[]): { port: number; selfCheck: boolean } | undefined {
  let port = DEFAULT_PORT;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--self-check") check = true;
    else if (arg === "--port") {
      const raw = argv[++i];
      if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
      port = Number(raw);
      if (port < 1 || port > 65535) return undefined;
    } else return undefined;
  }
  return { port, selfCheck: check };
}
