import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { companies, postings, type Db } from "@job-agent/core";
import { normalizeCompanyName } from "./company.ts";
import { cleanLine, htmlToText } from "./text.ts";
import { cleanUrl } from "./url.ts";
import { companyDomainFromPosting } from "./company-domain.ts";

export { normalizeCompanyName } from "./company.ts";
export { cleanLine, htmlToText } from "./text.ts";
export { cleanUrl } from "./url.ts";

export interface NormalizeOptions {
  now?: () => Date;
}

/**
 * Fills `companies.domain` for companies that have none from the links of their already-normalized postings (oldest
 * company-owned link wins). Never overwrites a stored domain. Returns how many companies got one.
 */
export function backfillCompanyDomains(db: Db): number {
  const rows = db
    .select({
      company_id: postings.company_id,
      url: postings.url,
      apply_url: postings.apply_url,
    })
    .from(postings)
    .innerJoin(companies, eq(companies.id, postings.company_id))
    .where(and(isNull(companies.domain), isNotNull(postings.normalized_at)))
    .orderBy(postings.first_seen_at)
    .all();
  const found = new Map<string, string>();
  for (const r of rows) {
    if (r.company_id === null || found.has(r.company_id)) continue;
    const domain = companyDomainFromPosting(r);
    if (domain !== null) found.set(r.company_id, domain);
  }
  for (const [id, domain] of found) {
    db.update(companies)
      .set({ domain })
      .where(and(eq(companies.id, id), isNull(companies.domain)))
      .run();
  }
  return found.size;
}

/** Normalizes every posting with `normalized_at IS NULL` and links it to a company. Returns how many were processed. */
export function normalizePending(db: Db, opts: NormalizeOptions = {}): number {
  const now = opts.now ?? (() => new Date());
  const pending = db.select().from(postings).where(isNull(postings.normalized_at)).all();
  if (pending.length === 0) {
    backfillCompanyDomains(db);
    return 0;
  }

  db.transaction((tx) => {
    const nowIso = now().toISOString();
    for (const p of pending) {
      const name = cleanLine(p.company_name);
      const key = normalizeCompanyName(name);
      let companyId: string | null = null;
      if (key !== "" && key !== "unknown") {
        const existing = tx
          .select({ id: companies.id })
          .from(companies)
          .where(eq(companies.normalized_name, key))
          .get();
        companyId = existing?.id ?? randomUUID();
        if (!existing) {
          tx.insert(companies)
            .values({ id: companyId, name, normalized_name: key, created_at: nowIso })
            .run();
        }
      }
      const url = cleanUrl(p.url, p.source);
      const applyUrl = p.apply_url === null ? null : cleanUrl(p.apply_url, p.source);
      // Domain only from a company-owned link; a stored domain (config or earlier posting) is never overwritten.
      if (companyId !== null) {
        const domain = companyDomainFromPosting({ apply_url: applyUrl, url });
        if (domain !== null) {
          tx.update(companies)
            .set({ domain })
            .where(and(eq(companies.id, companyId), isNull(companies.domain)))
            .run();
        }
      }
      tx.update(postings)
        .set({
          title: cleanLine(p.title),
          company_id: companyId,
          description_text: p.description_text === null ? null : htmlToText(p.description_text),
          location_text: p.location_text === null ? null : cleanLine(p.location_text),
          url,
          apply_url: applyUrl,
          normalized_at: nowIso,
        })
        .where(eq(postings.id, p.id))
        .run();
    }
  });
  return pending.length;
}
