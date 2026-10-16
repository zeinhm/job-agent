import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { postings, type Posting } from "@job-agent/core";

/** The flag a LinkedIn posting carries until it has its description (pending or unavailable). */
export const DESCRIPTION_MISSING_FLAG = "description_missing";

/** JobSpy returns no description for LinkedIn search results; only the detail request (fetch-descriptions) brings it. */
export const DESCRIPTION_SOURCE = "linkedin";

export type DescriptionState = "present" | "pending" | "unavailable";

export function hasDescription(text: string | null): boolean {
  return text !== null && text.trim() !== "";
}

/** present: not a LinkedIn posting or it has a text; pending: still to fetch; unavailable: given up after 3 failed attempts. */
export function descriptionState(
  p: Pick<Posting, "source" | "description_text" | "description_unavailable_at">,
): DescriptionState {
  if (p.source !== DESCRIPTION_SOURCE || hasDescription(p.description_text)) return "present";
  return p.description_unavailable_at === null ? "pending" : "unavailable";
}

/** SQL twin of `descriptionState(p) === "pending"`: the posting waits for its description and is not extracted yet. */
export const descriptionPendingSql = and(
  eq(postings.source, DESCRIPTION_SOURCE),
  or(isNull(postings.description_text), sql`trim(${postings.description_text}) = ''`),
  isNull(postings.description_unavailable_at),
) as SQL;
