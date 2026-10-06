import { randomUUID } from "node:crypto";
import { and, desc, eq, lte } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/index.ts";
import { fx_rates } from "../db/schema.ts";
import { SourceError } from "../errors.ts";
import { httpGetJson } from "../http.ts";

export const FX_URL = "https://open.er-api.com/v6/latest/USD";
export const FX_SOURCE = "exchangerate-api-open";
export const FX_QUOTES = ["IDR", "EUR", "GBP", "SGD", "AUD", "CAD", "CHF"] as const;

const envelope = z.object({
  result: z.literal("success"),
  base_code: z.literal("USD"),
  time_last_update_unix: z.number().int().positive(),
  rates: z.record(z.string(), z.number()),
});

export interface StoredFxRate {
  date: string;
  quote: string;
  rate: number;
}

/** Fetch today's USD-based rates and upsert one row per quote, dated with the source's own rate date (UTC). */
export async function fetchAndStoreFx(
  db: Db,
  now: () => Date = () => new Date(),
): Promise<StoredFxRate[]> {
  const parsed = envelope.safeParse(await httpGetJson(FX_URL));
  if (!parsed.success) {
    throw new SourceError(
      "fx",
      `FX response invalid: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  const { time_last_update_unix: updated, rates } = parsed.data;
  const date = new Date(updated * 1000).toISOString().slice(0, 10);

  const rows: StoredFxRate[] = [];
  for (const quote of FX_QUOTES) {
    const rate = rates[quote];
    if (rate === undefined || !(rate > 0)) {
      throw new SourceError("fx", `FX response has no usable rate for ${quote}`);
    }
    rows.push({ date, quote, rate });
  }

  const fetched_at = now().toISOString();
  db.transaction((tx) => {
    for (const r of rows) {
      tx.insert(fx_rates)
        .values({
          id: randomUUID(),
          date: r.date,
          base: "USD",
          quote: r.quote,
          rate: String(r.rate),
          source: FX_SOURCE,
          fetched_at,
        })
        .onConflictDoUpdate({
          target: [fx_rates.date, fx_rates.base, fx_rates.quote],
          set: { rate: String(r.rate), source: FX_SOURCE, fetched_at },
        })
        .run();
    }
  });
  return rows;
}

/** Latest stored rate (1 USD = rate QUOTE) with date <= onDate (YYYY-MM-DD), or null. */
export function getRate(db: Db, quote: string, onDate: string): number | null {
  const code = quote.toUpperCase();
  if (code === "USD") return 1;
  const row = db
    .select({ rate: fx_rates.rate })
    .from(fx_rates)
    .where(and(eq(fx_rates.base, "USD"), eq(fx_rates.quote, code), lte(fx_rates.date, onDate)))
    .orderBy(desc(fx_rates.date))
    .limit(1)
    .get();
  if (row === undefined) return null;
  const rate = Number(row.rate);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** Convert amount in `currency` to IDR using stored rates; null when a needed rate is missing. */
export function toIdr(db: Db, amount: number, currency: string, onDate: string): number | null {
  const idr = getRate(db, "IDR", onDate);
  const from = getRate(db, currency, onDate);
  if (idr === null || from === null) return null;
  return (amount * idr) / from;
}
