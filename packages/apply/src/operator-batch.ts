import { dry_runs, type Db } from "@job-agent/core";
import { and, asc, eq, gte, sql } from "drizzle-orm";

/** Owner decision 1 (gate t_fb1ae4e8): 5 real forms per batch for the first 3 batches, then 10. */
export const EARLY_BATCH_RUNS = 5;
export const LATER_BATCH_RUNS = 10;
export const EARLY_BATCHES = 3;

/** A batch id is printed and stored, so it is a short plain token. */
export const BATCH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface BatchState {
  /** Runs recorded for the batch: every run counts, a re-run of a posting too, whatever its status. */
  runs: number;
  /** The maximum for this batch: 5 while it is one of the first 3 batches ever started, else 10. */
  limit: number;
  /** A run of the batch stopped on a CAPTCHA: the whole batch is halted. */
  captchaHalt: boolean;
  /** The operator started the window maximum of runs in the last 24 h, in any batch. */
  windowFull: boolean;
}

/** The operator's batches, oldest first (by the first run of each). */
function batchOrder(db: Db): string[] {
  return db
    .select({ batch: dry_runs.operator_batch })
    .from(dry_runs)
    .where(eq(dry_runs.started_by, "operator"))
    .groupBy(dry_runs.operator_batch)
    .orderBy(asc(sql`min(${dry_runs.started_at})`), asc(dry_runs.operator_batch))
    .all()
    .flatMap((r) => (r.batch === null ? [] : [r.batch]));
}

/**
 * The batch id is chosen by the agent, so it cannot be the only limit: whatever the id, the operator starts at most the
 * later-batch maximum of real forms in a rolling window, and a CAPTCHA stop halts every batch for the same window.
 */
export const OPERATOR_WINDOW_MS = 24 * 60 * 60 * 1000;
export const OPERATOR_WINDOW_RUNS = LATER_BATCH_RUNS;

/** Runs, maximum and CAPTCHA halt of an operator batch (a batch with no run yet counts as the newest one). */
export function batchState(db: Db, batchId: string, now: Date = new Date()): BatchState {
  const order = batchOrder(db);
  const at = order.indexOf(batchId);
  const rank = at === -1 ? order.length + 1 : at + 1;
  const rows = db
    .select({ stop: dry_runs.stop_reason })
    .from(dry_runs)
    .where(and(eq(dry_runs.started_by, "operator"), eq(dry_runs.operator_batch, batchId)))
    .all();
  const since = new Date(now.getTime() - OPERATOR_WINDOW_MS).toISOString();
  const recent = db
    .select({ stop: dry_runs.stop_reason })
    .from(dry_runs)
    .where(and(eq(dry_runs.started_by, "operator"), gte(dry_runs.started_at, since)))
    .all();
  return {
    runs: rows.length,
    limit: rank <= EARLY_BATCHES ? EARLY_BATCH_RUNS : LATER_BATCH_RUNS,
    captchaHalt: rows.some((r) => r.stop === "captcha") || recent.some((r) => r.stop === "captcha"),
    windowFull: recent.length >= OPERATOR_WINDOW_RUNS,
  };
}
