import { randomUUID } from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import { companies, postings, type Db } from "@job-agent/core";
import { normalizeCompanyName } from "./company.ts";
import { cleanLine, htmlToText } from "./text.ts";
import { cleanUrl } from "./url.ts";

export { normalizeCompanyName } from "./company.ts";
export { cleanLine, htmlToText } from "./text.ts";
export { cleanUrl } from "./url.ts";

export interface NormalizeOptions {
  now?: () => Date;
}

/** Normalizes every posting with `normalized_at IS NULL` and links it to a company. Returns how many were processed. */
export function normalizePending(db: Db, opts: NormalizeOptions = {}): number {
  const now = opts.now ?? (() => new Date());
  const pending = db.select().from(postings).where(isNull(postings.normalized_at)).all();
  if (pending.length === 0) return 0;

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
      tx.update(postings)
        .set({
          title: cleanLine(p.title),
          company_id: companyId,
          description_text: p.description_text === null ? null : htmlToText(p.description_text),
          location_text: p.location_text === null ? null : cleanLine(p.location_text),
          url: cleanUrl(p.url, p.source),
          apply_url: p.apply_url === null ? null : cleanUrl(p.apply_url, p.source),
          normalized_at: nowIso,
        })
        .where(eq(postings.id, p.id))
        .run();
    }
  });
  return pending.length;
}
