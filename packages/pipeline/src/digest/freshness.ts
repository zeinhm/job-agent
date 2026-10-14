import { and, eq, gte } from "drizzle-orm";
import { source_runs, type Db } from "@job-agent/core";
import { blockBackoffUntil } from "../discover.ts";

/** Longest allowed gap between `ok` runs (and from the last `ok` to now), per source (docs/phase-3-conventions.md "Freshness"). */
export const FRESHNESS_MAX_GAP_MIN: Readonly<Record<string, number>> = {
  linkedin: 65,
  indeed: 130,
};

const DAY_MS = 24 * 3_600_000;

/** HH:MM in Asia/Jakarta, with the WIB label. */
export function wibTime(d: Date): string {
  const t = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
  return `${t} WIB`;
}

/**
 * Freshness suffix for a source with a freshness threshold, e.g. `last ok 14:05 WIB, max gap 60 min in 24h`,
 * plus ` — LATE` when a gap between consecutive ok runs in the last 24h, or the gap from the last ok run to now,
 * exceeds the threshold and
 * ` — in backoff until HH:MM WIB` while a block backoff holds. Undefined for sources without a threshold.
 */
export function freshnessSuffix(db: Db, source: string, now: Date): string | undefined {
  const limit = FRESHNESS_MAX_GAP_MIN[source];
  if (limit === undefined) return undefined;
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const starts = db
    .select({ started_at: source_runs.started_at })
    .from(source_runs)
    .where(
      and(
        eq(source_runs.source, source),
        eq(source_runs.status, "ok"),
        gte(source_runs.started_at, since),
      ),
    )
    .all()
    .map((r) => new Date(r.started_at).getTime())
    .sort((a, b) => a - b);

  let text: string;
  let late = false;
  if (starts.length === 0) text = "no ok run in 24h";
  else {
    // Gaps between consecutive ok runs, plus the open gap from the last ok run to now.
    const lastMs = starts[starts.length - 1] ?? 0;
    let maxGap = Math.round((now.getTime() - lastMs) / 60_000);
    for (let i = 1; i < starts.length; i++)
      maxGap = Math.max(maxGap, Math.round(((starts[i] ?? 0) - (starts[i - 1] ?? 0)) / 60_000));
    late = maxGap > limit;
    text = `last ok ${wibTime(new Date(lastMs))}, max gap ${maxGap} min in 24h`;
  }
  const backoff = blockBackoffUntil(db, source, now);
  return `${text}${late ? " — LATE" : ""}${backoff ? ` — in backoff until ${wibTime(backoff)}` : ""}`;
}
