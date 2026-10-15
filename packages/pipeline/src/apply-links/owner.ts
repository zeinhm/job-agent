import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { apply_links, companies, postings, type Db } from "@job-agent/core";
import { atsLinkOf } from "./ats-links.ts";
import { decideApplyType } from "./llm-step.ts";

/** Reason on a row the owner marked wrong without giving a link. */
export const OWNER_WRONG_REASON = "owner marked wrong";
/** `checked_at` of a reset row: older than any recheck window, so the next `resolve-apply` takes it again. */
const RESET_CHECKED_AT = new Date(0).toISOString();

const ownerReason = (now: Date): string => `owner correction ${now.toISOString().slice(0, 10)}`;

/**
 * Feedback `wrong_apply_link` (phase-4 conventions section 6). With a URL the row becomes an `owner` row that
 * `resolve-apply` never touches. Without one the row is reset so the next run looks the posting up once more.
 * `postingId` is the canonical posting id.
 */
export function applyOwnerApplyCorrection(
  db: Db,
  postingId: string,
  url: string | undefined,
  now: Date,
): void {
  const posting = db.select().from(postings).where(eq(postings.id, postingId)).get();
  if (posting === undefined) return;
  const existing = db.select().from(apply_links).where(eq(apply_links.posting_id, postingId)).get();

  if (url === undefined) {
    // Nothing stored yet: the posting is still unresolved, nothing to reset.
    if (existing === undefined) return;
    db.update(apply_links)
      .set({
        apply_type: "unknown",
        method: "source",
        ats_type: null,
        ats_slug: null,
        reason: OWNER_WRONG_REASON,
        checked_at: RESET_CHECKED_AT,
      })
      .where(eq(apply_links.posting_id, postingId))
      .run();
    return;
  }

  const company =
    posting.company_id !== null
      ? db.select().from(companies).where(eq(companies.id, posting.company_id)).get()
      : undefined;
  const ats = atsLinkOf(url);
  const { type } = decideApplyType(
    url,
    ats !== null ? "ats" : "company_form",
    company?.domain ?? null,
  );
  const row = {
    posting_id: postingId,
    apply_url: url,
    apply_type: type,
    method: "owner" as const,
    ats_type: type === "ats" && ats ? ats.vendor : null,
    ats_slug: type === "ats" && ats && ats.slug !== "" ? ats.slug : null,
    found_on: existing?.found_on ?? posting.source,
    reason: ownerReason(now),
    checked_at: now.toISOString(),
  };
  db.insert(apply_links)
    .values({ id: randomUUID(), ...row })
    .onConflictDoUpdate({ target: apply_links.posting_id, set: row })
    .run();
}
