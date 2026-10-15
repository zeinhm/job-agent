import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  AnswerKeySchema,
  AnswerPatchSchema,
  AnswerStoreError,
  NewAnswerSchema,
  createAnswer,
  exportAnswers,
  listAnswers,
  updateAnswer,
} from "@job-agent/apply";
import type { Db, SalaryConfig } from "@job-agent/core";
import {
  getPostingDetail,
  getQueue,
  getStats,
  isDigestDate,
  jakartaDate,
  BulkReviewInputSchema,
  recordBulkReview,
  recordReview,
  ReviewBatchError,
  ReviewInputSchema,
  undoReviews,
  UndoInputSchema,
  ReviewRejectedError,
} from "@job-agent/pipeline/review";
import { hostGuard, mutationGuard, securityHeaders, type PortSource } from "./guards.ts";
import { staticHandler } from "./static.ts";
import { parseBody, parseParams, parseQuery } from "./validate.ts";

const QueueQuery = z.strictObject({ date: z.string().refine(isDigestDate).optional() });
const PostingParams = z.object({ id: z.string().min(1).max(200) });
const AnswerParams = z.object({ key: AnswerKeySchema });

export interface AppOptions {
  /** Clock, for the default day and review timestamps. */
  now?: () => Date;
  port: PortSource;
  /** Salary config, read only when an owner pay-policy mark needs a tier recompute. Throwing gives a 500. */
  salary?: () => SalaryConfig;
  /** Built web app (Vite output). Defaults to apps/dashboard/dist/web. */
  webDir?: string;
  /** Where `POST /api/answers/export` writes (data/exports next to the DB). Never config/. */
  exportsDir?: string;
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

  // Bulk and undo are all-or-nothing per request: any failure records nothing.
  const batchRoute = <T>(run: (now: Date) => T) => {
    try {
      return { ok: true as const, value: run((opts.now ?? (() => new Date()))()) };
    } catch (e) {
      if (e instanceof ReviewBatchError) return { ok: false as const, kind: e.kind };
      throw e;
    }
  };

  app.post("/api/reviews/bulk", async (c) => {
    const input = await parseBody(c, BulkReviewInputSchema);
    const r = batchRoute((now) => recordBulkReview(db, input, now));
    if (!r.ok) return c.json({ error: r.kind }, 404);
    return c.json({ recorded: r.value }, 201);
  });

  app.post("/api/reviews/undo", async (c) => {
    const input = await parseBody(c, UndoInputSchema);
    const r = batchRoute((now) => undoReviews(db, input.posting_ids, now));
    if (!r.ok) return c.json({ error: r.kind }, r.kind === "not_found" ? 404 : 409);
    return c.json({ recorded: r.value }, 201);
  });

  const now = () => (opts.now ?? (() => new Date()))();
  // Store errors carry field names only, so the response never echoes submitted values.
  const answerError = (c: Context, e: unknown) => {
    if (!(e instanceof AnswerStoreError)) throw e;
    if (e.kind === "exists") return c.json({ error: "exists" }, 409);
    if (e.kind === "not_found") return c.json({ error: "not found" }, 404);
    return c.json({ error: "invalid request", issues: e.paths.map((path) => ({ path })) }, 400);
  };

  app.get("/api/answers", (c) => c.json({ answers: listAnswers(db) }));

  app.post("/api/answers", async (c) => {
    const input = await parseBody(c, NewAnswerSchema);
    try {
      return c.json(createAnswer(db, input, now()), 201);
    } catch (e) {
      return answerError(c, e);
    }
  });

  // The export goes to data/exports (opts.exportsDir), never to config/; the response has the path and count only.
  app.post("/api/answers/export", (c) => {
    if (opts.exportsDir === undefined) {
      logError("dashboard error /api/answers/export 500");
      return c.json({ error: "exports not configured" }, 500);
    }
    const { path, count } = exportAnswers(db, opts.exportsDir, jakartaDate(now()));
    return c.json({ path, count });
  });

  app.patch("/api/answers/:key", async (c) => {
    const { key } = parseParams(c, AnswerParams);
    const patch = await parseBody(c, AnswerPatchSchema);
    try {
      const updated = updateAnswer(db, key, patch, now());
      return updated === null ? c.json({ error: "not found" }, 404) : c.json(updated);
    } catch (e) {
      return answerError(c, e);
    }
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
