import { intel, REVIEW_ACTIONS, REVIEW_STATUS_ACTIONS, reviews, type Db } from "@job-agent/core";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { loadFillContext } from "./fill-plan-db.ts";

/**
 * The candidate rule of the operator's dry runs (owner decision 4): the posting is kept by the pipeline (`intel`
 * verdict `keep`), not scam-flagged (the same flag the filler stops on), and the owner has not marked it `not_interested`
 * or `applied_manually` (the newest status action decides; `reopen` / `later` / `interested` leave it a candidate).
 * `operator-dry-run` checks it in code; the candidate list of `dry-run-candidates` uses the same function.
 */
export function isDryRunCandidate(db: Db, postingId: string): boolean {
  const row = db.select().from(intel).where(eq(intel.posting_id, postingId)).get();
  if (row?.final_decision !== "keep") return false;
  if (loadFillContext(db, postingId).scamFlagged) return false;
  const status = db
    .select({ action: reviews.action })
    .from(reviews)
    .where(eq(reviews.posting_id, postingId))
    .orderBy(desc(reviews.reviewed_at), desc(reviews.id))
    .all()
    // A stored action outside the schema throws (the candidate list prints nothing then) instead of passing as "no status".
    .map((r) => ({ action: z.enum(REVIEW_ACTIONS).parse(r.action) }))
    .find((r) => (REVIEW_STATUS_ACTIONS as readonly string[]).includes(r.action));
  return status?.action !== "not_interested" && status?.action !== "applied_manually";
}
