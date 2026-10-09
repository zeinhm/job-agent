import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
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
import { FIT_MODEL, FIT_PROMPT_VERSION, scoreFit } from "./intel/fit.ts";
import { createDomainAgeLookup, type DomainAgeLookup } from "./intel/rdap.ts";
import { payPolicyFor, recordPostingPolicy } from "./intel/registry.ts";
import { runScamStage } from "./intel/scam-stage.ts";
import { decideTierAndAsk, type TierFx } from "./intel/tier.ts";

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
}

type IntelPatch = Partial<typeof intel.$inferInsert>;

type StageResult =
  | { kind: "done"; patch: IntelPatch }
  | { kind: "failed"; patch: IntelPatch }
  /** Transient API failure: nothing is stored, the posting is retried on the next run. */
  | { kind: "retry" };

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
  async run(p, deps) {
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
      if (e instanceof LlmApiError) return { kind: "retry" };
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
          return {
            kind: "failed",
            patch: { resolved_reasons: JSON.stringify(e.issues.map((i) => `fit ${i}`)) },
          };
        }
        if (e instanceof LlmApiError) return { kind: "retry" };
        throw e;
      }
    },
  };
}

/** Tier and ask for kept postings (PLAN 5.3). Pure code on the extraction, registry policy and stored FX. */
function tierStage(salary: SalaryConfig, at: Date): Stage {
  return {
    name: "tier",
    run(p, deps, ctx) {
      const soFar = ctx.patch;
      if (soFar.final_decision !== "keep" || !soFar.extraction) {
        return Promise.resolve({ kind: "done", patch: {} });
      }
      const extraction = ExtractionSchema.parse(JSON.parse(soFar.extraction));
      const day = jakartaDay(at);
      const idrPerUsd = getRate(deps.db, "IDR", day);
      if (idrPerUsd === null) {
        // Never guess a number: no tier until the `fx` command has stored a rate.
        return Promise.resolve({
          kind: "done",
          patch: { resolved_reasons: JSON.stringify(["tier skipped: no IDR FX rate stored"]) },
        });
      }
      const currency = extraction.listedSalary?.currency.toUpperCase();
      const other = currency === undefined ? null : getRate(deps.db, currency, day);
      const fx: TierFx = {
        idrPerUsd,
        ...(currency !== undefined && other !== null ? { perUsd: { [currency]: other } } : {}),
      };
      const result = decideTierAndAsk(extraction, payPolicyFor(deps.db, p.company_id), salary, fx);
      return Promise.resolve({
        kind: "done",
        patch: {
          tier: result.tier,
          ask_idr_month: result.askIdrMonth,
          ask_usd_year: result.askUsdYear,
          ask_text: result.askText,
          ask_reason: result.askReason,
        },
      });
    },
  };
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

/** Kept canonical postings with no intel row, or a pending / budget_wait one; newest first. */
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
        or(isNull(intel.id), inArray(intel.status, ["pending", "budget_wait"])),
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

/** Runs the LLM stages on kept postings within the daily budget. Always exits 0 unless the input is invalid. */
export async function runEnrich(opts: EnrichOptions): Promise<number> {
  const { db, out, err } = opts;
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());

  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
    err("enrich: --limit must be a positive integer\n");
    return 1;
  }

  const todo = selectPostings(db, opts.limit);

  if (!env["ANTHROPIC_API_KEY"]) {
    // Postings stay pending so the digest can list them as waiting for scoring.
    for (const p of todo) upsertIntel(db, p.id, "pending", {}, now());
    out("ANTHROPIC_API_KEY not set, LLM stages skipped\n");
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

  for (const posting of todo) {
    if (budgetStopped) {
      upsertIntel(db, posting.id, "budget_wait", {}, now());
      budgetWait += 1;
      continue;
    }
    let patch: IntelPatch = {};
    let outcome: "done" | "failed" | "retry" | "budget" = "done";
    try {
      for (const stage of stages) {
        const result = await stage.run(posting, deps, { patch, lookupDomainAge });
        if (result.kind === "retry") {
          outcome = "retry";
          break;
        }
        patch = mergePatch(patch, result.patch);
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
    } else if (outcome === "failed") {
      upsertIntel(db, posting.id, "failed", patch, now());
      failed += 1;
    } else if (outcome === "retry") {
      upsertIntel(db, posting.id, "pending", {}, now());
      failed += 1;
    } else {
      budgetStopped = true;
      log.warn("enrich: daily LLM budget reached, remaining postings wait", {
        posting_id: posting.id,
      });
      upsertIntel(db, posting.id, "budget_wait", {}, now());
      budgetWait += 1;
    }
  }

  const spent = spentOnDay(db, jakartaDay(now()));
  out(
    `enriched ${enriched}, budget_wait ${budgetWait}, failed ${failed}, spent $${spent.toFixed(2)} today\n`,
  );
  return 0;
}
