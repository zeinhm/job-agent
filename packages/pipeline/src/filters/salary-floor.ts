import type { IdrMonth } from "../salary/index.ts";

/** Reason text for a floor rejection; the digest counts rejections by it. */
export const SALARY_BELOW_FLOOR_REASON = "max below floor";

export type SalaryFloorFlag = "salary_unknown" | "salary_unparsed" | "salary_no_fx";

export type SalaryFloorResult = { reject: boolean; flag?: SalaryFloorFlag; reason: string };

const FLAG_BY_STATUS = {
  unknown: "salary_unknown",
  unparsed: "salary_unparsed",
  no_fx: "salary_no_fx",
} as const;

/**
 * Reject only when the normalized max (or the single listed number) is below the floor.
 * Both sides are IDR per month. Only a min listed, or no usable number, never rejects.
 * `reason` never contains the floor value.
 */
export function applySalaryFloor(normalized: IdrMonth, floorIdrMonth: number): SalaryFloorResult {
  if (normalized.status !== "listed") {
    return {
      reject: false,
      flag: FLAG_BY_STATUS[normalized.status],
      reason: `salary ${normalized.status}`,
    };
  }
  const { idrMonthMax: max, idrMonthMin: min } = normalized;
  if (max === undefined) {
    if (min === undefined)
      return { reject: false, flag: "salary_unknown", reason: "salary unknown" };
    return { reject: false, reason: "only min listed" };
  }
  if (max < floorIdrMonth) return { reject: true, reason: SALARY_BELOW_FLOOR_REASON };
  return { reject: false, reason: "max at or above floor" };
}
