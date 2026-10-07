import { and, desc, eq, lte } from "drizzle-orm";
import { fx_rates, toIdr, type Db } from "@job-agent/core";
import type { ParsedSalary, SalaryPeriod } from "./parse.ts";

export type IdrMonth =
  | { status: "listed"; idrMonthMin?: number; idrMonthMax?: number; fxDate: string | null }
  | { status: "unknown" | "unparsed" | "no_fx" };

/** Multiplier from the posted period to one month. */
const TO_MONTH: Record<SalaryPeriod, number> = { year: 1 / 12, month: 1, hour: 160 };

function rateDate(db: Db, quote: string, onDate: string): string | null {
  if (quote === "USD") return null;
  const row = db
    .select({ date: fx_rates.date })
    .from(fx_rates)
    .where(and(eq(fx_rates.base, "USD"), eq(fx_rates.quote, quote), lte(fx_rates.date, onDate)))
    .orderBy(desc(fx_rates.date))
    .limit(1)
    .get();
  return row?.date ?? null;
}

/**
 * Normalize to whole IDR per month using the latest stored rate on or before `onDate` (YYYY-MM-DD).
 * `fxDate` is the oldest rate date used, or null when no conversion was needed (already IDR).
 */
export function toIdrMonth(parsed: ParsedSalary, db: Db, onDate: string): IdrMonth {
  if ("status" in parsed) return { status: parsed.status };

  const convert = (amount: number | undefined): number | null | undefined => {
    if (amount === undefined) return undefined;
    const monthly = amount * TO_MONTH[parsed.period];
    if (parsed.currency === "IDR") return Math.round(monthly);
    const idr = toIdr(db, monthly, parsed.currency, onDate);
    return idr === null ? null : Math.round(idr);
  };

  const min = convert(parsed.min);
  const max = convert(parsed.max);
  if (min === null || max === null) return { status: "no_fx" };

  let fxDate: string | null = null;
  if (parsed.currency !== "IDR") {
    const dates = [rateDate(db, "IDR", onDate), rateDate(db, parsed.currency, onDate)].filter(
      (d): d is string => d !== null,
    );
    fxDate = dates.sort()[0] ?? null;
  }

  return {
    status: "listed",
    ...(min === undefined ? {} : { idrMonthMin: min }),
    ...(max === undefined ? {} : { idrMonthMax: max }),
    fxDate,
  };
}
