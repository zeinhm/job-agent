import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  AnswerKeySchema,
  AnswerPatchSchema,
  AnswerStoreError,
  ChoiceMappingRefSchema,
  ChoiceMappingSaveSchema,
  DryRunReviewBodySchema,
  DryRunStoreError,
  InboxAnswerSchema,
  InboxError,
  InboxLinkSchema,
  NewAnswerSchema,
  answerInbox,
  createAnswer,
  dismissInbox,
  dryRunDoneWhen,
  exportAnswers,
  getDryRun,
  getDryRunDetail,
  linkInbox,
  listAllChoiceMappings,
  listAnswers,
  listDryRunRows,
  listInbox,
  matchQuestions,
  removeChoiceMapping,
  resolveScreenshot,
  reviewDryRun,
  saveChoiceMapping,
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
const InboxParams = z.object({ id: z.string().min(1).max(200) });

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
  /** The folder that holds the DB. Dry-run screenshots are served from `<dataDir>/dryruns/` only; unset = none served. */
  dataDir?: string;
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
    return c.json(
      {
        error: "invalid request",
        issues: e.paths.map((path, i) => ({ path, ...(e.rules[i] ? { rule: e.rules[i] } : {}) })),
      },
      400,
    );
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
      if (updated === null) return c.json({ error: "not found" }, 404);
      // An edit can clear approval, so coverage stored on posting questions is recomputed at once.
      matchQuestions(db);
      return c.json(updated);
    } catch (e) {
      return answerError(c, e);
    }
  });

  // Every inbox action re-runs matching and answers with the new open count.
  const inboxAction = (c: Context, run: () => unknown) => {
    try {
      return c.json(run());
    } catch (e) {
      if (!(e instanceof InboxError)) return answerError(c, e);
      if (e.kind === "not_found") return c.json({ error: "not found" }, 404);
      if (e.kind === "not_open") return c.json({ error: "not open" }, 409);
      return c.json({ error: "invalid request", issues: e.paths.map((path) => ({ path })) }, 400);
    }
  };

  app.get("/api/inbox", (c) => c.json(listInbox(db)));

  app.post("/api/inbox/:id/answer", async (c) => {
    const { id } = parseParams(c, InboxParams);
    const input = await parseBody(c, InboxAnswerSchema);
    return inboxAction(c, () => answerInbox(db, id, input, now()));
  });

  app.post("/api/inbox/:id/link", async (c) => {
    const { id } = parseParams(c, InboxParams);
    const { key } = await parseBody(c, InboxLinkSchema);
    return inboxAction(c, () => linkInbox(db, id, key, now()));
  });

  app.post("/api/inbox/:id/dismiss", async (c) => {
    const { id } = parseParams(c, InboxParams);
    await parseBody(c, z.strictObject({}));
    return inboxAction(c, () => dismissInbox(db, id));
  });

  // Choice mappings: the store throws field names only, so no response echoes an answer or an option text.
  const mappingError = (c: Context, e: unknown) => {
    if (!(e instanceof DryRunStoreError)) throw e;
    if (e.kind === "not_found") return c.json({ error: "not found" }, 404);
    return c.json({ error: "invalid request", issues: e.paths.map((path) => ({ path })) }, 400);
  };

  app.get("/api/choice-mappings", (c) => c.json({ mappings: listAllChoiceMappings(db) }));

  app.post("/api/choice-mappings", async (c) => {
    const input = await parseBody(c, ChoiceMappingSaveSchema);
    try {
      return c.json(saveChoiceMapping(db, input, now()), 201);
    } catch (e) {
      return mappingError(c, e);
    }
  });

  app.post("/api/choice-mappings/remove", async (c) => {
    const ref = await parseBody(c, ChoiceMappingRefSchema);
    if (!removeChoiceMapping(db, ref)) return c.json({ error: "not found" }, 404);
    return c.json({ removed: true });
  });

  // Dry runs. Filled values are personal data: they only travel to this local dashboard, and no log line carries them.
  app.get("/api/dry-runs", (c) =>
    c.json({ runs: listDryRunRows(db), doneWhen: dryRunDoneWhen(db) }),
  );

  app.get("/api/dry-runs/:id", (c) => {
    const { id } = parseParams(c, InboxParams);
    const detail = getDryRunDetail(db, id);
    if (detail === null) return c.json({ error: "not found" }, 404);
    return c.json(detail);
  });

  // Only the file whose path is stored on this run, resolved by realpath under <data dir>/dryruns/. Anything else is 404.
  app.get("/api/dry-runs/:id/screenshot", async (c) => {
    const { id } = parseParams(c, InboxParams);
    const notFound = () => c.json({ error: "not found" }, 404);
    if (opts.dataDir === undefined) return notFound();
    const run = getDryRun(db, id)?.run;
    const file = run === undefined ? null : resolveScreenshot(opts.dataDir, run.screenshot_path);
    if (file === null) return notFound();
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch {
      return notFound();
    }
    return c.body(new Uint8Array(bytes), 200, {
      "Content-Type": "image/png",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
  });

  app.post("/api/dry-runs/:id/review", async (c) => {
    const { id } = parseParams(c, InboxParams);
    const body = await parseBody(c, DryRunReviewBodySchema);
    const result = reviewDryRun(db, id, body, now());
    if (result === null) return c.json({ error: "not found" }, 404);
    return c.json({
      review: result.run.review,
      reason: result.run.review_reason,
      inboxOpen: result.inboxOpen,
      doneWhen: dryRunDoneWhen(db),
    });
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
