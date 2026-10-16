import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { companies, postings, type Db, type Posting } from "@job-agent/core";
import { ATS_SOURCE_NAMES } from "../filters/keywords.ts";
import { normalizeCompanyName } from "../normalize/index.ts";

const MERGE_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

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

/** Lower is better: ATS < other API sources < hn and linkedin_posts. */
function sourceRank(source: string): number {
  if (ATS_SOURCE_NAMES.includes(source)) return 0;
  return source === "hn" || source === "linkedin_posts" ? 2 : 1;
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
 * How well a per-offer country serves an Indonesia-based candidate: 0 Indonesia, 1 Asia / APAC, 2 worldwide, null for
 * any other country. A variant with a rank is the one to apply through.
 */
export function regionRank(country: string | null): number | null {
  const c = (country ?? "").toLowerCase();
  if (/\bindonesia\b/.test(c)) return 0;
  if (/\b(?:asia|apac)\b/.test(c)) return 1;
  if (/\b(?:worldwide|world wide|global|anywhere)\b/.test(c)) return 2;
  return null;
}

/**
 * The countries of a canonical posting and of the postings linked to it, in arrival order, each once (case-insensitive).
 * A posting that lists one offer per country has one variant per country; this is their union.
 */
export function unionCountries(db: Db, p: Posting): string[] {
  const variants = db
    .select()
    .from(postings)
    .where(eq(postings.canonical_posting_id, p.id))
    .all()
    .sort(compareArrival);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of [p.country, ...variants.map((v) => v.country)]) {
    const country = c?.trim();
    if (!country || seen.has(country.toLowerCase())) continue;
    seen.add(country.toLowerCase());
    out.push(country);
  }
  return out;
}

/**
 * The location text the location rules run on: the posting's own text plus the union of its variants' countries
 * (a country the text already names is not repeated).
 */
export function locationWithCountries(
  locationText: string | null,
  countries: readonly string[],
): string | null {
  const have = (locationText ?? "").toLowerCase();
  const extra = countries.filter((c) => !have.includes(c.toLowerCase()));
  if (extra.length === 0) return locationText;
  return `${locationText ? `${locationText}; ` : ""}Countries: ${extra.join(", ")}`;
}

/**
 * Hashes every normalized posting with `dedupe_hash IS NULL` and collapses same-job postings
 * from different sources into one group with a single canonical row. Then links same-source variants
 * (`linkSameSourceVariants`). Returns how many were hashed.
 */
export function dedupePending(db: Db): number {
  const pending = db
    .select()
    .from(postings)
    .where(and(isNull(postings.dedupe_hash), isNotNull(postings.normalized_at)))
    .all();

  db.transaction((tx) => {
    if (pending.length > 0) groupPending(tx as unknown as Db, pending);
    linkSameSourceVariants(tx as unknown as Db);
  });
  return pending.length;
}

function groupPending(tx: Db, pending: Posting[]): void {
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
}

/** The members of a group that share a source must all have the same, known text. */
function sameTextPerSource(members: readonly Posting[]): boolean {
  const seen = new Map<string, string | null>();
  for (const m of members) {
    if (m.content_hash === null) return false;
    const prior = seen.get(m.source);
    if (prior !== undefined && prior !== m.content_hash) return false;
    seen.set(m.source, m.content_hash);
  }
  return true;
}

function withinWindow(members: readonly Posting[]): boolean {
  const times = members.map((m) => Date.parse(m.first_seen_at));
  return Math.max(...times) - Math.min(...times) <= MERGE_WINDOW_MS;
}

/**
 * Same-source postings of one job (same dedupe_hash) whose `content_hash` is identical are one posting with several
 * variants (an ATS that lists one offer per country). The earliest becomes canonical and the rest point to it.
 * Never on the title key alone: if the text differs, nothing is linked. A same-source link whose text has since
 * diverged is undone. Idempotent, deletes nothing; `canonical_posting_id` is the only link, so clearing it undoes this.
 *
 * Afterwards the canonical posting applies through a variant for Indonesia, Asia / APAC or worldwide when it has one.
 */
function linkSameSourceVariants(tx: Db): void {
  const rows = tx
    .select()
    .from(postings)
    .where(and(isNotNull(postings.dedupe_hash), isNotNull(postings.company_id)))
    .all();
  const byId = new Map(rows.map((p) => [p.id, p]));
  const setCanonical = (p: Posting, canonical: string | null) => {
    if (p.canonical_posting_id === canonical) return;
    p.canonical_posting_id = canonical;
    tx.update(postings).set({ canonical_posting_id: canonical }).where(eq(postings.id, p.id)).run();
  };
  const rootOf = (p: Posting): Posting => {
    let cur = p;
    for (let i = 0; i < 10 && cur.canonical_posting_id !== null; i++) {
      const next = byId.get(cur.canonical_posting_id);
      if (next === undefined) break;
      cur = next;
    }
    return cur;
  };
  const groupOf = (root: Posting): Posting[] => [
    root,
    ...rows.filter((m) => m.canonical_posting_id === root.id),
  ];

  // Undo same-source links whose text has positively diverged (both hashes known and different).
  for (const m of rows) {
    if (m.canonical_posting_id === null || m.content_hash === null) continue;
    const root = byId.get(m.canonical_posting_id);
    if (root === undefined) continue;
    const differs = (o: Posting) => o.content_hash !== null && o.content_hash !== m.content_hash;
    const siblings = rows.filter(
      (o) => o.id !== m.id && o.canonical_posting_id === root.id && o.source === m.source,
    );
    const diverged =
      root.source === m.source ? differs(root) : siblings.length > 0 && siblings.every(differs);
    if (diverged) setCanonical(m, null);
  }

  // Link identical text within a source.
  const buckets = new Map<string, Posting[]>();
  for (const p of rows) {
    if (p.content_hash === null || p.dedupe_hash === null) continue;
    const key = `${p.dedupe_hash}|${p.source}|${p.content_hash}`;
    buckets.set(key, [...(buckets.get(key) ?? []), p]);
  }
  for (const key of [...buckets.keys()].sort()) {
    const members = (buckets.get(key) ?? []).sort(compareArrival);
    if (members.length < 2) continue;
    const roots = [...new Map(members.map((m) => [rootOf(m).id, rootOf(m)])).values()].sort(
      compareCanonical,
    );
    let target = roots[0];
    if (target === undefined) continue;
    for (const other of roots.slice(1)) {
      const merged = [...groupOf(target), ...groupOf(other)];
      // A missed merge is fine, a wrong one is not: keep the groups apart if the union breaks a rule.
      if (!sameTextPerSource(merged) || !withinWindow(merged)) continue;
      for (const m of groupOf(other)) setCanonical(m, target.id);
      target = rootOf(target);
    }
  }

  // Apply through the variant that serves Indonesia, when the canonical one is for another country.
  for (const root of rows.filter((p) => p.canonical_posting_id === null)) {
    if (regionRank(root.country) !== null) continue;
    const best = rows
      .filter(
        (v) =>
          v.canonical_posting_id === root.id &&
          v.source === root.source &&
          regionRank(v.country) !== null,
      )
      .sort(
        (a, b) =>
          (regionRank(a.country) ?? 9) - (regionRank(b.country) ?? 9) || compareArrival(a, b),
      )[0];
    const link = best?.apply_url ?? best?.url;
    if (link === undefined || link === (root.apply_url ?? null)) continue;
    root.apply_url = link;
    tx.update(postings).set({ apply_url: link }).where(eq(postings.id, root.id)).run();
  }
}
