import { randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  analysis,
  BudgetExceededError,
  getRate,
  intel,
  jakartaDay,
  LlmApiError,
  LlmOutputError,
  loadCv,
  log,
  postings,
  spentOnDay,
  type Db,
  type Intel,
  type LlmDeps,
  type Posting,
  type SalaryConfig,
} from "@job-agent/core";
import { resolveFlags } from "./intel/resolve.ts";
import {
  EXTRACT_MODEL,
  EXTRACT_PROMPT_VERSION,
  ExtractionSchema,
  extractFacts,
  type Extraction,
} from "./intel/extract.ts";
import {
  failedFitRuns,
  FIT_MODEL,
  FIT_PROMPT_VERSION,
  fitAttemptMarker,
  MAX_FIT_ATTEMPTS,
  scoreFit,
} from "./intel/fit.ts";
import { researchCompanyPayPolicy, type ResearchDeps } from "./intel/company-research.ts";
import { createDomainAgeLookup, type DomainAgeLookup } from "./intel/rdap.ts";
import { payPolicyFor, recordPostingPolicy } from "./intel/registry.ts";
import { runScamStage } from "./intel/scam-stage.ts";
import { decideTierAndAsk, TIER_SKIPPED_NO_FX, type TierFx } from "./intel/tier.ts";

export interface EnrichOptions {
  db: Db;
  /** Salary config (floor, tier asks, text answer) for the tier stage. */
  salary: SalaryConfig;
  /** Stop after this many postings. */
  limit?: number | undefined;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  /** Override the API base URL (tests). */
  baseURL?: string;
  out: (text: string) => void;
  err: (text: string) => void;
  /** CV text for the fit stage. Default: `cv.md` from the config dir; null = missing, fit stage skipped. */
  cv?: string | null;
  /** Stages appended after scam (tests; later cards add fit and tier). They never run for a suspicious posting. */
  extraStages?: Stage[];
  /** Careers-page fetcher for the pay-policy research step (tests). Default: the shared HTTP client. */
  fetchPage?: ResearchDeps["fetchPage"];
}

/** After this many API failures in a row `enrich` stops calling the API: the cause is systematic (key, outage). */
export const MAX_CONSECUTIVE_API_ERRORS = 3;

type IntelPatch = Partial<typeof intel.$inferInsert>;

type StageResult =
  | { kind: "done"; patch: IntelPatch }
  | { kind: "failed"; patch: IntelPatch }
  /** Transient API failure: nothing is stored, the posting is retried on the next run. */
  | { kind: "retry"; error?: LlmApiError }
  /** No IDR FX rate yet: earlier results are saved, the posting waits for `fx` and is re-tiered later. */
  | { kind: "fx_wait"; patch: IntelPatch };

/** What earlier stages of this posting already produced, and run-wide helpers. */
interface StageContext {
  patch: IntelPatch;
  lookupDomainAge: DomainAgeLookup;
}

/** A stage fills part of the `intel` row for one posting. Later cards add resolve, fit, tier here. */
export interface Stage {
  name: string;
  run: (posting: Posting, deps: LlmDeps, ctx: StageContext) => Promise<StageResult>;
}

const extractStage: Stage = {
  name: "extract",
  async run(p, deps, ctx) {
    // Saved by an earlier run that stopped after this stage (retry / budget): never pay for it twice.
    if (ctx.patch.extraction !== undefined) return { kind: "done", patch: {} };
    try {
      const extraction: Extraction = await extractFacts(
        {
          postingId: p.id,
          title: p.title,
          companyName: p.company_name,
          locationText: p.location_text,
          salaryText: p.salary_text,
          descriptionText: p.description_text,
        },
        deps,
      );
      return {
        kind: "done",
        patch: {
          extraction: JSON.stringify(extraction),
          extract_model: EXTRACT_MODEL,
          extract_prompt_version: EXTRACT_PROMPT_VERSION,
        },
      };
    } catch (e) {
      if (e instanceof LlmOutputError) {
        return { kind: "failed", patch: { resolved_reasons: JSON.stringify(e.issues) } };
      }
      if (e instanceof LlmApiError) return { kind: "retry", error: e };
      throw e;
    }
  },
};

/** No LLM call: rules + extracted signals + verification. Suspicious postings are never scored for fit. */
const scamStage: Stage = {
  name: "scam",
  async run(p, deps, ctx) {
    if (ctx.patch.final_decision === "reject") return { kind: "done", patch: {} };
    const out = await runScamStage(
      deps.db,
      p,
      ctx.patch.extraction,
      ctx.lookupDomainAge,
      deps.now?.() ?? new Date(),
    );
    return {
      kind: "done",
      patch: {
        scam_score: out.scam_score,
        scam_reasons: out.scam_reasons,
        final_decision: out.suspicious ? "suspicious" : (ctx.patch.final_decision ?? "keep"),
      },
    };
  },
};

/** Turns unclear flags into a decision from the extracted facts. Code only, no LLM call. */
const resolveStage: Stage = {
  name: "resolve",
  run(p, deps, ctx) {
    const parsed = ExtractionSchema.safeParse(JSON.parse(ctx.patch.extraction ?? "null"));
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.code}`);
      return Promise.resolve({
        kind: "failed",
        patch: { resolved_reasons: JSON.stringify(issues) },
      });
    }
    const row = deps.db.select().from(analysis).where(eq(analysis.posting_id, p.id)).get();
    const flags: unknown = JSON.parse(row?.flags ?? "[]");
    const result = resolveFlags({
      ruleDecision: row?.decision ?? "keep",
      flags: Array.isArray(flags) ? flags.filter((f): f is string => typeof f === "string") : [],
      extraction: parsed.data,
    });
    return Promise.resolve({
      kind: "done",
      patch: { final_decision: result.decision, resolved_reasons: JSON.stringify(result.reasons) },
    });
  },
};

/**
 * Looks up the pay policy on the company's careers pages (PLAN 5.2) for a kept posting, at most once per company and
 * run, and only when the company is due (unknown policy, not checked in 90 days). Runs before the registry and the tier
 * so they see a careers policy in the same run. A spent budget reaches the loop (`budget_wait`); every other failure
 * leaves the policy unknown and prints one warning line per company (no posting or page text).
 */
function makeResearchStage(
  fetchPage: ResearchDeps["fetchPage"],
  warn: (text: string) => void,
): Stage {
  const attempted = new Set<string>();
  return {
    name: "research",
    async run(p, deps, ctx) {
      if (ctx.patch.final_decision !== "keep" || p.company_id === null) {
        return { kind: "done", patch: {} };
      }
      if (attempted.has(p.company_id)) return { kind: "done", patch: {} };
      attempted.add(p.company_id);
      const researchDeps: ResearchDeps = { ...deps, ...(fetchPage ? { fetchPage } : {}) };
      const outcome = await researchCompanyPayPolicy(p.company_id, researchDeps);
      if (outcome.kind === "found") {
        return { kind: "done", patch: { resolved_reasons: JSON.stringify(outcome.reasons) } };
      }
      if (outcome.kind === "retry" || (outcome.kind === "unknown" && outcome.failed)) {
        warn(`pay-policy research failed for ${p.company_name}, policy stays unknown\n`);
      }
      return { kind: "done", patch: {} };
    },
  };
}

/** Stores the company pay policy stated by the posting (once, never over manual / careers). */
const registryStage: Stage = {
  name: "registry",
  async run(p, deps, ctx) {
    const raw = ctx.patch.extraction;
    if (raw === undefined || raw === null) return { kind: "done", patch: {} };
    const extraction = ExtractionSchema.parse(JSON.parse(raw));
    const reasons = recordPostingPolicy(deps.db, { id: p.id, companyId: p.company_id }, extraction);
    return {
      kind: "done",
      patch: reasons.length > 0 ? { resolved_reasons: JSON.stringify(reasons) } : {},
    };
  },
};

/** Sonnet fit score against the CV; only for `final_decision = keep`. Without a CV it does nothing. */
function makeFitStage(cv: string | null): Stage {
  return {
    name: "fit",
    async run(p, deps, ctx) {
      if (cv === null || ctx.patch.final_decision !== "keep") return { kind: "done", patch: {} };
      if (ctx.patch.fit_score !== undefined) return { kind: "done", patch: {} };
      try {
        const fit = await scoreFit(
          {
            postingId: p.id,
            title: p.title,
            companyName: p.company_name,
            locationText: p.location_text,
            descriptionText: p.description_text,
            extraction: ExtractionSchema.parse(JSON.parse(ctx.patch.extraction ?? "null")),
          },
          cv,
          deps,
        );
        return {
          kind: "done",
          patch: {
            fit_score: fit.score,
            fit_reasons: JSON.stringify(fit.reasons),
            fit_model: FIT_MODEL,
            fit_prompt_version: FIT_PROMPT_VERSION,
          },
        };
      } catch (e) {
        if (e instanceof LlmOutputError) {
          // Runs failed so far come from the stored row, so the count survives between runs without a migration.
          const stored = deps.db.select().from(intel).where(eq(intel.posting_id, p.id)).get();
          const runs = failedFitRuns(stored?.resolved_reasons ?? null);
          const reasons = [...e.issues.map((i) => `fit ${i}`), fitAttemptMarker(runs + 1)];
          return { kind: "failed", patch: { resolved_reasons: JSON.stringify(reasons) } };
        }
        if (e instanceof LlmApiError) return { kind: "retry", error: e };
        throw e;
      }
    },
  };
}

/**
 * Tier and ask from what is stored so far (PLAN 5.3). Pure code on the extraction, registry policy and stored FX.
 * Returns null when no IDR rate is stored: a number is never guessed.
 */
function computeTier(
  db: Db,
  p: Posting,
  extractionJson: string,
  salary: SalaryConfig,
  at: Date,
): IntelPatch | null {
  const extraction = ExtractionSchema.parse(JSON.parse(extractionJson));
  const day = jakartaDay(at);
  const idrPerUsd = getRate(db, "IDR", day);
  if (idrPerUsd === null) return null;
  const currency = extraction.listedSalary?.currency.toUpperCase();
  const other = currency === undefined ? null : getRate(db, currency, day);
  const fx: TierFx = {
    idrPerUsd,
    ...(currency !== undefined && other !== null ? { perUsd: { [currency]: other } } : {}),
  };
  const result = decideTierAndAsk(extraction, payPolicyFor(db, p.company_id), salary, fx);
  return {
    tier: result.tier,
    ask_idr_month: result.askIdrMonth,
    ask_usd_year: result.askUsdYear,
    ask_text: result.askText,
    ask_reason: result.askReason,
  };
}

/** Tier and ask for kept postings. Without an FX rate the posting waits (`fx_wait`), it is never `done`. */
function tierStage(salary: SalaryConfig, at: Date): Stage {
  return {
    name: "tier",
    run(p, deps, ctx) {
      const soFar = ctx.patch;
      if (soFar.final_decision !== "keep" || !soFar.extraction) {
        return Promise.resolve({ kind: "done", patch: {} });
      }
      const patch = computeTier(deps.db, p, soFar.extraction, salary, at);
      return Promise.resolve(
        patch === null ? { kind: "fx_wait", patch: {} } : { kind: "done", patch },
      );
    },
  };
}

/** Rows older versions finished as `done` without a tier because no rate was stored. */
const LEGACY_TIER_SKIPPED_SQL = sql`${intel.resolved_reasons} like ${`%${TIER_SKIPPED_NO_FX}%`}`;

/**
 * Kept postings whose tier is missing only for lack of an FX rate: `fx_wait`, plus legacy `done` rows with the old
 * "tier skipped" reason. Only `final_decision = keep` (suspicious and rejected are never tiered).
 */
function selectFxWaiting(db: Db): { posting: Posting; intel: Intel }[] {
  return db
    .select({ posting: postings, intel })
    .from(intel)
    .innerJoin(postings, eq(postings.id, intel.posting_id))
    .where(
      and(
        eq(intel.final_decision, "keep"),
        isNotNull(intel.extraction),
        isNull(intel.tier),
        or(eq(intel.status, "fx_wait"), and(eq(intel.status, "done"), LEGACY_TIER_SKIPPED_SQL)),
      ),
    )
    .all();
}

/** Runs only the tier stage for postings waiting on a rate. No LLM call. Returns how many got a tier. */
function retierWaiting(opts: EnrichOptions, at: Date): number {
  const { db } = opts;
  let tiered = 0;
  for (const row of selectFxWaiting(db)) {
    const tier = computeTier(db, row.posting, row.intel.extraction as string, opts.salary, at);
    if (tier === null) {
      if (row.intel.status !== "fx_wait") {
        upsertIntel(db, row.posting.id, "fx_wait", withoutMarker(row.intel), at);
      }
      continue;
    }
    upsertIntel(db, row.posting.id, "done", { ...tier, ...withoutMarker(row.intel) }, at);
    tiered += 1;
  }
  return tiered;
}

/** Drops the legacy "tier skipped" reason from a stored row. */
function withoutMarker(row: Intel): IntelPatch {
  const reasons = (JSON.parse(row.resolved_reasons ?? "[]") as unknown[]).filter(
    (r) => r !== TIER_SKIPPED_NO_FX,
  );
  return { resolved_reasons: JSON.stringify(reasons) };
}

function waitLine(db: Db): string {
  const n = db.select({ n: count() }).from(intel).where(eq(intel.status, "fx_wait")).get()?.n ?? 0;
  return n > 0 ? `${n} postings wait for an FX rate: run fx\n` : "";
}

/** resolved_reasons are JSON arrays; stages append rather than overwrite. */
function mergePatch(a: IntelPatch, b: IntelPatch): IntelPatch {
  const merged = { ...a, ...b };
  if (a.resolved_reasons && b.resolved_reasons) {
    merged.resolved_reasons = JSON.stringify([
      ...(JSON.parse(a.resolved_reasons) as unknown[]),
      ...(JSON.parse(b.resolved_reasons) as unknown[]),
    ]);
  }
  return merged;
}

function upsertIntel(
  db: Db,
  postingId: string,
  status: NonNullable<IntelPatch["status"]>,
  patch: IntelPatch,
  at: Date,
) {
  const set = { ...patch, status, updated_at: at.toISOString() };
  db.insert(intel)
    .values({ id: randomUUID(), posting_id: postingId, ...set })
    .onConflictDoUpdate({ target: intel.posting_id, set })
    .run();
}

/** Columns written by a paid (LLM) stage: kept when a later stage ends the posting early. */
const PAID_COLUMNS = [
  "extraction",
  "extract_model",
  "extract_prompt_version",
  "fit_score",
  "fit_reasons",
  "fit_model",
  "fit_prompt_version",
] as const satisfies readonly (keyof IntelPatch)[];

function paidOnly(patch: IntelPatch): IntelPatch {
  const kept: Record<string, unknown> = {};
  for (const k of PAID_COLUMNS) if (patch[k] !== undefined) kept[k] = patch[k];
  return kept as IntelPatch;
}

/** Paid results an earlier run saved for this posting, if they match the current prompt versions. */
function savedPaidPatch(db: Db, postingId: string): IntelPatch {
  const row = db.select().from(intel).where(eq(intel.posting_id, postingId)).get();
  if (row === undefined) return {};
  const patch: IntelPatch = {};
  if (row.extraction !== null && row.extract_prompt_version === EXTRACT_PROMPT_VERSION) {
    patch.extraction = row.extraction;
    patch.extract_model = row.extract_model;
    patch.extract_prompt_version = row.extract_prompt_version;
  }
  if (row.fit_score !== null && row.fit_prompt_version === FIT_PROMPT_VERSION) {
    patch.fit_score = row.fit_score;
    patch.fit_reasons = row.fit_reasons;
    patch.fit_model = row.fit_model;
    patch.fit_prompt_version = row.fit_prompt_version;
  }
  return patch;
}

/** `failed` rows whose fit stage failed fewer than `MAX_FIT_ATTEMPTS` runs ago (extraction stored, marker present). */
const FIT_RETRYABLE_SQL = and(
  eq(intel.status, "failed"),
  isNotNull(intel.extraction),
  or(
    ...Array.from(
      { length: MAX_FIT_ATTEMPTS - 1 },
      (_, i) => sql`${intel.resolved_reasons} like ${`%"${fitAttemptMarker(i + 1)}"%`}`,
    ),
  ),
);

/**
 * Kept canonical postings with no intel row, a pending / budget_wait one, or one whose fit scoring failed and may
 * be tried again (extract-stage failures are never selected); newest first.
 */
function selectPostings(db: Db, limit: number | undefined): Posting[] {
  const query = db
    .select({ posting: postings })
    .from(postings)
    .innerJoin(analysis, eq(analysis.posting_id, postings.id))
    .leftJoin(intel, eq(intel.posting_id, postings.id))
    .where(
      and(
        isNull(postings.canonical_posting_id),
        eq(analysis.decision, "keep"),
        or(isNull(intel.id), inArray(intel.status, ["pending", "budget_wait"]), FIT_RETRYABLE_SQL),
      ),
    )
    .orderBy(
      desc(sql`coalesce(${postings.posted_at}, ${postings.first_seen_at})`),
      desc(postings.first_seen_at),
      postings.id,
    );
  const rows = limit === undefined ? query.all() : query.limit(limit).all();
  return rows.map((r) => r.posting);
}

/** No-key scam check is text-only: no network lookup, the domain age stays unknown. */
const noDomainLookup: DomainAgeLookup = () => Promise.resolve(null);

/** Runs the LLM stages on kept postings within the daily budget. Exits 1 for invalid input or after repeated API errors (see MAX_CONSECUTIVE_API_ERRORS), else 0. */
export async function runEnrich(opts: EnrichOptions): Promise<number> {
  const { db, out, err } = opts;
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());

  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
    err("enrich: --limit must be a positive integer\n");
    return 1;
  }

  // Tier-only pass for postings that waited on an FX rate; needs no API key and makes no LLM call.
  const retiered = retierWaiting(opts, now());
  if (retiered > 0) out(`tiered ${retiered} postings that waited for an FX rate\n`);

  const todo = selectPostings(db, opts.limit);

  if (!env["ANTHROPIC_API_KEY"]) {
    // Postings stay pending so the digest can list them as waiting for scoring. The text-only scam rules need no
    // key: a posting that scores suspicious on them is listed as suspicious, not as waiting. They run here (not in
    // `process`) because the result belongs in `intel`; a later run with a key redoes the scam stage with the
    // extraction and its result replaces this one.
    let suspicious = 0;
    for (const p of todo) {
      const scam = await runScamStage(db, p, null, noDomainLookup, now());
      if (scam.suspicious) suspicious += 1;
      upsertIntel(
        db,
        p.id,
        "pending",
        {
          scam_score: scam.scam_score,
          scam_reasons: scam.scam_reasons,
          ...(scam.suspicious ? { final_decision: "suspicious" as const } : {}),
        },
        now(),
      );
    }
    out("ANTHROPIC_API_KEY not set, LLM stages skipped\n");
    out(`scam rules checked ${todo.length} postings, suspicious ${suspicious}\n`);
    out(waitLine(db));
    return 0;
  }

  const deps: LlmDeps = {
    db,
    env,
    now,
    ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
  };

  const cv = opts.cv !== undefined ? opts.cv : loadCv();
  if (cv === null && todo.length > 0) {
    err("cv.md not found in the config dir, fit scoring skipped (extraction still runs)\n");
  }

  const stages: Stage[] = [
    extractStage,
    resolveStage,
    scamStage,
    makeResearchStage(opts.fetchPage, err),
    registryStage,
    makeFitStage(cv),
    tierStage(opts.salary, now()),
    ...(opts.extraStages ?? []),
  ];
  const lookupDomainAge = createDomainAgeLookup(now);

  let enriched = 0;
  let budgetWait = 0;
  let failed = 0;
  let budgetStopped = false;
  let apiErrors = 0;
  let aborted = false;
  let lastApiError: LlmApiError | undefined;

  for (const posting of todo) {
    if (aborted) {
      upsertIntel(db, posting.id, "pending", {}, now());
      continue;
    }
    if (budgetStopped) {
      upsertIntel(db, posting.id, "budget_wait", {}, now());
      budgetWait += 1;
      continue;
    }
    let patch: IntelPatch = savedPaidPatch(db, posting.id);
    let outcome: "done" | "failed" | "retry" | "budget" | "fx_wait" = "done";
    try {
      for (const stage of stages) {
        const result = await stage.run(posting, deps, { patch, lookupDomainAge });
        if (result.kind === "retry") {
          outcome = "retry";
          apiErrors += 1;
          lastApiError = result.error;
          break;
        }
        // A paid stage that ran (non-empty patch, even a failed output) means the API answered.
        if (
          (stage.name === "extract" || stage.name === "fit") &&
          Object.keys(result.patch).length > 0
        ) {
          apiErrors = 0;
        }
        patch = mergePatch(patch, result.patch);
        if (result.kind === "fx_wait") {
          outcome = "fx_wait";
          break;
        }
        if (result.kind === "failed") {
          outcome = "failed";
          break;
        }
        // Suspicious postings are listed, never fit-scored, never given an ask.
        if (patch.final_decision === "suspicious") break;
      }
    } catch (e) {
      if (!(e instanceof BudgetExceededError)) throw e;
      outcome = "budget";
    }

    if (outcome === "done") {
      upsertIntel(db, posting.id, "done", patch, now());
      enriched += 1;
    } else if (outcome === "fx_wait") {
      upsertIntel(db, posting.id, "fx_wait", patch, now());
    } else if (outcome === "failed") {
      upsertIntel(db, posting.id, "failed", patch, now());
      failed += 1;
    } else if (outcome === "retry") {
      upsertIntel(db, posting.id, "pending", paidOnly(patch), now());
      failed += 1;
      if (apiErrors >= MAX_CONSECUTIVE_API_ERRORS) aborted = true;
    } else {
      budgetStopped = true;
      log.warn("enrich: daily LLM budget reached, remaining postings wait", {
        posting_id: posting.id,
      });
      upsertIntel(db, posting.id, "budget_wait", paidOnly(patch), now());
      budgetWait += 1;
    }
  }

  const spent = spentOnDay(db, jakartaDay(now()));
  out(
    `enriched ${enriched}, budget_wait ${budgetWait}, failed ${failed}, spent $${spent.toFixed(2)} today\n`,
  );
  out(waitLine(db));
  if (aborted) {
    const cause = lastApiError
      ? `: status ${lastApiError.status ?? "none"} ${lastApiError.errorType}${lastApiError.errorMessage ? `: ${lastApiError.errorMessage}` : ""}`
      : "";
    err(`enrich aborted after ${MAX_CONSECUTIVE_API_ERRORS} consecutive API errors${cause}\n`);
    return 1;
  }
  return 0;
}
