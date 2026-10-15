import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Db } from "@job-agent/core";
import { hostGuard, mutationGuard, securityHeaders, type PortSource } from "./guards.ts";
import { staticHandler } from "./static.ts";

export interface AppOptions {
  port: PortSource;
  /** Built web app (Vite output). Defaults to apps/dashboard/dist/web. */
  webDir?: string;
  /** Error log sink; one line per error, never bodies or row content. */
  logError?: (line: string) => void;
}

export const defaultWebDir = fileURLToPath(new URL("../../dist/web", import.meta.url));

export function createApp(db: Db, opts: AppOptions): Hono {
  const logError = opts.logError ?? ((line: string) => console.error(line));
  const app = new Hono();

  app.use(securityHeaders);
  app.use(hostGuard(opts.port));
  app.use(mutationGuard(opts.port));

  app.get("/api/health", (c) => {
    try {
      db.$client.prepare("select 1").get();
    } catch {
      logError("dashboard error /api/health db");
      return c.json({ ok: false, db: "error" }, 503);
    }
    return c.json({ ok: true, db: "ok" });
  });

  // Last resort for anything no route matched: static files, SPA fallback, JSON 404 for /api.
  app.notFound(staticHandler(opts.webDir ?? defaultWebDir));

  app.onError((err, c) => {
    if (err instanceof HTTPException && err.status < 500) return err.getResponse();
    const code = err instanceof HTTPException ? err.status : 500;
    // routePath is the route pattern, never the request URL or its values.
    logError(`dashboard error ${c.req.routePath} ${code}`);
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}
