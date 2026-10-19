import { dry_runs, type Db } from "@job-agent/core";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";

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
  /** The operator started the daily ceiling of runs in the last 24 h, in any batch. */
  dailyCeilingReached: boolean;
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
 * The batch id is chosen by the agent, so it cannot be the only limit. Owner decision (t_fad1b0cd): the limit is per batch,
 * plus a safety ceiling of 100 real forms in a rolling 24 h window whatever the batch id, so a re-run batch after a merged
 * fix can start the same day. A CAPTCHA stop halts every batch for the same window.
 */
export const OPERATOR_WINDOW_MS = 24 * 60 * 60 * 1000;
export const OPERATOR_DAILY_CEILING = 100;

/** Owner decision (t_92965933): a random gap of 60 to 120 s between two real operator forms, the main IP safeguard. */
export const PACING_MIN_S = 60;
export const PACING_MAX_S = 120;

/** The gap (ms) after the operator run `prevRunId`: stable per run (a retry sees the same one), varied between runs (FNV-1a). */
export function pacingGapMs(prevRunId: string): number {
  let h = 0x811c9dc5;
  for (const c of prevRunId) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return (PACING_MIN_S + (h % (PACING_MAX_S - PACING_MIN_S + 1))) * 1000;
}

/**
 * Seconds the operator still has to wait before its next real form (0 = go). Only operator runs count: an owner run
 * neither waits nor makes the operator wait. The gap runs from the end of the previous operator run.
 */
export function pacingWaitSeconds(
  db: Db,
  nowMs: number,
  gapMs: (prevRunId: string) => number = pacingGapMs,
): number {
  const last = db
    .select({ id: dry_runs.id, started: dry_runs.started_at, finished: dry_runs.finished_at })
    .from(dry_runs)
    .where(eq(dry_runs.started_by, "operator"))
    .orderBy(desc(dry_runs.started_at))
    .limit(1)
    .get();
  if (last === undefined) return 0;
  const end = Date.parse(last.finished ?? last.started);
  if (Number.isNaN(end)) return 0;
  const remaining = end + gapMs(last.id) - nowMs;
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

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
    dailyCeilingReached: recent.length >= OPERATOR_DAILY_CEILING,
  };
}
