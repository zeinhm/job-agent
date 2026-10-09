export const UNCLEAR_FLAG_PENALTY = 10;
export const SALARY_BONUS = 5;
/** Scored postings below this fit score are listed under "Scored, not a fit", not "Top matches". */
export const TOP_MATCH_MIN_FIT = 60;

export interface RankInput {
  /** 0-100 fit score. */
  fitScore: number;
  /** Unclear flags the resolve stage could not settle. */
  remainingUnclearFlags: number;
  /** Listed salary maximum, IDR per month, already normalized. */
  listedMaxIdrMonth: number | null;
  /** Salary ask, IDR per month. */
  askIdrMonth: number | null;
}

/** True only when a listed max exists, an ask exists, and the max covers the ask. */
export function salaryBonusApplies(listedMax: number | null, ask: number | null): boolean {
  return listedMax !== null && ask !== null && listedMax >= ask;
}

/** Rank = fit - 10 per remaining unclear flag + 5 when the listed max is at or above the ask. */
export function rankScore(i: RankInput): number {
  return (
    i.fitScore -
    UNCLEAR_FLAG_PENALTY * i.remainingUnclearFlags +
    (salaryBonusApplies(i.listedMaxIdrMonth, i.askIdrMonth) ? SALARY_BONUS : 0)
  );
}

/** Compares two ranked entries: higher rank first, then newer posted_at, nulls last. */
export function compareRanked(
  a: { rank: number; postedAt: string | null },
  b: { rank: number; postedAt: string | null },
): number {
  if (a.rank !== b.rank) return b.rank - a.rank;
  if (a.postedAt === b.postedAt) return 0;
  if (a.postedAt === null) return 1;
  if (b.postedAt === null) return -1;
  return a.postedAt < b.postedAt ? 1 : -1;
}
