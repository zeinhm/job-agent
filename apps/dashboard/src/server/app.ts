import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db, SalaryConfig } from "@job-agent/core";
import {
  getPostingDetail,
  getQueue,
  getStats,
  isDigestDate,
  jakartaDate,
  recordReview,
  ReviewInputSchema,
  ReviewRejectedError,
} from "@job-agent/pipeline/review";
import { hostGuard, mutationGuard, securityHeaders, type PortSource } from "./guards.ts";
import { staticHandler } from "./static.ts";
import { parseBody, parseParams, parseQuery } from "./validate.ts";

const QueueQuery = z.strictObject({ date: z.string().refine(isDigestDate).optional() });
const PostingParams = z.object({ id: z.string().min(1).max(200) });

export interface AppOptions {
  /** Clock, for the default day and review timestamps. */
  now?: () => Date;
  port: PortSource;
  /** Salary config, read only when an owner pay-policy mark needs a tier recompute. Throwing gives a 500. */
  salary?: () => SalaryConfig;
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

  const today = () => jakartaDate((opts.now ?? (() => new Date()))());

  app.get("/api/queue", (c) => {
    const { date } = parseQuery(c, QueueQuery);
    return c.json(getQueue(db, date ?? today()));
  });

  app.get("/api/stats", (c) => {
    const { date } = parseQuery(c, QueueQuery);
    return c.json(getStats(db, date ?? today()));
  });

  app.get("/api/postings/:id", (c) => {
    const { id } = parseParams(c, PostingParams);
    const detail = getPostingDetail(db, id);
    if (detail === null) return c.json({ error: "not found" }, 404);
    return c.json(detail);
  });

  app.post("/api/reviews", async (c) => {
    const input = await parseBody(c, ReviewInputSchema);
    let recorded;
    try {
      recorded = recordReview(db, input, (opts.now ?? (() => new Date()))(), {
        ...(opts.salary !== undefined ? { salary: opts.salary } : {}),
      });
    } catch (e) {
      if (e instanceof ReviewRejectedError) return c.json({ error: e.message }, 400);
      throw e;
    }
    if (recorded === null) return c.json({ error: "not found" }, 404);
    return c.json(recorded, 201);
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
