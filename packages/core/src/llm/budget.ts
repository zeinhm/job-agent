import { eq } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { llm_calls } from "../db/schema.ts";
import { worstCaseCost, type LlmModel } from "./prices.ts";

/** Hard cap per Asia/Jakarta day. The env override may only lower it. */
export const DAILY_LLM_CAP_USD = 1;
export const CAP_ENV = "JOB_AGENT_LLM_CAP_USD";

/** Flat allowance for the extra prompt the API injects for structured output. */
const STRUCTURED_OVERHEAD_TOKENS = 500;

export class BudgetExceededError extends Error {
  readonly spentUsd: number;
  readonly reserveUsd: number;
  readonly capUsd: number;

  constructor(spentUsd: number, reserveUsd: number, capUsd: number) {
    super(
      `LLM daily budget exceeded: spent $${spentUsd.toFixed(4)} + reserve $${reserveUsd.toFixed(4)} > cap $${capUsd.toFixed(2)}`,
    );
    this.name = "BudgetExceededError";
    this.spentUsd = spentUsd;
    this.reserveUsd = reserveUsd;
    this.capUsd = capUsd;
  }
}

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jakarta",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** YYYY-MM-DD of the Asia/Jakarta calendar day containing `now`. */
export function jakartaDay(now: Date): string {
  return dayFormat.format(now);
}

/** The cap in force: $1 unless the env lowers it. Higher or invalid values are ignored with a warning. */
export function effectiveCapUsd(
  env: Record<string, string | undefined>,
  warn: (msg: string, fields?: Record<string, unknown>) => void,
): number {
  const raw = env[CAP_ENV];
  if (raw === undefined || raw.trim() === "") return DAILY_LLM_CAP_USD;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    warn(`${CAP_ENV} is not a non-negative number, ignored; cap stays $${DAILY_LLM_CAP_USD}`);
    return DAILY_LLM_CAP_USD;
  }
  if (value > DAILY_LLM_CAP_USD) {
    warn(`${CAP_ENV} may only lower the cap, ignored; cap stays $${DAILY_LLM_CAP_USD}`, {
      requested: value,
    });
    return DAILY_LLM_CAP_USD;
  }
  return value;
}

/** Sum of `llm_calls.cost_usd` for one Jakarta day. */
export function spentOnDay(db: Db, day: string): number {
  const rows = db
    .select({ cost: llm_calls.cost_usd })
    .from(llm_calls)
    .where(eq(llm_calls.day, day))
    .all();
  return rows.reduce((sum, r) => sum + Number(r.cost), 0);
}

/** Local, offline estimate of the prompt size: chars / 2 (conservative for ~2.5 chars/token) + overhead. */
export function estimatePromptTokens(texts: readonly string[]): number {
  const chars = texts.reduce((n, t) => n + t.length, 0);
  return Math.ceil(chars / 2) + STRUCTURED_OVERHEAD_TOKENS;
}

export function reserveUsd(model: LlmModel, promptTokens: number, maxTokens: number): number {
  return worstCaseCost(model, promptTokens, maxTokens);
}

/** Throws BudgetExceededError when `spent today + reserve > cap`. */
export function assertWithinBudget(spentUsd: number, reserve: number, capUsd: number): void {
  // Round to 1e-8 USD so float noise (0.99 + 0.01) cannot flip the comparison.
  const total = Math.round((spentUsd + reserve) * 1e8);
  if (total > Math.round(capUsd * 1e8)) throw new BudgetExceededError(spentUsd, reserve, capUsd);
}
