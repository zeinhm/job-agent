import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  analysis,
  intel,
  loadConfig,
  log,
  postings,
  type Analysis,
  type Db,
  type Intel,
  type SalaryConfig,
} from "@job-agent/core";
import { computeTier } from "./enrich.ts";
import { ExtractionSchema } from "./intel/extract.ts";
import { resolveFlags } from "./intel/resolve.ts";
import { unknownTierAskWarning } from "./intel/tier.ts";
import { analyze } from "./process.ts";

export interface ReprocessOptions {
  db: Db;
  /** Salary config for the tier recompute. Default: from the config dir. */
  salary?: SalaryConfig;
  floorIdrMonth?: number;
  now?: () => Date;
  out: (text: string) => void;
  err: (text: string) => void;
}

interface Counts {
  rulesToReject: number;
  rulesToKeep: number;
  resolveToReject: number;
  resolveToKeep: number;
  pending: number;
}

type IntelUpdate = Partial<typeof intel.$inferInsert>;

/** Everything but the identity and timestamp of a rule result: equal means re-writing the row changes nothing. */
function sameAnalysis(a: Analysis, b: Analysis): boolean {
  const strip = ({ id, analyzed_at, ...rest }: Analysis) => (void id, void analyzed_at, rest);
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

function parseFlags(raw: string): string[] {
  const flags: unknown = JSON.parse(raw);
  return Array.isArray(flags) ? flags.filter((f): f is string => typeof f === "string") : [];
}

/** Columns that hold the tier and ask. */
const TIER_KEYS = ["tier", "ask_idr_month", "ask_usd_year", "ask_text", "ask_reason"] as const;

/**
 * Brings the stored `intel` row in line with the new rule result and the current resolve rules. Code only: no LLM, no
 * network. Suspicious rows and rows without a parseable extraction are left alone. Returns the counts it changed.
 */
function reapplyResolve(
  tx: Db,
  posting: typeof postings.$inferSelect,
  row: Analysis,
  salary: SalaryConfig,
  at: Date,
  counts: Counts,
): void {
  const stored: Intel | undefined = tx
    .select()
    .from(intel)
    .where(eq(intel.posting_id, posting.id))
    .get();
  if (stored === undefined || stored.extraction === null) return;
  if (stored.final_decision !== "keep" && stored.final_decision !== "reject") return;
  const parsed = ExtractionSchema.safeParse(JSON.parse(stored.extraction));
  if (!parsed.success) return;

  const result = resolveFlags({
    ruleDecision: row.decision,
    flags: parseFlags(row.flags ?? "[]"),
    extraction: parsed.data,
  });
  const updatedAt = at.toISOString();

  if (stored.final_decision === "keep" && result.decision === "reject") {
    // Paid data stays; only the decision and its reason change.
    tx.update(intel)
      .set({
        final_decision: "reject",
        resolved_reasons: JSON.stringify(result.reasons),
        updated_at: updatedAt,
      })
      .where(eq(intel.id, stored.id))
      .run();
    counts.resolveToReject += 1;
    return;
  }

  if (stored.final_decision === "reject" && result.decision === "keep") {
    counts.resolveToKeep += 1;
    // Rejected rows skipped the scam stage, so a row is only finished when fit and scam results exist as well.
    if (stored.fit_score !== null && stored.scam_score !== null) {
      const tier = computeTier(tx, posting, stored.extraction, salary, at);
      const set: IntelUpdate = tier === null ? { status: "fx_wait" } : { status: "done", ...tier };
      tx.update(intel)
        .set({
          ...set,
          final_decision: "keep",
          resolved_reasons: JSON.stringify(result.reasons),
          updated_at: updatedAt,
        })
        .where(eq(intel.id, stored.id))
        .run();
      return;
    }
    // Needs fit (and scam) from `enrich`: it resumes from the stored extraction when the prompt version matches.
    tx.update(intel)
      .set({
        status: "pending",
        final_decision: null,
        resolved_reasons: "[]",
        updated_at: updatedAt,
      })
      .where(eq(intel.id, stored.id))
      .run();
    counts.pending += 1;
    return;
  }

  // Decision unchanged: only the tier of a kept, fit-scored row can move (stored FX, pure code).
  if (stored.final_decision === "keep" && stored.fit_score !== null) {
    const tier = computeTier(tx, posting, stored.extraction, salary, at);
    if (tier !== null && TIER_KEYS.some((k) => (tier[k] ?? null) !== stored[k])) {
      tx.update(intel)
        .set({ ...tier, updated_at: updatedAt })
        .where(eq(intel.id, stored.id))
        .run();
    }
  }
}

/**
 * Re-applies the current rule filters and resolve rules to every stored posting without deleting anything and
 * without an LLM or network call. Run after `runProcess`. Returns the exit code (1 if any posting failed).
 */
export function runReprocess(opts: ReprocessOptions): number {
  const { db, out, err } = opts;
  const now = opts.now ?? (() => new Date());
  const floor = opts.floorIdrMonth ?? loadConfig().salary.floor_idr_month;
  const salary = opts.salary ?? loadConfig().salary;
  const askWarning = unknownTierAskWarning(salary);
  if (askWarning !== null) err(askWarning);

  const todo = db
    .select()
    .from(postings)
    .where(and(isNull(postings.canonical_posting_id), isNotNull(postings.normalized_at)))
    .all();

  const counts: Counts = {
    rulesToReject: 0,
    rulesToKeep: 0,
    resolveToReject: 0,
    resolveToKeep: 0,
    pending: 0,
  };
  let reprocessed = 0;
  let failed = 0;

  for (const p of todo) {
    try {
      const local: Counts = { ...counts };
      db.transaction((tx) => {
        const t = tx as unknown as Db;
        const at = now();
        const old = t.select().from(analysis).where(eq(analysis.posting_id, p.id)).get();
        // No row means the normal process failed on this posting (already reported); do not retry it here.
        if (old === undefined) return;
        const fresh = analyze(t, p, floor, at).row as Analysis;
        if (!sameAnalysis(old, fresh)) {
          t.delete(analysis).where(eq(analysis.posting_id, p.id)).run();
          t.insert(analysis)
            .values({ ...fresh, id: randomUUID() })
            .run();
        }
        const hasIntel = t
          .select({ id: intel.id })
          .from(intel)
          .where(eq(intel.posting_id, p.id))
          .get();
        if (old.decision !== fresh.decision) {
          if (fresh.decision === "reject") local.rulesToReject += 1;
          else {
            local.rulesToKeep += 1;
            // Without an intel row the next `enrich` picks it up.
            if (hasIntel === undefined) local.pending += 1;
          }
        }
        reapplyResolve(t, p, sameAnalysis(old, fresh) ? old : fresh, salary, at, local);
      });
      Object.assign(counts, local);
      reprocessed += 1;
    } catch (e) {
      failed += 1;
      const message = e instanceof Error ? e.message : String(e);
      log.error("reprocess: posting failed", { postingId: p.id, error: message });
      err(`reprocess: posting ${p.id} failed: ${message}\n`);
    }
  }

  out(
    `reprocessed ${reprocessed} postings: rules keep->reject ${counts.rulesToReject}, reject->keep ${counts.rulesToKeep}; ` +
      `resolve keep->reject ${counts.resolveToReject}, reject->keep ${counts.resolveToKeep}; ` +
      `now pending for enrich ${counts.pending}${failed > 0 ? `, failed ${failed}` : ""}\n`,
  );
  return failed > 0 ? 1 : 0;
}
