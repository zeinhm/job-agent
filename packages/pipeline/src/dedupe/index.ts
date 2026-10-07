import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { companies, postings, type Db, type Posting } from "@job-agent/core";
import { normalizeCompanyName } from "../normalize/index.ts";

const MERGE_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
const ATS_SOURCES = new Set(["greenhouse", "lever", "ashby"]);

/** Comparable title key: lowercase, no punctuation, no standalone remote / full time / contract tokens. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/\b(?:remote|full time|contract)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function dedupeHash(normalizedCompany: string, title: string): string {
  return createHash("sha256")
    .update(`${normalizedCompany}|${normalizeTitle(title)}`)
    .digest("hex");
}

/** Lower is better: ATS < other API sources < hn. */
function sourceRank(source: string): number {
  if (ATS_SOURCES.has(source)) return 0;
  return source === "hn" ? 2 : 1;
}

function compareId(a: Posting, b: Posting): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareArrival(a: Posting, b: Posting): number {
  return Date.parse(a.first_seen_at) - Date.parse(b.first_seen_at) || compareId(a, b);
}

function compareCanonical(a: Posting, b: Posting): number {
  return sourceRank(a.source) - sourceRank(b.source) || compareArrival(a, b);
}

/** A posting joins a group only if no member shares its source and all members are within the merge window. */
function fits(group: Posting[], p: Posting): boolean {
  const t = Date.parse(p.first_seen_at);
  return group.every(
    (m) => m.source !== p.source && Math.abs(Date.parse(m.first_seen_at) - t) <= MERGE_WINDOW_MS,
  );
}

/**
 * Hashes every normalized posting with `dedupe_hash IS NULL` and collapses same-job postings
 * from different sources into one group with a single canonical row. Returns how many were hashed.
 */
export function dedupePending(db: Db): number {
  const pending = db
    .select()
    .from(postings)
    .where(and(isNull(postings.dedupe_hash), isNotNull(postings.normalized_at)))
    .all();
  if (pending.length === 0) return 0;

  db.transaction((tx) => {
    const companyKeys = new Map(
      tx
        .select({ id: companies.id, key: companies.normalized_name })
        .from(companies)
        .all()
        .map((c) => [c.id, c.key]),
    );

    const byHash = new Map<string, Posting[]>();
    for (const p of pending) {
      const key =
        (p.company_id !== null ? companyKeys.get(p.company_id) : undefined) ??
        (normalizeCompanyName(p.company_name) || "unknown");
      const hash = dedupeHash(key, p.title);
      tx.update(postings).set({ dedupe_hash: hash }).where(eq(postings.id, p.id)).run();
      if (p.company_id === null) continue; // unknown company: hashed, never merged
      byHash.set(hash, [...(byHash.get(hash) ?? []), p]);
    }

    for (const [hash, fresh] of byHash) {
      const freshIds = new Set(fresh.map((p) => p.id));
      const existing = tx
        .select()
        .from(postings)
        .where(and(eq(postings.dedupe_hash, hash), isNotNull(postings.company_id)))
        .all()
        .filter((p) => !freshIds.has(p.id));

      // Rebuild existing groups from canonical pointers, then place new postings in arrival order.
      const byCanonical = new Map<string, Posting[]>();
      for (const p of existing) {
        const key = p.canonical_posting_id ?? p.id;
        byCanonical.set(key, [...(byCanonical.get(key) ?? []), p]);
      }
      const groups = [...byCanonical.values()];
      const touched = new Set<Posting[]>();
      for (const p of [...fresh].sort(compareArrival)) {
        const target = groups.find((g) => fits(g, p));
        if (target) {
          target.push(p);
          touched.add(target);
        } else {
          groups.push([p]);
        }
      }

      for (const group of touched) {
        const canonical = group.reduce((best, m) => (compareCanonical(m, best) < 0 ? m : best));
        tx.update(postings)
          .set({ canonical_posting_id: null })
          .where(eq(postings.id, canonical.id))
          .run();
        const others = group.filter((m) => m.id !== canonical.id).map((m) => m.id);
        if (others.length > 0) {
          tx.update(postings)
            .set({ canonical_posting_id: canonical.id })
            .where(inArray(postings.id, others))
            .run();
        }
      }
    }
  });
  return pending.length;
}
