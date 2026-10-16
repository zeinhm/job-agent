import type { Db } from "@job-agent/core";
import { loadFillContext, recordUncoveredLabels } from "../../fill-plan-db.ts";
import { planFill, type FormField, type ResumeProbe } from "../../fill-plan.ts";
import type { DryRunFieldInput } from "../../dry-runs-store.ts";
import { matchQuestions } from "../../match-questions.ts";
import { FIXTURE_HOST } from "../request-guard.ts";
import {
  DryRunSession,
  HarnessRefusalError,
  openDryRunSession,
  type FinishedRun,
} from "../session.ts";
import { describeComparison } from "../greenhouse/form.ts";
import { loadStoredQuestions, type PlanContext } from "../greenhouse/filler.ts";
import { applyControl, kept, storeQuestions, valueText } from "../lever/filler.ts";
import { compareQuestions, fieldsFromControls } from "../lever/form.ts";
import {
  ASHBY_READY_SELECTOR,
  ASHBY_SCOPE,
  READ_CONTROLS_EXPRESSION,
  readValuesExpression,
  type AshbyControl,
} from "./form.ts";

/** The one host a real (owner-run) Ashby dry run may open: the hosted job pages. */
const ASHBY_HOST = "jobs.ashbyhq.com";

export interface AshbyRunOptions {
  db: Db;
  /** Folder of the DB (see `dataDirOfDb`); the screenshot goes under `<dataDir>/dryruns/`. */
  dataDir: string;
  postingId: string;
  /** The hosted application page. Fixture mode: on 127.0.0.1. Real mode: `https://jobs.ashbyhq.com/...`. */
  url: string;
  fixture: boolean;
  /** Default true; the owner-run CLI opens a visible window unless `--headless`. */
  headless?: boolean;
  /** Answers, choice mappings, tier ask and scam flag; default: read from the DB (`loadFillContext`). */
  context?: PlanContext;
  probeResume?: ResumeProbe;
  /** Test seam: called with the filled session just before the screenshot. */
  beforeFinish?: (session: DryRunSession) => Promise<void>;
}

export interface AshbyRunSummary extends FinishedRun {
  /** Fields of the form the run put a value into / fields of the form the plan covered (0 after a stop). */
  filled: number;
  total: number;
}

/** The posting's stored Ashby questions as planner fields (`ats.id` = the control's `name`, the field path). */
export const loadStoredAshbyQuestions = (db: Db, postingId: string): FormField[] =>
  loadStoredQuestions(db, postingId, "ashby");

function assertUrl(url: string, fixture: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HarnessRefusalError("refused: the form URL is not a URL");
  }
  if (fixture) {
    if (parsed.hostname !== FIXTURE_HOST)
      throw new HarnessRefusalError(`refused: fixture mode only opens ${FIXTURE_HOST}`);
  } else if (parsed.protocol !== "https:" || parsed.hostname !== ASHBY_HOST) {
    throw new HarnessRefusalError("refused: not an Ashby application page");
  }
}

/**
 * Ashby dry run: opens the application page behind the guards (the page's own read-only GraphQL query is on the allowlist,
 * every mutation is aborted), waits for the form to be drawn, reads its fields from the rendered DOM and stores them as
 * `posting_questions` (a difference from the last stored set stops the run `form_changed`; Ashby has no public questions
 * endpoint, so the page is the only source), matches them (`matchQuestions`), plans the values (`planFill`), fills every
 * covered field through the session helpers, checks what the page kept, takes the screenshot and records the run.
 * Nothing is ever submitted: the session cannot click a submit control, `ApiSubmit*` mutations never leave the browser, and
 * neither do the draft writes (`ApiSetFormValue`) or the resume upload handle; a page that drops a value because its draft
 * write was refused shows that field as not filled. Never returns or logs a value.
 */
export async function runAshbyDryRun(opts: AshbyRunOptions): Promise<AshbyRunSummary> {
  assertUrl(opts.url, opts.fixture);
  const session = await openDryRunSession({
    db: opts.db,
    dataDir: opts.dataDir,
    postingId: opts.postingId,
    ats: "ashby",
    url: opts.url,
    fixture: opts.fixture,
    ready: ASHBY_READY_SELECTOR,
    ...(opts.headless !== undefined ? { headless: opts.headless } : {}),
  });
  const done = async (
    result: Parameters<DryRunSession["finish"]>[0],
    filled = 0,
    total = 0,
  ): Promise<AshbyRunSummary> => ({ ...(await session.finish(result)), filled, total });
  try {
    if (session.stop) return await done(undefined);

    const controls = await session.snapshot<AshbyControl[] | null>(READ_CONTROLS_EXPRESSION);
    if (controls === null || controls.length === 0)
      return await done({
        status: "stopped",
        stop_reason: "form_changed",
        stop_detail: controls === null ? "application form not found" : "no questions on the page",
      });

    const fields = fieldsFromControls(controls, "ashby");
    const stored = loadStoredAshbyQuestions(opts.db, opts.postingId);
    const comparison = compareQuestions(stored, fields);
    // First visit (nothing stored) and a changed page both store what the page shows now; only a change stops the run.
    if (stored.length === 0 || !comparison.ok)
      storeQuestions(opts.db, opts.postingId, "ashby", fields, new Date());
    matchQuestions(opts.db);
    if (stored.length > 0 && !comparison.ok)
      return await done({
        status: "stopped",
        stop_reason: "form_changed",
        stop_detail: describeComparison(comparison),
      });

    const byName = new Map(controls.map((c) => [c.name, c]));
    const plan = planFill({
      fields,
      ...(opts.context ?? loadFillContext(opts.db, opts.postingId)),
      ...(opts.probeResume !== undefined ? { probeResume: opts.probeResume } : {}),
    });
    if (plan.kind === "stop")
      return await done({
        status: "stopped",
        stop_reason: plan.reason,
        stop_detail: plan.details.join(", ").slice(0, 200),
      });
    recordUncoveredLabels(opts.db, plan);

    // Fill every covered field; a refusal by the page is kept per field and never stops the others.
    const refused = new Map<string, string>();
    for (const p of plan.fields) {
      if (!p.filled) continue;
      const control = byName.get(p.field.ats.id) as AshbyControl;
      try {
        await applyControl(session, control, p.value, ASHBY_SCOPE);
      } catch (err) {
        // Playwright messages quote the value being set: only the fixed harness wording is kept.
        refused.set(
          p.field.ats.id,
          err instanceof HarnessRefusalError ? err.message.slice(0, 200) : "page refused the value",
        );
      }
    }
    const got = await session.snapshot<Record<string, string[]>>(readValuesExpression(controls));
    const rows: DryRunFieldInput[] = plan.fields.map((p): DryRunFieldInput => {
      const base = {
        label: p.field.label,
        field_type: p.field.field_type,
        required: p.field.required,
        answer_key: p.answerKey,
      };
      if (!p.filled) return { ...base, source: "none", value: null, filled: false, note: p.detail };
      const id = p.field.ats.id;
      const control = byName.get(id) as AshbyControl;
      const why =
        refused.get(id) ??
        (kept(control, p.value, got[id] ?? []) ? null : "page kept a different value");
      return why === null
        ? { ...base, source: p.source, value: valueText(p), filled: true, note: null }
        : { ...base, source: p.source, value: null, filled: false, note: why };
    });

    const open = rows.filter((r) => !r.filled).length;
    const pageRefused = rows.filter((r) => !r.filled && r.source !== "none").length;
    const filled = rows.length - open;
    await opts.beforeFinish?.(session);
    if (open === 0) return await done({ status: "filled", fields: rows }, filled, rows.length);
    return await done(
      {
        status: "needs_input",
        stop_reason:
          pageRefused > 0 ? "uncovered_question" : (plan.needsInputReason ?? "uncovered_question"),
        stop_detail: `${open} field(s) need input${pageRefused > 0 ? `; the page refused ${pageRefused}` : ""}`,
        fields: rows,
      },
      filled,
      rows.length,
    );
  } catch (err) {
    await session.close();
    throw err;
  }
}
