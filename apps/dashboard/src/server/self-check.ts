import type { Db } from "@job-agent/core";
import { LOOPBACK } from "./guards.ts";
import { startServer } from "./server.ts";

const CHECKS: { path: string; describe?: (body: unknown) => string }[] = [
  { path: "/api/health" },
  { path: "/api/queue", describe: (body) => `items=${queueItems(body)}` },
];

/** Rows in the Top, Suspicious and Waiting sections (Needs a look repeats some of them). */
function queueItems(body: unknown): number {
  const sections = (body as { sections?: Record<string, unknown[]> } | undefined)?.sections;
  if (sections === undefined) return 0;
  return ["top", "suspicious", "waiting"].reduce((n, k) => n + (sections[k]?.length ?? 0), 0);
}

export async function selfCheck(
  db: Db,
  out: (line: string) => void,
  opts: { webDir?: string } = {},
): Promise<number> {
  const server = await startServer(db, { port: 0, logError: out, ...opts });
  let failed = false;
  try {
    for (const check of CHECKS) {
      try {
        const res = await fetch(`http://${LOOPBACK}:${server.port}${check.path}`);
        const body: unknown = await res.json().catch(() => undefined);
        out(
          `self-check ${check.path} ${res.status}${check.describe ? ` ${check.describe(body)}` : ""}`,
        );
        if (res.status !== 200) failed = true;
      } catch {
        out(`self-check ${check.path} error`);
        failed = true;
      }
    }
  } finally {
    await server.close();
  }
  return failed ? 1 : 0;
}
