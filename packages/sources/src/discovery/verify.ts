import { HttpError, httpGet } from "@job-agent/core";
import type { AtsSlug } from "./extract.ts";

const MIN_INTERVAL_MS = 2000;

/** One lightweight request per ATS, same endpoints the polling adapters use. */
export function boardUrl({ ats, slug }: AtsSlug): string {
  const s = encodeURIComponent(slug);
  switch (ats) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`;
    case "lever":
      return `https://api.lever.co/v0/postings/${s}?mode=json&limit=1`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${s}`;
    case "smartrecruiters":
      return `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=1`;
    case "workable":
      return `https://apply.workable.com/api/v1/widget/accounts/${s}`;
    case "recruitee":
      return `https://${s}.recruitee.com/api/offers/`;
  }
}

/**
 * true = the board answered 200, false = 404 (unknown slug).
 * Any other failure (5xx, network, other 4xx) throws, so the caller can retry on a later day.
 */
export async function verifyBoard(candidate: AtsSlug): Promise<boolean> {
  try {
    await httpGet(boardUrl(candidate), { minIntervalMs: MIN_INTERVAL_MS });
    return true;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return false;
    throw err;
  }
}
