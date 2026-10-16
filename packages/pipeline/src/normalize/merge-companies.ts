import { eq } from "drizzle-orm";
import { companies, llm_calls, log, postings, type Db } from "@job-agent/core";
import { normalizeCompanyName } from "./company.ts";

type Company = typeof companies.$inferSelect;

export interface RenormalizeResult {
  renamed: number;
  merged: number;
  /** Rows left with their stored key (see decisions.md: conflicting owner pay-policy marks). */
  kept: number;
}

export interface RenormalizeOptions {
  warn?: (msg: string, fields?: Record<string, unknown>) => void;
}

const hasOwnerMark = (c: Company): boolean => c.pay_policy_source?.startsWith("owner:") === true;
const hasBoard = (c: Company): boolean => Boolean(c.ats_type && c.ats_slug);

/** Winner order: an owner pay-policy mark, then a stored ATS board, then the oldest row. */
function byPriority(a: Company, b: Company): number {
  return (
    Number(hasOwnerMark(b)) - Number(hasOwnerMark(a)) ||
    Number(hasBoard(b)) - Number(hasBoard(a)) ||
    a.created_at.localeCompare(b.created_at) ||
    a.id.localeCompare(b.id)
  );
}

/** Two owner marks that say different things: the owner decided differently for two names now sharing a key. */
function hasConflictingOwnerMarks(rows: Company[]): boolean {
  const policies = new Set(rows.filter(hasOwnerMark).map((c) => c.pay_policy));
  return policies.size > 1;
}

/** The winner row's fields, with gaps filled from the losers. Owner fields and the ATS pair move as units. */
function mergedFields(winner: Company, losers: Company[]): Partial<Company> {
  const set: Partial<Company> = {};
  if (!hasBoard(winner)) {
    const src = losers.find(hasBoard);
    if (src) {
      set.ats_type = src.ats_type;
      set.ats_slug = src.ats_slug;
      set.ats_checked_at = src.ats_checked_at;
    }
  }
  if (!hasOwnerMark(winner) && winner.pay_policy === null) {
    const src = losers.find((c) => c.pay_policy !== null);
    if (src) {
      set.pay_policy = src.pay_policy;
      set.pay_policy_source = src.pay_policy_source;
      set.pay_policy_checked_at = src.pay_policy_checked_at;
    }
  }
  for (const field of ["domain", "hq_country", "company_type"] as const) {
    if (winner[field] === null) {
      const src = losers.find((c) => c[field] !== null);
      if (src) set[field] = src[field];
    }
  }
  if (winner.discovered_via === null) {
    const src = losers.find((c) => c.discovered_via !== null);
    if (src) {
      set.discovered_via = src.discovered_via;
      set.discovered_at = src.discovered_at;
    }
  }
  if (!winner.verified && losers.some((c) => c.verified)) set.verified = true;
  return set;
}

/**
 * Recomputes `companies.normalized_name` with the current key rules and merges rows that now share a key (the row
 * with an owner pay-policy mark wins, then one with an ATS board, then the oldest). Posting and llm_call references
 * are repointed. A group holding owner marks with different policies is not merged: its rows keep their stored keys
 * and one warning is logged per run. Idempotent; a no-op when every key is already current.
 */
export function renormalizeCompanies(db: Db, opts: RenormalizeOptions = {}): RenormalizeResult {
  const warn = opts.warn ?? ((msg, fields) => log.warn(msg, fields));
  const all = db.select().from(companies).all();
  const newKey = new Map(
    all.map((c) => [c.id, normalizeCompanyName(c.name) || c.normalized_name] as const),
  );
  // Rows that keep their stored key. Grows until no group mixes frozen and unfrozen rows.
  const frozen = new Set<string>();
  const warned = new Set<string>();
  let groups = new Map<string, Company[]>();
  for (let changed = true; changed;) {
    changed = false;
    groups = new Map();
    for (const c of all) {
      const key = frozen.has(c.id) ? c.normalized_name : (newKey.get(c.id) ?? c.normalized_name);
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    for (const [key, rows] of groups) {
      const free = rows.filter((c) => !frozen.has(c.id));
      const block =
        free.length > 0 && (free.length < rows.length || hasConflictingOwnerMarks(free));
      if (!block) continue;
      if (free.length === rows.length && !warned.has(key)) {
        warned.add(key);
        warn("companies not merged: conflicting owner pay-policy marks", {
          key,
          names: rows.map((c) => c.name),
        });
      }
      for (const c of free) frozen.add(c.id);
      changed = true;
    }
  }

  const result: RenormalizeResult = { renamed: 0, merged: 0, kept: frozen.size };
  db.transaction((tx) => {
    // Free every key that changes first, so a swap of two keys cannot trip the unique index.
    const moving = [...groups]
      .filter(([key, rows]) => rows.some((c) => c.normalized_name !== key && !frozen.has(c.id)))
      .flatMap(([, rows]) => rows);
    for (const c of moving) {
      tx.update(companies)
        .set({ normalized_name: `\u0000${c.id}` })
        .where(eq(companies.id, c.id))
        .run();
    }
    const movingIds = new Set(moving.map((c) => c.id));
    for (const [key, rows] of groups) {
      if (rows.every((c) => frozen.has(c.id))) continue;
      if (rows.length === 1 && rows[0]?.normalized_name === key) continue;
      const [winner, ...losers] = [...rows].sort(byPriority);
      if (!winner) continue;
      for (const loser of losers) {
        tx.update(postings)
          .set({ company_id: winner.id })
          .where(eq(postings.company_id, loser.id))
          .run();
        tx.update(llm_calls)
          .set({ company_id: winner.id })
          .where(eq(llm_calls.company_id, loser.id))
          .run();
      }
      for (const loser of losers) tx.delete(companies).where(eq(companies.id, loser.id)).run();
      tx.update(companies)
        .set({ ...mergedFields(winner, losers), normalized_name: key })
        .where(eq(companies.id, winner.id))
        .run();
      result.merged += losers.length;
      if (movingIds.has(winner.id) && winner.normalized_name !== key) result.renamed += 1;
    }
  });
  return result;
}
