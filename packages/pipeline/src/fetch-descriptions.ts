import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  analysis,
  apply_links,
  description_runs,
  intel,
  loadConfig,
  log,
  postings,
  source_runs,
  SourceBlockedError,
  SourceError,
  SourceSkippedError,
  type Db,
  type Posting,
} from "@job-agent/core";
import { SEARCH_GAP_MS, type DetailFetcher } from "@job-agent/sources";
import { dedupeHash, normalizeTitle } from "./dedupe/index.ts";
import { BLOCKED_PREFIX, blockBackoffUntil } from "./discover.ts";
import {
  DESCRIPTION_SOURCE,
  descriptionBackoffUntil,
  descriptionPendingSql,
  DETAIL_BACKOFF_HOURS,
} from "./description-state.ts";
import { ATS_SOURCE_NAMES } from "./filters/keywords.ts";
import { classifyLocation } from "./filters/location.ts";
import { classifyRole } from "./filters/role.ts";
import { normalizeCompanyName } from "./normalize/index.ts";
import { analyze } from "./process.ts";

/** At most this many LinkedIn detail requests in one run; the postings left over wait for the next run (newest first). */
export const MAX_DETAIL_REQUESTS_PER_RUN = 3;
/** At least this long between two detail requests (the first one waits SEARCH_GAP_MS after the search's last request). */
export const DETAIL_GAP_MS = 45_000;
/** Only postings first seen within this window get a LinkedIn detail request; older ones stay description_missing. */
export const DETAIL_MAX_AGE_MS = 24 * 3_600_000;
/** A posting gets this many counted failures (a 429 on it included), then it is `description_unavailable` (title only). */
export const MAX_DESCRIPTION_ATTEMPTS = 3;
/** A posting that failed on this many runs while another posting got its description meanwhile is given up (a poison job). */
export const POISON_FAILED_RUNS = 2;
export interface FetchDescriptionsOptions {
  db: Db;
  fetchDescription: DetailFetcher;
  /** Default setTimeout. Tests inject a fake that advances their fake clock. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  floorIdrMonth?: number;
  /** Default MAX_DETAIL_REQUESTS_PER_RUN. */
  maxRequests?: number;
  out: (text: string) => void;
  err: (text: string) => void;
}

/**
 * LinkedIn postings worth a detail request: no description yet, not given up, the title passes the role rule and the
 * posting's own location text is not `restricted`; fewest failures first, then newest first (a posting that failed goes to
 * the end of the order). Nothing else is fetched.
 */
export function selectForDescription(db: Db): Posting[] {
  return db
    .select()
    .from(postings)
    .where(
      and(
        descriptionPendingSql,
        isNull(postings.canonical_posting_id),
        isNotNull(postings.normalized_at),
      ),
    )
    .orderBy(
      postings.description_attempts,
      desc(sql`coalesce(${postings.posted_at}, ${postings.first_seen_at})`),
      desc(postings.first_seen_at),
      postings.id,
    )
    .all()
    .filter(
      (p) =>
        classifyRole({ title: p.title, descriptionText: null }).class !== "reject" &&
        classifyLocation({ locationText: p.location_text, descriptionText: null, remote: p.remote })
          .class !== "restricted",
    );
}

/** The text of the same job (same company, same normalized title) on an ATS board the DB already holds, or undefined. */
function atsDescription(db: Db, p: Posting): string | undefined {
  const key = normalizeCompanyName(p.company_name) || "unknown";
  const hashes = [...new Set([p.dedupe_hash, dedupeHash(key, p.title)])].filter(
    (h): h is string => h !== null,
  );
  const link = db.select().from(apply_links).where(eq(apply_links.posting_id, p.id)).get();
  const urls = [p.apply_url, link?.apply_url].filter((u): u is string => !!u);
  const sameJob: SQL[] = [inArray(postings.dedupe_hash, hashes)];
  if (urls.length > 0) sameJob.push(inArray(postings.url, urls), inArray(postings.apply_url, urls));
  const wanted = normalizeTitle(p.title);
  const rows = db
    .select()
    .from(postings)
    .where(
      and(
        inArray(postings.source, [...ATS_SOURCE_NAMES]),
        isNotNull(postings.description_text),
        or(...sameJob),
      ),
    )
    .orderBy(desc(postings.last_seen_at), postings.id)
    .all();
  return rows
    .find((r) => normalizeTitle(r.title) === wanted && (r.description_text ?? "").trim() !== "")
    ?.description_text?.trim();
}

/** Start of the latest LinkedIn request the search made: the end of its latest run that was not skipped. */
function lastSearchRequestAt(db: Db): number | undefined {
  const row = db
    .select({ finished_at: source_runs.finished_at, status: source_runs.status })
    .from(source_runs)
    .where(eq(source_runs.source, DESCRIPTION_SOURCE))
    .orderBy(desc(source_runs.started_at))
    .all()
    .find((r) => r.status !== "skipped");
  return row === undefined ? undefined : new Date(row.finished_at).getTime();
}

/** Counts one failed request of a posting (any kind, a 429 included); returns what the end-of-run poison check needs. */
function recordFailure(db: Db, p: Posting, at: Date, block: boolean) {
  const attempts = p.description_attempts + 1;
  db.update(postings)
    .set({
      description_attempts: attempts,
      description_failed_at: at.toISOString(),
      ...(block ? { description_blocked_at: at.toISOString() } : {}),
    })
    .where(eq(postings.id, p.id))
    .run();
  return { id: p.id, before: p.description_failed_at, attempts };
}

/** Another posting than `id` got a 429 less than DETAIL_BACKOFF_HOURS ago (this run or an earlier one): the block rule. */
function otherBlockedWithin(db: Db, id: string, at: Date): boolean {
  const since = new Date(at.getTime() - DETAIL_BACKOFF_HOURS * 3_600_000).toISOString();
  return (
    db
      .select({ id: postings.id })
      .from(postings)
      .where(and(ne(postings.id, id), gte(postings.description_blocked_at, since)))
      .limit(1)
      .get() !== undefined
  );
}

/** A block is the source's, not the postings': take back the attempt of every posting with a pending 429 mark. */
function takeBackBlocks(db: Db): void {
  db.update(postings)
    .set({
      description_attempts: sql`max(${postings.description_attempts} - 1, 0)`,
      description_blocked_at: null,
    })
    .where(isNotNull(postings.description_blocked_at))
    .run();
}

/** A run that finished after `since` (the posting's earlier failure) brought at least one description. */
function fetchedSince(db: Db, since: string | null): boolean {
  if (since === null) return false;
  return (
    db
      .select({ id: description_runs.id })
      .from(description_runs)
      .where(
        and(
          eq(description_runs.source, DESCRIPTION_SOURCE),
          gte(description_runs.finished_at, since),
          gt(description_runs.fetched, 0),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

/**
 * The description arrived: store it, run every rule again for this posting (location, Indonesia, role, salary, language),
 * drop `description_missing` with the new analysis row, and clear what was derived from the title alone so `enrich`
 * extracts the text (the same clean-up as an edited posting in discover).
 * `content_hash` is left alone on purpose: it hashes what the search returns, so the next search does not see an edit.
 */
function applyDescription(
  db: Db,
  p: Posting,
  description: string,
  floor: number,
  now: Date,
): { rejected: boolean } {
  return db.transaction((tx) => {
    const t = tx as unknown as Db;
    t.update(postings)
      .set({
        description_text: description.trim(),
        description_unavailable_at: null,
        description_blocked_at: null,
        updated_at: now.toISOString(),
      })
      .where(eq(postings.id, p.id))
      .run();
    const fresh = t.select().from(postings).where(eq(postings.id, p.id)).get() as Posting;
    const { row, rejectedBy } = analyze(t, fresh, floor, now);
    t.delete(analysis).where(eq(analysis.posting_id, p.id)).run();
    t.insert(analysis).values(row).run();
    t.delete(intel).where(eq(intel.posting_id, p.id)).run();
    t.delete(apply_links)
      .where(and(eq(apply_links.posting_id, p.id), eq(apply_links.method, "llm")))
      .run();
    return { rejected: rejectedBy.length > 0 };
  });
}

/**
 * The step between `process` and `enrich`. Free route first: a pending posting whose same job (company, normalized title)
 * is on an ATS board the DB already holds takes that text and sends no request (any age, also during a backoff).
 * Then LinkedIn detail requests (through JobSpy, logged out): at most MAX_DETAIL_REQUESTS_PER_RUN per run, newest first,
 * only for postings first seen in the last DETAIL_MAX_AGE_MS, the first one SEARCH_GAP_MS after the search's last request
 * and each next one DETAIL_GAP_MS after the previous. No retry inside a run.
 * Failures are counted per posting (`description_attempts`, a 429 included). A 429 on ONE posting is a failure of that
 * posting, not a block: the run goes on with the next posting. The details backoff starts only when the 429s come from at
 * least 2 different postings: a posting gets a 429 while another posting's 429 (this run or an earlier run) is less than
 * DETAIL_BACKOFF_HOURS old (`description_blocked_at`). The attempts of the postings in that block are then taken back
 * (a real block is not their fault) and their `description_blocked_at` is cleared.
 * A posting that failed on POISON_FAILED_RUNS runs, with a description fetched by another posting in between or in the same
 * run, is a poison job: `description_unavailable_at` is set and it is never requested again (it stays in Needs a look).
 * Two backoffs: a block on the search (source_runs) holds the requests too; a block on a detail request is stored only in
 * `description_runs` (blocked) and holds only the detail requests for DETAIL_BACKOFF_HOURS: the search keeps running and
 * the step never writes a `source_runs` row, so the search's freshness line never sees it.
 * Returns the exit code (1 after a block or a worker error).
 */
export async function runFetchDescriptions(opts: FetchDescriptionsOptions): Promise<number> {
  const { db, out, err } = opts;
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cap = opts.maxRequests ?? MAX_DETAIL_REQUESTS_PER_RUN;
  const startedAt = now();

  const pending = selectForDescription(db);
  if (pending.length === 0) {
    out("fetch-descriptions: nothing to fetch\n");
    return 0;
  }
  // The salary config is read only when a description arrives (a run that sends and finds nothing needs none).
  let floorValue = opts.floorIdrMonth;
  const floor = (): number => (floorValue ??= loadConfig().salary.floor_idr_month);

  let fromAts = 0;
  let rejected = 0;
  const open: Posting[] = [];
  for (const p of pending) {
    const text = atsDescription(db, p);
    if (text === undefined) {
      open.push(p);
      continue;
    }
    fromAts += 1;
    if (applyDescription(db, p, text, floor(), now()).rejected) rejected += 1;
  }

  const cutoff = startedAt.getTime() - DETAIL_MAX_AGE_MS;
  const candidates = open.filter((p) => Date.parse(p.first_seen_at) >= cutoff);
  const tooOld = open.length - candidates.length;

  const searchBackoff = blockBackoffUntil(db, DESCRIPTION_SOURCE, startedAt);
  const detailBackoff = descriptionBackoffUntil(db, startedAt);
  if (searchBackoff !== undefined || detailBackoff !== undefined || candidates.length === 0) {
    const why = searchBackoff
      ? `skipped (search backoff after block until ${searchBackoff.toISOString()})`
      : detailBackoff
        ? `skipped (details backoff after block until ${detailBackoff.toISOString()})`
        : "no posting from the last 24 h to request";
    out(
      `fetch-descriptions: ${why}, from the ATS board ${fromAts} (rejected by the rules ${rejected}), ` +
        `older than 24 h and never requested ${tooOld}, left for the next run ${selectForDescription(db).length}\n`,
    );
    return 0;
  }

  let lastRequestAt = lastSearchRequestAt(db);
  let requested = 0;
  let fetched = 0;
  let failed = 0;
  let unavailable = 0;
  let blocked: string | undefined;
  const failures: { id: string; before: string | null; attempts: number }[] = [];
  let toolError: string | undefined;
  let skipped: string | undefined;

  for (const p of candidates) {
    if (requested >= cap) break;
    if (lastRequestAt !== undefined) {
      const gap = requested === 0 ? SEARCH_GAP_MS : DETAIL_GAP_MS;
      const wait = gap - (now().getTime() - lastRequestAt);
      if (wait > 0) await sleep(wait);
    }
    try {
      requested += 1;
      const result = await opts.fetchDescription(p.external_id);
      // The gap runs from the end of the request, so a slow request never shortens the next wait.
      lastRequestAt = now().getTime();
      if (result.kind === "ok") {
        fetched += 1;
        if (applyDescription(db, p, result.description, floor(), now()).rejected) rejected += 1;
      } else {
        failed += 1;
        failures.push(recordFailure(db, p, now(), false));
        log.warn("fetch-descriptions: no description", {
          postingId: p.id,
          attempt: p.description_attempts + 1,
          reason: result.reason,
        });
      }
    } catch (e) {
      lastRequestAt = now().getTime();
      if (e instanceof SourceSkippedError) {
        requested -= 1; // the worker could not run here: no request was sent
        skipped = e.reason;
      } else if (e instanceof SourceBlockedError) {
        failed += 1;
        failures.push(recordFailure(db, p, now(), true));
        if (otherBlockedWithin(db, p.id, now())) {
          blocked = e.message;
          takeBackBlocks(db);
          break;
        }
        continue; // one posting alone: its own failure, the next posting is tried
      } else {
        // A failing worker is a tool problem, not the posting's: no attempt is counted for it.
        toolError = e instanceof SourceError ? e.message : "unexpected error";
        log.error("fetch-descriptions: worker failed", { postingId: p.id, error: toolError });
      }
      break;
    }
  }

  // Poison jobs: failed on 2 runs, and another posting got its description since the earlier failure (or in this run).
  // After a backoff the attempts were taken back, so nothing is given up for a block.
  if (blocked === undefined) {
    for (const f of failures) {
      const giveUp =
        f.attempts >= MAX_DESCRIPTION_ATTEMPTS ||
        (f.attempts >= POISON_FAILED_RUNS && (fetched > 0 || fetchedSince(db, f.before)));
      if (!giveUp) continue;
      unavailable += 1;
      db.update(postings)
        .set({ description_unavailable_at: now().toISOString() })
        .where(eq(postings.id, f.id))
        .run();
    }
  }

  const finishedAt = now();
  // A block is the `blocked` flag of this row only: no source_runs row, so the search and its freshness line are untouched.
  if (requested > 0) {
    db.insert(description_runs)
      .values({
        id: randomUUID(),
        source: DESCRIPTION_SOURCE,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        requested,
        failed,
        fetched,
        skipped: unavailable,
        blocked: blocked !== undefined,
      })
      .run();
  }

  const left = selectForDescription(db).length;
  out(
    `fetch-descriptions: requested ${requested}, fetched ${fetched} (rejected by the rules ${rejected}), failed ${failed}` +
      `${unavailable > 0 ? ` (unavailable ${unavailable})` : ""}, from the ATS board ${fromAts}, ` +
      `older than 24 h and never requested ${tooOld}, left for the next run ${left}\n`,
  );
  if (skipped !== undefined) out(`fetch-descriptions: skipped (${skipped})\n`);
  if (blocked !== undefined) {
    err(`fetch-descriptions: ${BLOCKED_PREFIX}${blocked}\n`);
    return 1;
  }
  if (toolError !== undefined) {
    err(`fetch-descriptions: ${toolError}\n`);
    return 1;
  }
  return 0;
}
