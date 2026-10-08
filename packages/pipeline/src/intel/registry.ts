import { eq } from "drizzle-orm";
import { companies, type Db } from "@job-agent/core";
import type { Extraction } from "./extract.ts";

export type KnownPayPolicy = "location_agnostic" | "location_adjusted";
export type PayPolicy = KnownPayPolicy | "unknown";

export interface CompanyPayPolicy {
  policy: PayPolicy;
  /** `posting:<id>`, `careers:<url>`, `manual`, or null when never set. */
  source: string | null;
}

/** Sources a posting must never overwrite (human decision or the company's own careers page). */
const PROTECTED_SOURCE = /^(manual|careers:)/;

/** Registry lookup for the tier card. Unknown company or never-set policy -> `unknown`. */
export function payPolicyFor(db: Db, companyId: string | null): CompanyPayPolicy {
  if (companyId === null) return { policy: "unknown", source: null };
  const row = db.select().from(companies).where(eq(companies.id, companyId)).get();
  return { policy: row?.pay_policy ?? "unknown", source: row?.pay_policy_source ?? null };
}

/**
 * The policy a posting states, or null. A location-agnostic claim next to a US pay-transparency / legal-note range
 * says nothing about pay elsewhere (PLAN 5.2 trap), so it never counts.
 */
export function statedPolicy(
  x: Pick<Extraction, "payPolicy" | "listedSalaryScope">,
): KnownPayPolicy | null {
  if (x.payPolicy === "location_agnostic" && x.listedSalaryScope === "us_only_or_legal_note") {
    return null;
  }
  return x.payPolicy;
}

/**
 * Registry write after extraction. Stores the posting's policy once per company with source `posting:<id>`.
 * Returns reason lines (conflicts, ignored claims) for `intel.resolved_reasons`; never overwrites a known policy.
 */
export function recordPostingPolicy(
  db: Db,
  posting: { id: string; companyId: string | null },
  extraction: Extraction,
): string[] {
  const reasons: string[] = [];
  if (extraction.payPolicy === "location_agnostic" && statedPolicy(extraction) === null) {
    reasons.push(
      "pay policy: location_agnostic claim ignored, listed range is a US pay-transparency note",
    );
  }
  const stated = statedPolicy(extraction);
  if (stated === null || posting.companyId === null) return reasons;

  const current = payPolicyFor(db, posting.companyId);
  const protectedSource = current.source !== null && PROTECTED_SOURCE.test(current.source);

  if (current.policy === "unknown" && !protectedSource) {
    db.update(companies)
      .set({ pay_policy: stated, pay_policy_source: `posting:${posting.id}` })
      .where(eq(companies.id, posting.companyId))
      .run();
  } else if (current.policy !== "unknown" && current.policy !== stated) {
    reasons.push(
      `pay policy conflict: posting says ${stated}, registry keeps ${current.policy} (source ${current.source ?? "unknown"})`,
    );
  }
  return reasons;
}
