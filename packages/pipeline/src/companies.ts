import { randomUUID } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { companies, type AppConfig, type Db } from "@job-agent/core";
import type { DiscoveredCompany } from "@job-agent/sources";
import { cleanLine, normalizeCompanyName } from "./normalize/index.ts";

/** Upserts the config companies as verified, `discovered_via = config`. Config wins over any stored ats/slug. */
export function syncConfigCompanies(
  db: Db,
  config: AppConfig,
  now: () => Date = () => new Date(),
): void {
  const nowIso = now().toISOString();
  db.transaction((tx) => {
    for (const c of config.companies) {
      const name = cleanLine(c.name);
      const key = normalizeCompanyName(name);
      if (key === "") continue;
      const fields = {
        ats_type: c.ats,
        ats_slug: c.slug,
        discovered_via: "config" as const,
        verified: true,
      };
      const existing = tx
        .select({ id: companies.id, discovered_at: companies.discovered_at })
        .from(companies)
        .where(eq(companies.normalized_name, key))
        .get();
      if (existing) {
        tx.update(companies)
          .set({ ...fields, discovered_at: existing.discovered_at ?? nowIso })
          .where(eq(companies.id, existing.id))
          .run();
      } else {
        tx.insert(companies)
          .values({
            id: randomUUID(),
            name,
            normalized_name: key,
            ...fields,
            discovered_at: nowIso,
            created_at: nowIso,
          })
          .run();
      }
    }
  });
}

/** Verified companies with an ATS and slug, ready for `buildAdapters`. */
export function loadPollableCompanies(db: Db): DiscoveredCompany[] {
  return db
    .select({
      name: companies.name,
      ats_type: companies.ats_type,
      ats_slug: companies.ats_slug,
      verified: companies.verified,
    })
    .from(companies)
    .where(
      and(
        eq(companies.verified, true),
        isNotNull(companies.ats_type),
        isNotNull(companies.ats_slug),
      ),
    )
    .orderBy(companies.normalized_name)
    .all();
}
