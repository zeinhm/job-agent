import { REVIEW_STATUS_ACTIONS } from "@job-agent/core";

export type StatusAction = (typeof REVIEW_STATUS_ACTIONS)[number];

export interface ReviewStateInput {
  action: string;
  reason: string | null;
  reviewed_at: string;
}

export interface ReviewState {
  /** `open` until a status action is recorded. */
  status: "open" | StatusAction;
  reason: string | null;
  reviewedAt: string | null;
  /** A status action other than `later` was recorded. */
  processed: boolean;
}

const isStatusAction = (a: string): a is StatusAction =>
  (REVIEW_STATUS_ACTIONS as readonly string[]).includes(a);

/**
 * Current review state of one posting from its review rows, oldest first (phase 4 conventions, section 5).
 * The newest status action (`interested`, `applied_manually`, `not_interested`, `later`) is the state;
 * correction and ask actions are extra rows and never change it. `later` leaves the posting open.
 */
export function reviewState(history: readonly ReviewStateInput[]): ReviewState {
  const last = history.findLast((h) => isStatusAction(h.action));
  if (last === undefined)
    return { status: "open", reason: null, reviewedAt: null, processed: false };
  const status = last.action as StatusAction;
  return {
    status,
    reason: status === "not_interested" ? last.reason : null,
    reviewedAt: last.reviewed_at,
    processed: status !== "later",
  };
}
