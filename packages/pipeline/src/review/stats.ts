import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { dryRunDoneWhen, type DryRunDoneWhen } from "@job-agent/apply";
import { reviews, type Db } from "@job-agent/core";
import { getQueue } from "./queue.ts";
import { reviewHistory } from "./record.ts";
import { reviewState } from "./state.ts";

export const DONE_WHEN_MINUTES = 30;
/** PLAN 5.6: at least this many ask checks per tier before the ask is trusted. */
export const ASK_CHECK_TARGET = 20;
export const ASK_TIERS = ["indonesia", "regional", "global_adjusted", "global_flat"] as const;
export type AskTier = (typeof ASK_TIERS)[number];

export interface AskCheckCounts {
  ok: number;
  too_high: number;
  too_low: number;
  total: number;
  /** `total` reaches {@link ASK_CHECK_TARGET}. */
  enough: boolean;
}

export interface DayStats {
  date: string;
  /**
   * Unique postings in Top matches and Suspicious (Needs a look repeats entries, Waiting is not counted), plus the
   * postings that got a processing action on the day but are no longer listed (a reviewed posting can leave Top).
   */
  matches: number;
  processed: number;
  open: number;
  firstReviewAt: string | null;
  lastReviewAt: string | null;
  /** First to last review action of the day; 0 with fewer than two actions. */
  elapsedMinutes: number;
  /** Median seconds between a processing action and the review action before it; null without such a gap. */
  medianSecondsPerPosting: number | null;
  /** Review rows recorded on the day, by action. */
  actions: Record<string, number>;
  /** `not_interested` rows recorded on the day, by reason. */
  reasons: Record<string, number>;
  /** Ask checks of all days up to and including `date` (the target is cumulative per tier), by the tier at review time. */
  askChecks: Record<AskTier, AskCheckCounts> & { target: number };
  /** All matches processed and elapsed <= 30 minutes. Never met with zero matches. */
  doneWhenMet: boolean;
  /** Owner-run dry runs reviewed so far (all days; fixture runs never count). */
  dryRuns: DryRunDoneWhen;
}

export interface WeekEntry {
  date: string;
  matches: number;
  processed: number;
  open: number;
  elapsedMinutes: number;
  doneWhenMet: boolean;
}

export interface Stats extends DayStats {
  /** The 7 days ending at `date`, oldest first. */
  week: WeekEntry[];
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const m =
    s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
  return Math.round(m);
}

const STATUS_PROCESSED = new Set(["interested", "applied_manually", "not_interested"]);

function emptyAsk(): Stats["askChecks"] {
  const one = (): AskCheckCounts => ({ ok: 0, too_high: 0, too_low: 0, total: 0, enough: false });
  return {
    indonesia: one(),
    regional: one(),
    global_adjusted: one(),
    global_flat: one(),
    target: ASK_CHECK_TARGET,
  };
}

/** Pure computation of the day's review numbers from the stored queue and review rows (phase 4 conventions, section 9). */
export function computeDayStats(db: Db, date: string): DayStats {
  const queue = getQueue(db, date);
  const seen = new Map<string, boolean>();
  for (const item of [...queue.sections.top, ...queue.sections.suspicious])
    seen.set(item.postingId, item.review.processed);

  const rows = db
    .select()
    .from(reviews)
    .where(eq(reviews.review_day, date))
    .orderBy(asc(reviews.reviewed_at), sql`rowid`)
    .all();

  // A posting reviewed on the day counts as a match even when it left the queue because of that review.
  const reviewedIds = [
    ...new Set(rows.filter((r) => STATUS_PROCESSED.has(r.action)).map((r) => r.posting_id)),
  ].filter((pid) => !seen.has(pid));
  const history = reviewHistory(db, reviewedIds);
  for (const pid of reviewedIds) seen.set(pid, reviewState(history.get(pid) ?? []).processed);
  const matches = seen.size;
  const processed = [...seen.values()].filter(Boolean).length;

  const actions: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  const gaps: number[] = [];
  const doneIds = new Set<string>();
  rows.forEach((r, i) => {
    actions[r.action] = (actions[r.action] ?? 0) + 1;
    if (r.action === "not_interested" && r.reason !== null)
      reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
    // A posting's first processing action of the day, timed from the review action before it.
    if (i > 0 && STATUS_PROCESSED.has(r.action) && !doneIds.has(r.posting_id)) {
      const prev = rows[i - 1] as (typeof rows)[number];
      gaps.push((Date.parse(r.reviewed_at) - Date.parse(prev.reviewed_at)) / 1000);
    }
    if (STATUS_PROCESSED.has(r.action)) doneIds.add(r.posting_id);
  });

  const first = rows[0]?.reviewed_at ?? null;
  const last = rows[rows.length - 1]?.reviewed_at ?? null;
  const elapsedMinutes =
    first === null || last === null ? 0 : round1((Date.parse(last) - Date.parse(first)) / 60000);

  const askChecks = emptyAsk();
  const askRows = db
    .select({ action: reviews.action, tier: reviews.tier })
    .from(reviews)
    .where(
      and(
        lte(reviews.review_day, date),
        inArray(reviews.action, ["ask_ok", "ask_too_high", "ask_too_low"]),
      ),
    )
    .all();
  for (const r of askRows) {
    if (r.tier === null) continue;
    const c = askChecks[r.tier];
    if (r.action === "ask_ok") c.ok++;
    else if (r.action === "ask_too_high") c.too_high++;
    else if (r.action === "ask_too_low") c.too_low++;
    else continue;
    c.total++;
  }
  for (const t of ASK_TIERS) askChecks[t].enough = askChecks[t].total >= ASK_CHECK_TARGET;

  return {
    date,
    matches,
    processed,
    open: matches - processed,
    firstReviewAt: first,
    lastReviewAt: last,
    elapsedMinutes,
    medianSecondsPerPosting: median(gaps),
    actions,
    reasons,
    askChecks,
    doneWhenMet: matches > 0 && processed === matches && elapsedMinutes <= DONE_WHEN_MINUTES,
    dryRuns: dryRunDoneWhen(db),
  };
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function getStats(db: Db, date: string): Stats {
  const week: WeekEntry[] = [];
  for (let back = 6; back >= 0; back--) {
    const s = computeDayStats(db, addDays(date, -back));
    week.push({
      date: s.date,
      matches: s.matches,
      processed: s.processed,
      open: s.open,
      elapsedMinutes: s.elapsedMinutes,
      doneWhenMet: s.doneWhenMet,
    });
  }
  return { ...computeDayStats(db, date), week };
}

/** The line the phase report quotes. */
export function doneWhenLine(s: DayStats): string {
  return `done-when: ${s.elapsedMinutes} min for ${s.matches} matches (${s.doneWhenMet ? "met" : "not met"})`;
}

/** Counts and times only: no titles, companies or notes. */
export function formatStats(s: DayStats): string {
  const kv = (o: Record<string, number>) =>
    Object.keys(o).length === 0
      ? "none"
      : Object.entries(o)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k} ${v}`)
          .join(", ");
  const lines = [
    `review stats ${s.date}`,
    `matches: ${s.matches}, processed: ${s.processed}, open: ${s.open}`,
    `first review: ${s.firstReviewAt ?? "-"}, last review: ${s.lastReviewAt ?? "-"}`,
    `elapsed: ${s.elapsedMinutes} min, median per processed posting: ${
      s.medianSecondsPerPosting === null ? "-" : `${s.medianSecondsPerPosting} s`
    }`,
    `actions: ${kv(s.actions)}`,
    `not_interested reasons: ${kv(s.reasons)}`,
    `ask checks (target ${s.askChecks.target} per tier):`,
    ...ASK_TIERS.map((t) => {
      const c = s.askChecks[t];
      return `  ${t}: ok ${c.ok}, too_high ${c.too_high}, too_low ${c.too_low}, total ${c.total}/${s.askChecks.target}`;
    }),
    doneWhenLine(s),
    s.dryRuns.line,
  ];
  return `${lines.join("\n")}\n`;
}
