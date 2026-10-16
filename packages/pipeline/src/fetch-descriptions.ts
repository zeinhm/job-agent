import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
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
import { BLOCKED_PREFIX, blockBackoffUntil } from "./discover.ts";
import { DESCRIPTION_SOURCE, descriptionPendingSql } from "./description-state.ts";
import { classifyLocation } from "./filters/location.ts";
import { classifyRole } from "./filters/role.ts";
import { analyze } from "./process.ts";

/** At most this many detail requests in one run; the postings left over wait for the next run (newest are fetched first). */
export const MAX_DETAIL_REQUESTS_PER_RUN = 20;
/** A posting gets this many counted failures, then it is `description_unavailable` (processed on the title only). A blocked run is not counted. */
export const MAX_DESCRIPTION_ATTEMPTS = 3;
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
 * posting's own location text is not `restricted`; newest first. Nothing else is fetched.
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
 * The step between `process` and `enrich`: one LinkedIn detail request at a time (through JobSpy, logged out), at least
 * SEARCH_GAP_MS (the search's own gap, 10 s) after any other LinkedIn request, at most MAX_DETAIL_REQUESTS_PER_RUN per run.
 * It shares the linkedin block backoff with the search: nothing is sent while it holds, and a block ends the step and
 * records the same `blocked:` error run that starts the 6 h backoff. Returns the exit code (1 after a block or a worker error).
 */
export async function runFetchDescriptions(opts: FetchDescriptionsOptions): Promise<number> {
  const { db, out, err } = opts;
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cap = opts.maxRequests ?? MAX_DETAIL_REQUESTS_PER_RUN;
  const startedAt = now();

  const backoffUntil = blockBackoffUntil(db, DESCRIPTION_SOURCE, startedAt);
  if (backoffUntil) {
    out(`fetch-descriptions: skipped (backoff after block until ${backoffUntil.toISOString()})\n`);
    return 0;
  }

  const candidates = selectForDescription(db);
  if (candidates.length === 0) {
    out("fetch-descriptions: nothing to fetch\n");
    return 0;
  }
  const floor = opts.floorIdrMonth ?? loadConfig().salary.floor_idr_month;

  let lastRequestAt = lastSearchRequestAt(db);
  let requested = 0;
  let fetched = 0;
  let failed = 0;
  let unavailable = 0;
  let rejected = 0;
  let blocked: string | undefined;
  let toolError: string | undefined;
  let skipped: string | undefined;

  for (const p of candidates) {
    if (requested >= cap) break;
    if (lastRequestAt !== undefined) {
      const wait = SEARCH_GAP_MS - (now().getTime() - lastRequestAt);
      if (wait > 0) await sleep(wait);
    }
    try {
      requested += 1;
      const result = await opts.fetchDescription(p.external_id);
      // The gap runs from the end of the request, so a slow request never shortens the next wait.
      lastRequestAt = now().getTime();
      if (result.kind === "ok") {
        fetched += 1;
        if (applyDescription(db, p, result.description, floor, now()).rejected) rejected += 1;
      } else {
        failed += 1;
        const attempts = p.description_attempts + 1;
        const giveUp = attempts >= MAX_DESCRIPTION_ATTEMPTS;
        if (giveUp) unavailable += 1;
        db.update(postings)
          .set({
            description_attempts: attempts,
            ...(giveUp ? { description_unavailable_at: now().toISOString() } : {}),
          })
          .where(eq(postings.id, p.id))
          .run();
        log.warn("fetch-descriptions: no description", {
          postingId: p.id,
          attempt: attempts,
          reason: result.reason,
        });
      }
    } catch (e) {
      lastRequestAt = now().getTime();
      if (e instanceof SourceSkippedError) {
        requested -= 1; // the worker could not run here: no request was sent
        skipped = e.reason;
      } else if (e instanceof SourceBlockedError) {
        blocked = e.message;
      } else {
        // A failing worker is a tool problem, not the posting's: no attempt is counted for it.
        toolError = e instanceof SourceError ? e.message : "unexpected error";
        log.error("fetch-descriptions: worker failed", { postingId: p.id, error: toolError });
      }
      break;
    }
  }

  const finishedAt = now();
  if (blocked !== undefined) {
    // The same row a blocked search leaves: `discover` and the freshness line read the 6 h backoff from it.
    db.insert(source_runs)
      .values({
        id: randomUUID(),
        source: DESCRIPTION_SOURCE,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        status: "error",
        found: 0,
        new: 0,
        error_message: `${BLOCKED_PREFIX}${blocked}`,
        saturated: null,
      })
      .run();
  }
  if (requested > 0) {
    db.insert(description_runs)
      .values({
        id: randomUUID(),
        source: DESCRIPTION_SOURCE,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        requested,
        failed,
        blocked: blocked !== undefined,
      })
      .run();
  }

  const left = selectForDescription(db).length;
  out(
    `fetch-descriptions: requested ${requested}, fetched ${fetched} (rejected by the rules ${rejected}), failed ${failed}` +
      `${unavailable > 0 ? ` (unavailable ${unavailable})` : ""}, left for the next run ${left}\n`,
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
