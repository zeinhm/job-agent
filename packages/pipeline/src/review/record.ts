import { randomUUID } from "node:crypto";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  apply_links,
  intel,
  NOT_INTERESTED_REASONS,
  postings,
  REVIEW_ACTIONS,
  reviews,
  type Db,
} from "@job-agent/core";
import { applyOwnerApplyCorrection } from "../apply-links/owner.ts";
import { jakartaDate } from "../digest/selection.ts";
import { reviewState, type ReviewState } from "./state.ts";

const httpUrl = z
  .string()
  .max(2000)
  .refine((s) => {
    try {
      const u = new URL(s);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  });

/** Body of POST /api/reviews. Which extra fields an action needs or allows is checked below. */
export const ReviewInputSchema = z
  .strictObject({
    posting_id: z.string().min(1).max(200),
    action: z.enum(REVIEW_ACTIONS),
    reason: z.enum(NOT_INTERESTED_REASONS).optional(),
    note: z.string().max(2000).optional(),
    apply_url: httpUrl.optional(),
    pay_policy: z.enum(["location_agnostic", "location_adjusted"]).optional(),
  })
  .superRefine((v, ctx) => {
    const bad = (path: string) =>
      ctx.addIssue({ code: "custom", path: [path], message: "invalid" });
    if (v.action === "not_interested" && v.reason === undefined) bad("reason");
    if (v.action !== "not_interested" && v.reason !== undefined) bad("reason");
    if (v.reason === "other" && (v.note === undefined || v.note.trim() === "")) bad("note");
    if (v.action === "pay_policy" && v.pay_policy === undefined) bad("pay_policy");
    if (v.action !== "pay_policy" && v.pay_policy !== undefined) bad("pay_policy");
    if (v.action !== "wrong_apply_link" && v.apply_url !== undefined) bad("apply_url");
  });
export type ReviewInput = z.infer<typeof ReviewInputSchema>;

const MAX_CANONICAL_HOPS = 5;

/** The canonical posting id for any posting id, or null when the posting does not exist. */
export function canonicalPostingId(db: Db, id: string): string | null {
  let current = id;
  for (let hop = 0; hop <= MAX_CANONICAL_HOPS; hop++) {
    const row = db
      .select({ id: postings.id, canonical: postings.canonical_posting_id })
      .from(postings)
      .where(eq(postings.id, current))
      .get();
    if (row === undefined) return null;
    if (row.canonical === null) return row.id;
    current = row.canonical;
  }
  return null;
}

export type ReviewRow = typeof reviews.$inferSelect;

/** Review rows of the given canonical postings, oldest first, grouped by posting. */
export function reviewHistory(db: Db, postingIds: readonly string[]): Map<string, ReviewRow[]> {
  const byPosting = new Map<string, ReviewRow[]>();
  if (postingIds.length === 0) return byPosting;
  const rows = db
    .select()
    .from(reviews)
    .where(inArray(reviews.posting_id, [...postingIds]))
    .orderBy(asc(reviews.reviewed_at), sql`rowid`)
    .all();
  for (const r of rows) {
    const list = byPosting.get(r.posting_id);
    if (list === undefined) byPosting.set(r.posting_id, [r]);
    else list.push(r);
  }
  return byPosting;
}

export interface RecordedReview {
  review: ReviewRow;
  state: ReviewState;
}

/**
 * Appends one review row for the canonical posting, with a snapshot of what the tool said at review time.
 * Returns null when the posting id is unknown. `wrong_apply_link` also corrects the stored apply link; the
 * `pay_policy` side effect is not applied here.
 */
export function recordReview(db: Db, input: ReviewInput, now: Date): RecordedReview | null {
  return db.transaction((tx) => {
    const t = tx as unknown as Db;
    const postingId = canonicalPostingId(t, input.posting_id);
    if (postingId === null) return null;
    const i = t.select().from(intel).where(eq(intel.posting_id, postingId)).get();
    const link = t.select().from(apply_links).where(eq(apply_links.posting_id, postingId)).get();
    const row: ReviewRow = {
      id: randomUUID(),
      posting_id: postingId,
      action: input.action,
      reason: input.reason ?? null,
      note: input.note ?? null,
      apply_url: input.apply_url ?? null,
      pay_policy: input.pay_policy ?? null,
      reviewed_at: now.toISOString(),
      review_day: jakartaDate(now),
      fit_score: i?.fit_score ?? null,
      final_decision: i?.final_decision ?? null,
      tier: i?.tier ?? null,
      apply_type: link?.apply_type ?? null,
      extract_prompt_version: i?.extract_prompt_version ?? null,
      fit_prompt_version: i?.fit_prompt_version ?? null,
    };
    t.insert(reviews).values(row).run();
    if (input.action === "wrong_apply_link") {
      applyOwnerApplyCorrection(t, postingId, input.apply_url, now);
    }
    const history = reviewHistory(t, [postingId]).get(postingId) ?? [];
    return { review: row, state: reviewState(history) };
  });
}
