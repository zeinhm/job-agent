import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BudgetExceededError, LlmApiError, LlmOutputError, type Db } from "@job-agent/core";
import { TOP_MATCH_MIN_FIT } from "../digest/rank.ts";
import { EXTRACT_MODEL, extractFacts } from "../intel/extract.ts";
import { FIT_MODEL, scoreFit } from "../intel/fit.ts";
import { z } from "zod";
import { DEFAULT_MAX_USD, MAX_CONSECUTIVE_API_ERRORS, runCost } from "./extract.ts";

export const DEFAULT_FIT_SET_URL = new URL("../../../../fixtures/eval/fit.json", import.meta.url);
export const EXAMPLE_CV_URL = new URL("../../../../config/cv.example.md", import.meta.url);

export const FIT_BANDS = ["high", "low"] as const;
export type FitBand = (typeof FIT_BANDS)[number];

/** `high` is `fit >= TOP_MATCH_MIN_FIT`, `low` is anything below. */
export const bandOf = (score: number): FitBand => (score >= TOP_MATCH_MIN_FIT ? "high" : "low");

export const FitCaseSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  company: z.string(),
  location: z.string().nullable(),
  salaryText: z.string().nullable(),
  description: z.string(),
  expected: z.enum(FIT_BANDS),
});
export type FitCase = z.infer<typeof FitCaseSchema>;

/**
 * `persona` picks the CV the cases are scored against: `example` is the committed fake persona
 * (`config/cv.example.md`), `owner` is the owner's own `cv.md` from the config dir (sets built from reviews).
 */
export const FitSetSchema = z
  .object({
    version: z.literal(1),
    persona: z.enum(["example", "owner"]).default("example"),
    cases: z.array(FitCaseSchema).min(1),
  })
  .refine((s) => new Set(s.cases.map((c) => c.id)).size === s.cases.length, "duplicate case id");
export type FitSet = z.infer<typeof FitSetSchema>;

export interface FitOutcome {
  id: string;
  expected: FitBand;
  /** null when the model call produced no valid output. */
  actual: FitBand | null;
}

export interface FitSummary {
  scored: number;
  correct: number;
  accuracy: number;
  /** `confusion[expected][actual]` over scored cases. */
  confusion: Record<FitBand, Record<FitBand, number>>;
  missIds: string[];
}

export function summarizeFit(outcomes: readonly FitOutcome[]): FitSummary {
  const confusion = { high: { high: 0, low: 0 }, low: { high: 0, low: 0 } };
  const missIds: string[] = [];
  let scored = 0;
  for (const o of outcomes) {
    if (o.actual === null) continue;
    scored += 1;
    confusion[o.expected][o.actual] += 1;
    if (o.expected !== o.actual) missIds.push(o.id);
  }
  const correct = scored - missIds.length;
  return { scored, correct, accuracy: scored === 0 ? 0 : correct / scored, confusion, missIds };
}

export const FIT_HELP = `eval:fit: checks fit scoring against expected bands (high: fit >= ${TOP_MATCH_MIN_FIT}, low: below).

Usage: pnpm --filter @job-agent/pipeline eval:fit [--live] [--max-usd <n>] [--set <path>]

  --live         make real API calls (needs ANTHROPIC_API_KEY); without it, and without a key, only says what it would run
  --max-usd <n>  spend cap for this run, default $${DEFAULT_MAX_USD.toFixed(2)}, can only be lowered
  --set <path>   eval set to run; default is the committed fake-persona set (fixtures/eval/fit.json)

Owner's own check, built from your review decisions (stays under data/, never committed):
  pnpm --filter @job-agent/pipeline eval:export-reviews [--since YYYY-MM-DD]
  pnpm --filter @job-agent/pipeline eval:fit --set data/eval/reviews-<date>.json --live
That set is scored against your cv.md from the config dir (JOB_AGENT_CONFIG_DIR, default config/).
Each case costs two calls (extract, then fit), both recorded as purpose eval_fit.
`;

export interface EvalFitOptions {
  args: string[];
  /** Opened lazily: a dry run never touches the database. */
  openDb: () => Db;
  /** Directory holding the owner's `cv.md` (sets with persona `owner`). */
  configDir: string;
  /** Base for a relative `--set` (pnpm runs scripts from the package dir; the caller's cwd is `INIT_CWD`). */
  cwd?: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  /** Override the API base URL (tests). */
  baseURL?: string;
  out: (text: string) => void;
  err: (text: string) => void;
}

function loadSet(path: URL | string): FitSet {
  return FitSetSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * Measures fit scoring on a fixed set. Without `--live` or without a key it only says what it would run.
 * Live: every case goes through `extractFacts` and `scoreFit` (shared client, daily cap) with purpose `eval_fit`.
 * Never prints posting text or model output: ids, bands, counts and cost only.
 */
export async function runEvalFit(opts: EvalFitOptions): Promise<number> {
  const { out, err } = opts;
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());

  let values: {
    live?: boolean | undefined;
    "max-usd"?: string | undefined;
    set?: string | undefined;
    help?: boolean | undefined;
  };
  try {
    ({ values } = parseArgs({
      args: opts.args,
      options: {
        live: { type: "boolean", default: false },
        "max-usd": { type: "string" },
        set: { type: "string" },
        help: { type: "boolean", default: false },
      },
    }));
  } catch (e) {
    err(`eval:fit: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  if (values.help === true) {
    out(FIT_HELP);
    return 0;
  }

  let maxUsd = DEFAULT_MAX_USD;
  if (values["max-usd"] !== undefined) {
    const requested = Number(values["max-usd"]);
    if (values["max-usd"].trim() === "" || !Number.isFinite(requested) || requested <= 0) {
      err("eval:fit: --max-usd must be a positive number\n");
      return 1;
    }
    if (requested > DEFAULT_MAX_USD) {
      err(`eval:fit: --max-usd may only lower the cap, using $${DEFAULT_MAX_USD.toFixed(2)}\n`);
    } else {
      maxUsd = requested;
    }
  }

  let set: FitSet;
  try {
    set = loadSet(
      values.set === undefined
        ? DEFAULT_FIT_SET_URL
        : resolve(opts.cwd ?? process.cwd(), values.set),
    );
  } catch (e) {
    const detail =
      e instanceof Error && "issues" in e ? "does not match the eval set schema" : "cannot be read";
    err(`eval:fit: set ${detail}\n`);
    return 1;
  }

  if (values.live !== true || !env["ANTHROPIC_API_KEY"]) {
    out(
      `eval:fit: dry run, ${set.cases.length} cases, persona ${set.persona}, would use ${EXTRACT_MODEL} + ${FIT_MODEL}\n`,
    );
    return 0;
  }

  let cv: string;
  try {
    cv = readFileSync(
      set.persona === "owner" ? join(opts.configDir, "cv.md") : EXAMPLE_CV_URL,
      "utf8",
    );
  } catch {
    err(`eval:fit: cannot read the CV for persona ${set.persona}\n`);
    return 1;
  }

  const db = opts.openDb();
  const since = now().toISOString();
  const deps = {
    db,
    env,
    now,
    ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
  };

  const outcomes: FitOutcome[] = [];
  const invalidIds: string[] = [];
  const errorIds: string[] = [];
  let stopped: string | null = null;
  let apiErrors = 0;
  let aborted = false;

  for (const c of set.cases) {
    if (runCost(db, since, "eval_fit").usd >= maxUsd) {
      stopped = `--max-usd $${maxUsd.toFixed(2)} reached`;
      break;
    }
    try {
      const extraction = await extractFacts(
        {
          title: c.title,
          companyName: c.company,
          locationText: c.location,
          salaryText: c.salaryText,
          descriptionText: c.description,
        },
        deps,
        "eval_fit",
      );
      const fit = await scoreFit(
        {
          title: c.title,
          companyName: c.company,
          locationText: c.location,
          descriptionText: c.description,
          extraction,
        },
        cv,
        deps,
        "eval_fit",
      );
      apiErrors = 0;
      outcomes.push({ id: c.id, expected: c.expected, actual: bandOf(fit.score) });
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        stopped = "daily LLM cap reached";
        break;
      }
      if (e instanceof LlmOutputError) {
        apiErrors = 0;
        invalidIds.push(c.id);
        outcomes.push({ id: c.id, expected: c.expected, actual: null });
        continue;
      }
      if (e instanceof LlmApiError) {
        apiErrors += 1;
        errorIds.push(c.id);
        outcomes.push({ id: c.id, expected: c.expected, actual: null });
        if (apiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
          aborted = true;
          err(
            `eval:fit: aborted after ${MAX_CONSECUTIVE_API_ERRORS} consecutive API errors: status ${e.status ?? "none"} ${e.errorType}\n`,
          );
          break;
        }
        continue;
      }
      throw e;
    }
  }

  const s = summarizeFit(outcomes);
  out(
    `eval:fit: ${outcomes.length} of ${set.cases.length} cases run, persona ${set.persona}, model ${FIT_MODEL}\n`,
  );
  out(`  band accuracy: ${s.correct}/${s.scored} (${(s.accuracy * 100).toFixed(1)}%)\n`);
  out("  confusion (expected -> got):\n");
  for (const exp of FIT_BANDS) {
    for (const got of FIT_BANDS) out(`    ${exp} -> ${got}: ${s.confusion[exp][got]}\n`);
  }
  if (s.missIds.length > 0) out(`  misses: ${s.missIds.join(", ")}\n`);
  if (invalidIds.length > 0) out(`invalid model output: ${invalidIds.join(", ")}\n`);
  if (errorIds.length > 0) out(`API errors: ${errorIds.join(", ")}\n`);
  if (stopped !== null) out(`stopped early: ${stopped}\n`);
  const cost = runCost(db, since, "eval_fit");
  out(`total cost: $${cost.usd.toFixed(4)} (${cost.calls} calls, cap $${maxUsd.toFixed(2)})\n`);
  return aborted ? 1 : 0;
}
