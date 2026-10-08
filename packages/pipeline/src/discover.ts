import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  PartialSourceError,
  SourceError,
  log,
  postings,
  source_runs,
  type Db,
  type RawPosting,
  type SourceAdapter,
} from "@job-agent/core";

export interface DiscoverOptions {
  db: Db;
  adapters: SourceAdapter[];
  /** Run only the adapter with this name. */
  source?: string | undefined;
  /** Ignore the poll interval. */
  force?: boolean;
  now?: () => Date;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

const SINCE_FALLBACK_MS = 7 * 24 * 60 * 60 * 1000;

function lastOkStart(db: Db, source: string): Date | undefined {
  const row = db
    .select({ started_at: source_runs.started_at })
    .from(source_runs)
    .where(and(eq(source_runs.source, source), eq(source_runs.status, "ok")))
    .orderBy(desc(source_runs.started_at))
    .limit(1)
    .get();
  return row ? new Date(row.started_at) : undefined;
}

function storePostings(db: Db, items: RawPosting[], nowIso: string): number {
  let inserted = 0;
  db.transaction((tx) => {
    for (const p of items) {
      const existing = tx
        .select({ id: postings.id })
        .from(postings)
        .where(and(eq(postings.source, p.source), eq(postings.external_id, p.externalId)))
        .get();
      if (existing) {
        tx.update(postings).set({ last_seen_at: nowIso }).where(eq(postings.id, existing.id)).run();
        continue;
      }
      tx.insert(postings)
        .values({
          id: randomUUID(),
          source: p.source,
          external_id: p.externalId,
          url: p.url,
          apply_url: p.applyUrl ?? null,
          title: p.title,
          company_name: p.company,
          description_text: p.descriptionText ?? p.descriptionHtml ?? null,
          location_text: p.locationText ?? null,
          remote: p.remote ?? null,
          salary_text: p.salaryText ?? null,
          salary_min: p.salary?.min ?? null,
          salary_max: p.salary?.max ?? null,
          salary_currency: p.salary?.currency ?? null,
          salary_period: p.salary?.period ?? null,
          posted_at: p.postedAt ?? null,
          first_seen_at: nowIso,
          last_seen_at: nowIso,
        })
        .run();
      inserted++;
    }
  });
  return inserted;
}

/** Runs due adapters one after another. Returns the exit code: 1 if any adapter errored or the source name is unknown. */
export async function runDiscover(opts: DiscoverOptions): Promise<number> {
  const { db, adapters, force = false } = opts;
  const now = opts.now ?? (() => new Date());
  const out = opts.out ?? ((t: string) => process.stdout.write(t));
  const err = opts.err ?? ((t: string) => process.stderr.write(t));

  let selected = adapters;
  if (opts.source !== undefined) {
    selected = adapters.filter((a) => a.name === opts.source);
    if (selected.length === 0) {
      const names = adapters.map((a) => a.name).join(", ") || "(none registered)";
      err(`Unknown source: ${opts.source}. Valid sources: ${names}\n`);
      return 1;
    }
  }

  let errored = false;
  for (const adapter of selected) {
    const startedAt = now();
    const lastOk = lastOkStart(db, adapter.name);
    const record = (
      status: "ok" | "error" | "skipped",
      found: number,
      added: number,
      msg?: string,
    ) =>
      db
        .insert(source_runs)
        .values({
          id: randomUUID(),
          source: adapter.name,
          started_at: startedAt.toISOString(),
          finished_at: now().toISOString(),
          status,
          found,
          new: added,
          error_message: msg ?? null,
        })
        .run();

    const due =
      force ||
      lastOk === undefined ||
      startedAt.getTime() - lastOk.getTime() >= adapter.minIntervalMinutes * 60_000;
    if (!due) {
      record("skipped", 0, 0);
      out(`${adapter.name}: skipped (polled less than ${adapter.minIntervalMinutes} min ago)\n`);
      continue;
    }

    const since = lastOk ?? new Date(startedAt.getTime() - SINCE_FALLBACK_MS);
    try {
      const items = await adapter.fetch(since);
      const added = storePostings(db, items, startedAt.toISOString());
      const warning = adapter.takeWarnings?.().join("; ");
      record("ok", items.length, added, warning || undefined);
      out(`${adapter.name}: ok, found ${items.length}, new ${added}\n`);
      if (warning) out(`${adapter.name}: warning, ${warning}\n`);
    } catch (e) {
      errored = true;
      // Keep what the boards that worked returned; the run stays "error" so lastOk (and `since`) do not advance.
      let found = 0;
      let added = 0;
      if (e instanceof PartialSourceError) {
        found = e.postings.length;
        added = storePostings(db, e.postings, startedAt.toISOString());
      }
      // Only SourceError messages are guaranteed redacted; anything else is reduced to its type.
      const message =
        e instanceof SourceError
          ? e.message
          : `[${adapter.name}] unexpected error (${e instanceof Error ? e.name : "unknown"})`;
      log.error("discover adapter failed", { source: adapter.name, error: message });
      record("error", found, added, message);
      out(`${adapter.name}: error, ${message}\n`);
    }
  }
  return errored ? 1 : 0;
}
