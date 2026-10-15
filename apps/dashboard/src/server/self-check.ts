import type { Db } from "@job-agent/core";
import { LOOPBACK } from "./guards.ts";
import { startServer } from "./server.ts";

// Routes the self-check requests. /api/queue joins this list in the card that adds that route.
const CHECKS: { path: string; describe?: (body: unknown) => string }[] = [{ path: "/api/health" }];

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
