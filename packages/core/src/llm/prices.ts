/**
 * Model ids and prices (USD per million tokens). Values from docs/research/t_01c08cc2-anthropic-api.md
 * section 1, accessed 2026-10-08. Re-check the pricing page whenever a model id changes.
 */
export interface PriceTier {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface ModelPrice extends PriceTier {
  /** Prompts longer than this many tokens are billed at `long` (Haiku 5.5 only). */
  longPromptThreshold?: number;
  long?: PriceTier;
}

export const MODEL_PRICES = {
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheWrite5m: 0.125,
    cacheWrite1h: 0.2,
    cacheRead: 0.01,
    longPromptThreshold: 100_000,
    long: { input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheWrite1h: 1.0, cacheRead: 0.05 },
  },
  "claude-sonnet-5-5": {
    input: 2.0,
    output: 10.0,
    cacheWrite5m: 2.5,
    cacheWrite1h: 4.0,
    cacheRead: 0.1,
  },
} as const satisfies Record<string, ModelPrice>;

export type LlmModel = keyof typeof MODEL_PRICES;

export function isLlmModel(model: string): model is LlmModel {
  return Object.hasOwn(MODEL_PRICES, model);
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
}

function tierFor(model: LlmModel, promptTokens: number): PriceTier {
  const price: ModelPrice = MODEL_PRICES[model];
  if (
    price.long &&
    price.longPromptThreshold !== undefined &&
    promptTokens > price.longPromptThreshold
  ) {
    return price.long;
  }
  return price;
}

/** Real cost in USD from a response's `usage`, cache reads and writes included. */
export function costFromUsage(model: LlmModel, usage: Usage): number {
  const read = usage.cache_read_input_tokens ?? 0;
  const created = usage.cache_creation_input_tokens ?? 0;
  const w5 = usage.cache_creation?.ephemeral_5m_input_tokens ?? undefined;
  const w1 = usage.cache_creation?.ephemeral_1h_input_tokens ?? undefined;
  // Without the breakdown, treat all writes as 5m writes (what we request).
  const write5m = w5 === undefined && w1 === undefined ? created : (w5 ?? 0);
  const write1h = w1 ?? 0;
  const p = tierFor(model, usage.input_tokens + read + created);
  return (
    (usage.input_tokens * p.input +
      write5m * p.cacheWrite5m +
      write1h * p.cacheWrite1h +
      read * p.cacheRead +
      usage.output_tokens * p.output) /
    1e6
  );
}

/** Worst-case cost: every prompt token at the full input price (cache discount ignored). */
export function worstCaseCost(model: LlmModel, promptTokens: number, maxTokens: number): number {
  const p = tierFor(model, promptTokens);
  return (promptTokens * p.input + maxTokens * p.output) / 1e6;
}

/** USD with 8 decimals, the text stored in `llm_calls.cost_usd`. */
export function formatUsd(usd: number): string {
  return usd.toFixed(8);
}
