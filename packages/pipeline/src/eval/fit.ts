import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { and, eq, gte } from "drizzle-orm";
import {
  BudgetExceededError,
  LlmApiError,
  LlmOutputError,
  llm_calls,
  loadCv,
  type Db,
} from "@job-agent/core";
import { z } from "zod";
import { TOP_MATCH_MIN_FIT } from "../digest/rank.ts";
import { ExtractionSchema, type Extraction } from "../intel/extract.ts";
import { FIT_MODEL, scoreFit } from "../intel/fit.ts";
import { DEFAULT_MAX_USD, MAX_CONSECUTIVE_API_ERRORS } from "./extract.ts";

export const DEFAULT_FIT_SET_URL = new URL("../../../../fixtures/eval/fit.json", import.meta.url);
/** The fake persona CV: the committed set is only meaningful against it. */
export const EXAMPLE_CV_URL = new URL("../../../../config/cv.example.md", import.meta.url);

export const FIT_BANDS = ["high", "low"] as const;
export type FitBand = (typeof FIT_BANDS)[number];

/** `high` is a fit score of at least `TOP_MATCH_MIN_FIT`, `low` anything below. */
export const bandOf = (score: number): FitBand => (score >= TOP_MATCH_MIN_FIT ? "high" : "low");

/** Facts a case does not list stay unknown (null / empty), like an extraction of a sparse posting. */
const BLANK_EXTRACTION: Extraction = ExtractionSchema.parse({
  listedSalary: null,
  listedSalaryScope: null,
  hiringScope: null,
  regions: [],
  remoteRegions: [],
  allowedCountries: [],
  indonesiaExplicit: null,
  companyHq: null,
  companyType: null,
  payPolicy: null,
  employment: null,
  eorProvider: null,
  seniority: null,
  contactChannels: [],
  personalEmailDomain: null,
  asksForPaymentOrId: null,
  repoAssessmentEarly: null,
  urgencyLanguage: null,
  vagueDescription: null,
});

export const FitCaseSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  company: z.string(),
  location: z.string().nullable(),
  description: z.string(),
  /** Partial: unlisted facts are unknown. Sets exported from reviews carry the full stored extraction. */
  extraction: ExtractionSchema.partial(),
  expectedBand: z.enum(FIT_BANDS),
});
export type FitCase = z.infer<typeof FitCaseSchema>;

export const FitSetSchema = z
  .object({ version: z.literal(1), cases: z.array(FitCaseSchema).min(1) })
  .refine((s) => new Set(s.cases.map((c) => c.id)).size === s.cases.length, "duplicate case id");
export type FitSet = z.infer<typeof FitSetSchema>;

export interface FitOutcome {
  id: string;
  expected: FitBand;
  /** null: no usable score (invalid output or API error). */
  actual: FitBand | null;
}

export interface FitSummary {
  scored: number;
  correct: number;
  /** correct / scored; 0 when nothing was scored. */
  accuracy: number;
  /** Keys are `<expected>-><actual>`. */
  confusion: Record<`${FitBand}->${FitBand}`, number>;
  missIds: string[];
}

export function summarizeFit(outcomes: readonly FitOutcome[]): FitSummary {
  const confusion = { "high->high": 0, "high->low": 0, "low->high": 0, "low->low": 0 };
  const missIds: string[] = [];
  let scored = 0;
  let correct = 0;
  for (const o of outcomes) {
    if (o.actual === null) continue;
    scored += 1;
    confusion[`${o.expected}->${o.actual}`] += 1;
    if (o.expected === o.actual) correct += 1;
    else missIds.push(o.id);
  }
  return { scored, correct, accuracy: scored === 0 ? 0 : correct / scored, confusion, missIds };
}

export interface EvalFitOptions {
  args: string[];
  /** Opened lazily: a dry run never touches the database. */
  openDb: () => Db;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  /** Directory holding the owner's `cv.md`, used for a custom `--set`. Default: the config dir. */
  configDir?: string;
  /** Override the API base URL (tests). */
  baseURL?: string;
  out: (text: string) => void;
  err: (text: string) => void;
}

function loadSet(path: URL | string): FitSet {
  return FitSetSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Cost of this run's `eval_fit` calls, from the shared `llm_calls` ledger. */
function runCost(db: Db, since: string): { usd: number; calls: number } {
  const rows = db
    .select({ cost: llm_calls.cost_usd })
    .from(llm_calls)
    .where(and(eq(llm_calls.purpose, "eval_fit"), gte(llm_calls.created_at, since)))
    .all();
  return { usd: rows.reduce((sum, r) => sum + Number(r.cost), 0), calls: rows.length };
}

export const EVAL_FIT_HELP = `eval:fit: checks fit scoring against expected bands (high >= ${TOP_MATCH_MIN_FIT}, low < ${TOP_MATCH_MIN_FIT}).

usage: pnpm --filter @job-agent/pipeline eval:fit [--live] [--max-usd <n>] [--set <path>]

  (no flags)     dry run: prints the case count and model, makes no request
  --live         really call the model (also needs ANTHROPIC_API_KEY); purpose eval_fit, shared $1/day cap
  --max-usd <n>  stop after this much spend; default and ceiling $${DEFAULT_MAX_USD.toFixed(2)}
  --set <path>   another set; scored against your config/cv.md instead of the fake persona CV

Your own set: pnpm --filter @job-agent/pipeline eval:export-reviews, then
  pnpm --filter @job-agent/pipeline eval:fit --set data/eval/reviews-<date>.json --live
`;

/**
 * Measures fit scoring against expected bands. Without `--live` or without a key it only says what it would run.
 * The committed set (fake postings) is scored against the fake persona CV; a custom `--set` against `config/cv.md`.
 * Never prints posting text or model output: ids, counts and cost only.
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
    out(EVAL_FIT_HELP);
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
    set = loadSet(values.set !== undefined ? resolve(values.set) : DEFAULT_FIT_SET_URL);
  } catch (e) {
    const detail =
      e instanceof Error && "issues" in e ? "does not match the eval set schema" : "cannot be read";
    err(`eval:fit: set ${detail}\n`);
    return 1;
  }

  if (values.live !== true || !env["ANTHROPIC_API_KEY"]) {
    out(`eval:fit: dry run, ${set.cases.length} cases, would use ${FIT_MODEL}\n`);
    return 0;
  }

  let cv: string | null;
  try {
    cv =
      values.set === undefined
        ? readFileSync(EXAMPLE_CV_URL, "utf8")
        : opts.configDir !== undefined
          ? loadCv(opts.configDir)
          : loadCv();
  } catch {
    cv = null;
  }
  if (cv === null) {
    err(
      values.set === undefined
        ? "eval:fit: the fake persona CV (config/cv.example.md) cannot be read\n"
        : "eval:fit: config/cv.md is missing or empty; a custom --set is scored against it\n",
    );
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
    if (runCost(db, since).usd >= maxUsd) {
      stopped = `--max-usd $${maxUsd.toFixed(2)} reached`;
      break;
    }
    try {
      const fit = await scoreFit(
        {
          title: c.title,
          companyName: c.company,
          locationText: c.location,
          descriptionText: c.description,
          extraction: ExtractionSchema.parse({ ...BLANK_EXTRACTION, ...c.extraction }),
        },
        cv,
        deps,
        "eval_fit",
      );
      apiErrors = 0;
      outcomes.push({ id: c.id, expected: c.expectedBand, actual: bandOf(fit.score) });
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        stopped = "daily LLM cap reached";
        break;
      }
      if (e instanceof LlmOutputError) {
        apiErrors = 0;
        invalidIds.push(c.id);
        outcomes.push({ id: c.id, expected: c.expectedBand, actual: null });
        continue;
      }
      if (e instanceof LlmApiError) {
        apiErrors += 1;
        errorIds.push(c.id);
        outcomes.push({ id: c.id, expected: c.expectedBand, actual: null });
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
  out(`eval:fit: ${outcomes.length} of ${set.cases.length} cases run, model ${FIT_MODEL}\n`);
  out(
    `  band accuracy: ${s.correct}/${s.scored} (${(s.accuracy * 100).toFixed(1)}%), high >= ${TOP_MATCH_MIN_FIT}\n`,
  );
  out("  confusion (expected->got):\n");
  for (const [k, n] of Object.entries(s.confusion)) out(`    ${k}: ${n}\n`);
  if (s.missIds.length > 0) out(`  misses: ${s.missIds.join(", ")}\n`);
  if (invalidIds.length > 0) out(`invalid model output: ${invalidIds.join(", ")}\n`);
  if (errorIds.length > 0) out(`API errors: ${errorIds.join(", ")}\n`);
  if (stopped !== null) out(`stopped early: ${stopped}\n`);
  const cost = runCost(db, since);
  out(`total cost: $${cost.usd.toFixed(4)} (${cost.calls} calls, cap $${maxUsd.toFixed(2)})\n`);
  return aborted ? 1 : 0;
}
