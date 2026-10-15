import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { and, eq, gte } from "drizzle-orm";
import {
  BudgetExceededError,
  LlmApiError,
  LlmOutputError,
  llm_calls,
  type Db,
} from "@job-agent/core";
import { EXTRACT_MODEL, extractFacts } from "../intel/extract.ts";
import {
  EVAL_FIELDS,
  EvalSetSchema,
  scoreCase,
  summarize,
  type CaseOutcome,
  type EvalSet,
} from "./score.ts";

/** Default and ceiling of `--max-usd`: the flag can only lower it. */
export const DEFAULT_MAX_USD = 0.5;
/** The run stops after this many API failures in a row (key, outage). */
export const MAX_CONSECUTIVE_API_ERRORS = 3;

export const DEFAULT_SET_URL = new URL("../../../../fixtures/eval/extract.json", import.meta.url);

export interface EvalExtractOptions {
  args: string[];
  /** Opened lazily: a dry run never touches the database. */
  openDb: () => Db;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  /** Override the API base URL (tests). */
  baseURL?: string;
  out: (text: string) => void;
  err: (text: string) => void;
}

function loadSet(path: URL | string): EvalSet {
  return EvalSetSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Cost of this run's `eval_extract` calls, from the shared `llm_calls` ledger. */
function runCost(db: Db, since: string): { usd: number; calls: number } {
  const rows = db
    .select({ cost: llm_calls.cost_usd })
    .from(llm_calls)
    .where(and(eq(llm_calls.purpose, "eval_extract"), gte(llm_calls.created_at, since)))
    .all();
  return { usd: rows.reduce((sum, r) => sum + Number(r.cost), 0), calls: rows.length };
}

/**
 * Measures extraction quality on a fixed set. Without `--live` or without a key it only says what it would run.
 * Live: every case goes through `extractFacts` (shared client, daily cap) with purpose `eval_extract`.
 * Never prints posting text or model output: ids, field names, counts and cost only.
 */
export async function runEvalExtract(opts: EvalExtractOptions): Promise<number> {
  const { out, err } = opts;
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());

  let values: {
    live?: boolean | undefined;
    "max-usd"?: string | undefined;
    set?: string | undefined;
  };
  try {
    ({ values } = parseArgs({
      args: opts.args,
      options: {
        live: { type: "boolean", default: false },
        "max-usd": { type: "string" },
        set: { type: "string" },
      },
    }));
  } catch (e) {
    err(`eval:extract: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  let maxUsd = DEFAULT_MAX_USD;
  if (values["max-usd"] !== undefined) {
    const requested = Number(values["max-usd"]);
    if (values["max-usd"].trim() === "" || !Number.isFinite(requested) || requested <= 0) {
      err("eval:extract: --max-usd must be a positive number\n");
      return 1;
    }
    if (requested > DEFAULT_MAX_USD) {
      err(`eval:extract: --max-usd may only lower the cap, using $${DEFAULT_MAX_USD.toFixed(2)}\n`);
    } else {
      maxUsd = requested;
    }
  }

  let set: EvalSet;
  try {
    set = loadSet(values.set ?? DEFAULT_SET_URL);
  } catch (e) {
    const detail =
      e instanceof Error && "issues" in e ? "does not match the eval set schema" : "cannot be read";
    err(`eval:extract: set ${detail}\n`);
    return 1;
  }

  if (values.live !== true || !env["ANTHROPIC_API_KEY"]) {
    out(`eval:extract: dry run, ${set.cases.length} cases, would use ${EXTRACT_MODEL}\n`);
    return 0;
  }

  const db = opts.openDb();
  const since = now().toISOString();
  const deps = {
    db,
    env,
    now,
    ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
  };

  const outcomes: CaseOutcome[] = [];
  const invalidIds: string[] = [];
  const errorIds: string[] = [];
  let stopped: string | null = null;
  let apiErrors = 0;
  let aborted = false;

  for (const c of set.cases) {
    if (runCost(db, since).usd >= maxUsd) {
      stopped = `--max-usd $${maxUsd.toFixed(2)} reached`;
      break;
    }
    const expectedFields = EVAL_FIELDS.filter((f) => c.expected[f] !== undefined);
    try {
      const actual = await extractFacts(
        {
          title: c.title,
          companyName: c.company,
          locationText: c.location,
          salaryText: c.salaryText,
          descriptionText: c.description,
        },
        deps,
        "eval_extract",
      );
      apiErrors = 0;
      outcomes.push({ id: c.id, scores: scoreCase(c.expected, actual), expectedFields });
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        stopped = "daily LLM cap reached";
        break;
      }
      if (e instanceof LlmOutputError) {
        apiErrors = 0;
        invalidIds.push(c.id);
        outcomes.push({ id: c.id, scores: null, expectedFields });
        continue;
      }
      if (e instanceof LlmApiError) {
        apiErrors += 1;
        errorIds.push(c.id);
        outcomes.push({ id: c.id, scores: null, expectedFields });
        if (apiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
          aborted = true;
          err(
            `eval:extract: aborted after ${MAX_CONSECUTIVE_API_ERRORS} consecutive API errors: status ${e.status ?? "none"} ${e.errorType}\n`,
          );
          break;
        }
        continue;
      }
      throw e;
    }
  }

  out(
    `eval:extract: ${outcomes.length} of ${set.cases.length} cases run, model ${EXTRACT_MODEL}\n`,
  );
  for (const s of summarize(outcomes)) {
    out(`  ${s.field}: ${s.correct}/${s.total} (${(s.accuracy * 100).toFixed(1)}%)\n`);
    if (s.failingIds.length > 0) out(`    failing: ${s.failingIds.join(", ")}\n`);
  }
  if (invalidIds.length > 0) out(`invalid model output: ${invalidIds.join(", ")}\n`);
  if (errorIds.length > 0) out(`API errors: ${errorIds.join(", ")}\n`);
  if (stopped !== null) out(`stopped early: ${stopped}\n`);
  const cost = runCost(db, since);
  out(`total cost: $${cost.usd.toFixed(4)} (${cost.calls} calls, cap $${maxUsd.toFixed(2)})\n`);
  return aborted ? 1 : 0;
}
