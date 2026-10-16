import { questionCounts, type QuestionCounts } from "@job-agent/apply";
import { eq } from "drizzle-orm";
import { analysis, intel, postings, type Db } from "@job-agent/core";
import { parseList } from "../digest/format.ts";
import { describePosting, selectDay, type Entry, type PostingView } from "../digest/selection.ts";
import { canonicalPostingId, firstReviewAt, reviewHistory, type ReviewRow } from "./record.ts";
import { reviewState, type ReviewState } from "./state.ts";

const NO_QUESTIONS: QuestionCounts = {
  total: 0,
  covered: 0,
  needsMapping: 0,
  unknown: 0,
  salary: 0,
};

export interface QueueItem extends PostingView {
  review: ReviewState;
  /** What the approved answer bank covers of this posting's stored application questions. */
  questions: QuestionCounts;
}

export interface Queue {
  date: string;
  /** "Needs a look" repeats Top and Waiting entries that still have an open unclear flag, as the digest does. */
  sections: {
    top: QueueItem[];
    needs_a_look: QueueItem[];
    suspicious: QueueItem[];
    waiting: QueueItem[];
  };
  /** First review action recorded for this day (any action), null before the first one; drives the elapsed timer. */
  firstReviewAt: string | null;
}

/** The day's matches for the dashboard: what the digest for `date` lists, plus each posting's review state. */
export function getQueue(db: Db, date: string): Queue {
  const day = selectDay(db, date, { stamp: false });
  const ids = [...day.top, ...day.waiting, ...day.suspicious].map((e) => e.view.postingId);
  const history = reviewHistory(db, ids);
  const counts = questionCounts(db, ids);
  const item = (e: Entry): QueueItem => ({
    ...e.view,
    review: reviewState(history.get(e.view.postingId) ?? []),
    questions: counts.get(e.view.postingId) ?? NO_QUESTIONS,
  });
  return {
    date,
    sections: {
      top: day.top.map(item),
      needs_a_look: day.needsALook.map(item),
      suspicious: day.suspicious.map(item),
      waiting: day.waiting.map(item),
    },
    firstReviewAt: firstReviewAt(db, date),
  };
}

export interface PostingDetail extends QueueItem {
  descriptionText: string | null;
  reasons: {
    fit: string[];
    scam: string[];
    resolved: string[];
    rules: string[];
  };
  /** Newest first. */
  history: ReviewRow[];
}

/** One posting with its description, all reasons and review history. Any posting id maps to its canonical posting. */
export function getPostingDetail(db: Db, id: string): PostingDetail | null {
  const canonical = canonicalPostingId(db, id);
  if (canonical === null) return null;
  const row = db
    .select({ p: postings, a: analysis, i: intel })
    .from(analysis)
    .innerJoin(postings, eq(postings.id, analysis.posting_id))
    .leftJoin(intel, eq(intel.posting_id, postings.id))
    .where(eq(postings.id, canonical))
    .get();
  if (row === undefined) return null;
  const view = describePosting(db, row);
  const rows = reviewHistory(db, [view.postingId]).get(view.postingId) ?? [];
  return {
    ...view,
    review: reviewState(rows),
    questions: questionCounts(db, [view.postingId]).get(view.postingId) ?? NO_QUESTIONS,
    descriptionText: row.p.description_text,
    reasons: {
      fit: parseList(row.i?.fit_reasons ?? null),
      scam: parseList(row.i?.scam_reasons ?? null),
      resolved: parseList(row.i?.resolved_reasons ?? null),
      rules: parseList(row.a.reasons),
    },
    history: [...rows].reverse(),
  };
}
