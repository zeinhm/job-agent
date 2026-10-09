import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Db } from "../db/index.ts";
import { llm_calls, type NewLlmCall } from "../db/schema.ts";
import { log as defaultLog, type Logger } from "../log.ts";
import {
  assertWithinBudget,
  effectiveCapUsd,
  estimatePromptTokens,
  jakartaDay,
  reserveUsd,
  spentOnDay,
} from "./budget.ts";
import { costFromUsage, formatUsd, isLlmModel, type LlmModel, type Usage } from "./prices.ts";

export { BudgetExceededError } from "./budget.ts";

export type LlmPurpose = NewLlmCall["purpose"];

export class MissingApiKeyError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY not set");
    this.name = "MissingApiKeyError";
  }
}

/** Model output stayed invalid after the one retry. `issues` are Zod issue paths, never content. */
export class LlmOutputError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`LLM output invalid after retry: ${issues.join("; ") || "unknown"}`);
    this.name = "LlmOutputError";
    this.issues = issues;
  }
}

/** The API call failed (after 429/529 retries). Message holds status and error type only. */
export class LlmApiError extends Error {
  readonly status: number | undefined;

  constructor(status: number | undefined, type: string | null | undefined) {
    super(`Anthropic API call failed: status ${status ?? "none"}${type ? ` (${type})` : ""}`);
    this.name = "LlmApiError";
    this.status = status;
  }
}

export interface CallStructuredOptions<S extends z.ZodType> {
  model: LlmModel;
  purpose: LlmPurpose;
  /** Instructions. Sent first. */
  system: string;
  /** Static text (e.g. the CV) marked cacheable; sent after `system`, before the input. */
  cacheablePrefix?: string;
  /** The variable part (posting text); sent as the user message. */
  input: string;
  schema: S;
  maxTokens: number;
  postingId?: string;
  companyId?: string;
}

export interface LlmDeps {
  db: Db;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
  /** Override the API base URL (tests). */
  baseURL?: string;
}

const MAX_RETRIES_429_529 = 2;
const REQUEST_TIMEOUT_MS = 60_000;

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function backoffMs(attempt: number, err: InstanceType<typeof Anthropic.APIError>): number {
  const header = Number(err.headers?.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(header, 30) * 1000;
  return 500 * 2 ** attempt;
}

function isRetryable(err: InstanceType<typeof Anthropic.APIError>): boolean {
  if (err.status !== 429 && err.status !== 529) return false;
  // The monthly tier spend cap is fatal: retrying cannot succeed.
  const body = err.error as { error?: { details?: { error_code?: string } } } | undefined;
  return body?.error?.details?.error_code !== "enforced_spend_limit_reached";
}

const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/** True when the failure happened before any request bytes could reach the API. */
export function isNotSent(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && NOT_SENT_CODES.has(code)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

function outputConfigFor(schema: z.ZodType) {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12" }) as Record<string, unknown>;
  delete json["$schema"];
  return { format: { type: "json_schema" as const, schema: json } };
}

/** Thinking is billed as output; turn it off (Sonnet 5.5 rejects "disabled", research R1 section 2). */
function thinkingFor(model: LlmModel) {
  return model === "claude-sonnet-5-5"
    ? { type: "between_tools" as const }
    : { type: "disabled" as const };
}

/**
 * The only way to call Claude. Reserves the worst case against the daily cap, records every call in
 * `llm_calls`, validates the output with Zod and retries invalid output once.
 */
export async function callStructured<S extends z.ZodType>(
  opts: CallStructuredOptions<S>,
  deps: LlmDeps,
): Promise<z.output<S>> {
  const env = deps.env ?? process.env;
  const logger = deps.logger ?? defaultLog;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? realSleep;

  const apiKey = env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new MissingApiKeyError();
  if (!isLlmModel(opts.model)) throw new Error(`Unknown LLM model: ${String(opts.model)}`);

  const outputConfig = outputConfigFor(opts.schema);
  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: opts.system }];
  if (opts.cacheablePrefix) {
    system.push({
      type: "text",
      text: opts.cacheablePrefix,
      cache_control: { type: "ephemeral" },
    });
  }
  const promptTokens = estimatePromptTokens([
    opts.system,
    opts.cacheablePrefix ?? "",
    opts.input,
    JSON.stringify(outputConfig),
  ]);
  const reserve = reserveUsd(opts.model, promptTokens, opts.maxTokens);
  const cap = effectiveCapUsd(env, (m, f) => logger.warn(m, f));

  const client = new Anthropic({
    apiKey,
    maxRetries: 0,
    timeout: REQUEST_TIMEOUT_MS,
    ...(deps.baseURL ? { baseURL: deps.baseURL } : {}),
  });

  const record = (status: "ok" | "error", usage: Usage | null, errorCost = 0): number => {
    const cost = usage ? costFromUsage(opts.model, usage) : errorCost;
    const at = now();
    deps.db
      .insert(llm_calls)
      .values({
        id: randomUUID(),
        day: jakartaDay(at),
        model: opts.model,
        purpose: opts.purpose,
        posting_id: opts.postingId ?? null,
        company_id: opts.companyId ?? null,
        input_tokens: usage?.input_tokens ?? 0,
        output_tokens: usage?.output_tokens ?? 0,
        cache_read_tokens: usage?.cache_read_input_tokens ?? 0,
        cost_usd: formatUsd(cost),
        status,
        created_at: at.toISOString(),
      })
      .run();
    logger.info("llm call", {
      model: opts.model,
      purpose: opts.purpose,
      status,
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      cache_read_tokens: usage?.cache_read_input_tokens ?? 0,
      cost_usd: formatUsd(cost),
      posting_id: opts.postingId ?? null,
      company_id: opts.companyId ?? null,
    });
    return cost;
  };

  const send = async (): Promise<Anthropic.Message> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await client.messages.create({
          model: opts.model,
          max_tokens: opts.maxTokens,
          system,
          messages: [{ role: "user", content: opts.input }],
          thinking: thinkingFor(opts.model),
          output_config: outputConfig,
        });
      } catch (err) {
        if (err instanceof Anthropic.APIError) {
          if (attempt < MAX_RETRIES_429_529 && isRetryable(err)) {
            logger.warn("llm call retry", { status: err.status, attempt: attempt + 1 });
            await sleep(backoffMs(attempt, err));
            continue;
          }
          // A status came back or the request timed out: it was sent, usage is unknown, so the cap counts the
          // worst case. A connection that failed before the request left (refused, DNS) cost nothing: $0.
          record("error", null, isNotSent(err) ? 0 : reserve);
          throw new LlmApiError(err.status, err.type);
        }
        record("error", null, reserve);
        // Connection/timeout errors: the message can carry request details, so report only the class.
        throw new LlmApiError(undefined, err instanceof Error ? err.name : "unknown");
      }
    }
  };

  let issues: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    assertWithinBudget(spentOnDay(deps.db, jakartaDay(now())), reserve, cap);
    const message = await send();
    record("ok", message.usage);

    const text = message.content.find((b) => b.type === "text");
    if (message.stop_reason === "refusal" || message.stop_reason === "max_tokens" || !text) {
      issues = [`stop_reason:${message.stop_reason ?? "none"}`];
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(text.text);
    } catch {
      issues = ["json: not parseable"];
      continue;
    }
    const parsed = opts.schema.safeParse(json);
    if (parsed.success) return parsed.data;
    issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`);
  }
  throw new LlmOutputError(issues);
}
