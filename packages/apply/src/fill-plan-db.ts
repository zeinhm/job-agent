import { randomUUID } from "node:crypto";
import { answer_bank, intel, reviews, unknown_questions, type Db } from "@job-agent/core";
import { and, desc, eq, inArray } from "drizzle-orm";
import { approvedMappings } from "./choice-coverage.ts";
import type { FillInput, FillPlan, PlanAnswer, TierAsk } from "./fill-plan.ts";
import { normalizeQuestion } from "./match.ts";

function parseList(text: string | null): string[] | null {
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

/**
 * Everything `planFill` needs besides the form's fields, read from the DB: the answer bank, the approved choice
 * mappings, the tier ask and the scam flag. `scamFlagged` is true when the intel verdict is `suspicious` or the newest
 * `scam` / `not_scam` review of the posting is `scam` (an owner `not_scam` does not clear an intel `suspicious`).
 */
export function loadFillContext(
  db: Db,
  postingId: string,
): Pick<FillInput, "answers" | "choiceMappings" | "ask" | "scamFlagged"> {
  const answers: PlanAnswer[] = db
    .select()
    .from(answer_bank)
    .all()
    .map((a) => ({
      key: a.key,
      question: a.question,
      alternatives: parseList(a.alternatives),
      answer: a.answer,
      type: a.type,
      choices: parseList(a.choices),
      approved: a.approved,
    }));
  const row = db.select().from(intel).where(eq(intel.posting_id, postingId)).get();
  const hasAsk = row !== undefined && (row.ask_idr_month !== null || row.ask_usd_year !== null);
  const ask: TierAsk | null = hasAsk
    ? { askIdrMonth: row.ask_idr_month, askUsdYear: row.ask_usd_year, askText: row.ask_text }
    : null;
  const latest = db
    .select({ action: reviews.action })
    .from(reviews)
    .where(and(eq(reviews.posting_id, postingId), inArray(reviews.action, ["scam", "not_scam"])))
    .orderBy(desc(reviews.reviewed_at), desc(reviews.id))
    .get();
  return {
    answers,
    choiceMappings: approvedMappings(db),
    ask,
    scamFlagged: row?.final_decision === "suspicious" || latest?.action === "scam",
  };
}

/**
 * Sends the labels of a plan's unmatched fields (no answer, no standard field, no salary wording) to the Inbox, the same
 * way `matchQuestions` does: a new `unknown_questions` row (open, one posting), or the last-seen time of an existing
 * one moved forward. A decided row keeps its status. Returns the number of new rows. Labels only, never values.
 */
export function recordUncoveredLabels(db: Db, plan: FillPlan, now: Date = new Date()): number {
  if (plan.kind !== "fill") return 0;
  const at = now.toISOString();
  let added = 0;
  db.transaction((tx) => {
    const seen = new Set<string>();
    for (const f of plan.fields) {
      if (f.filled || !f.inbox) continue;
      const normalized = normalizeQuestion(f.field.label);
      if (normalized === "" || seen.has(normalized)) continue;
      seen.add(normalized);
      const old = tx
        .select()
        .from(unknown_questions)
        .where(eq(unknown_questions.normalized_label, normalized))
        .get();
      if (old === undefined) {
        tx.insert(unknown_questions)
          .values({
            id: randomUUID(),
            normalized_label: normalized,
            label: f.field.label,
            posting_count: 1,
            first_seen_at: at,
            last_seen_at: at,
          })
          .run();
        added++;
      } else if (old.last_seen_at < at) {
        tx.update(unknown_questions)
          .set({ last_seen_at: at })
          .where(eq(unknown_questions.id, old.id))
          .run();
      }
    }
  });
  return added;
}
