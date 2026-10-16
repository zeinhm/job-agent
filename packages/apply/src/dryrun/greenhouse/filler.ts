import { basename } from "node:path";
import { posting_questions, type Db } from "@job-agent/core";
import { asc, and, eq } from "drizzle-orm";
import { loadFillContext, recordUncoveredLabels } from "../../fill-plan-db.ts";
import {
  planFill,
  type FillInput,
  type FormField,
  type PlannedField,
  type ResumeProbe,
} from "../../fill-plan.ts";
import type { DryRunFieldInput } from "../../dry-runs-store.ts";
import { normalizeQuestion } from "../../match.ts";
import { FIXTURE_HOST } from "../request-guard.ts";
import {
  DryRunSession,
  HarnessRefusalError,
  openDryRunSession,
  type FinishedRun,
} from "../session.ts";
import {
  READ_CONTROLS_EXPRESSION,
  compareForm,
  describeComparison,
  readValuesExpression,
  type DomControl,
} from "./form.ts";

/** Hosts a real (owner-run) Greenhouse dry run may open: the hosted job-boards pages, nothing else. */
const GREENHOUSE_HOST = /^(?:job-)?boards(?:\.eu)?\.greenhouse\.io$/;

export type PlanContext = Pick<FillInput, "answers" | "choiceMappings" | "ask" | "scamFlagged">;

export interface GreenhouseRunOptions {
  db: Db;
  /** Folder of the DB (see `dataDirOfDb`); the screenshot goes under `<dataDir>/dryruns/`. */
  dataDir: string;
  postingId: string;
  /** The hosted form page. Fixture mode: on 127.0.0.1. Real mode: a Greenhouse job-boards page. */
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

export interface GreenhouseRunSummary extends FinishedRun {
  /** Fields of the form the run put a value into / fields of the form the plan covered (0 after a stop). */
  filled: number;
  total: number;
}

/** The posting's stored Greenhouse questions as planner fields (`ats.id` = the page's control id). */
export function loadStoredQuestions(db: Db, postingId: string): FormField[] {
  return db
    .select()
    .from(posting_questions)
    .where(
      and(
        eq(posting_questions.posting_id, postingId),
        eq(posting_questions.ats_type, "greenhouse"),
      ),
    )
    .orderBy(asc(posting_questions.question_id))
    .all()
    .map((q): FormField => {
      let options: string[] | null = null;
      if (q.options !== null) {
        try {
          const v: unknown = JSON.parse(q.options);
          if (Array.isArray(v)) options = v.filter((x): x is string => typeof x === "string");
        } catch {
          options = null;
        }
      }
      return {
        label: q.label,
        field_type: q.type,
        required: q.required,
        options,
        ats: { type: "greenhouse", id: q.question_id },
      };
    });
}

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
  } else if (parsed.protocol !== "https:" || !GREENHOUSE_HOST.test(parsed.hostname)) {
    throw new HarnessRefusalError("refused: not a Greenhouse job-boards page");
  }
}

const cssOf = (id: string) => ({ css: `[id="${id.replace(/["\\]/g, "\\$&")}"]` });

/** Puts one planned value into its control, through the guarded session helpers only. */
async function apply(
  session: DryRunSession,
  c: DomControl,
  value: string | string[],
): Promise<void> {
  const list = Array.isArray(value) ? value : [value];
  const first = list[0] ?? "";
  switch (c.kind) {
    case "text":
    case "textarea":
      return session.fill(cssOf(c.id), list.join("; "));
    case "select":
      return session.select(cssOf(c.id), { label: first });
    case "multiselect":
      return session.selectMany(cssOf(c.id), list);
    case "combobox":
      return session.choose(cssOf(c.id), list);
    case "file":
      return session.upload(cssOf(c.id), first);
    case "radio_group":
    case "checkbox_group": {
      for (const label of list) {
        const at = (c.options ?? []).findIndex(
          (o) => normalizeQuestion(o) === normalizeQuestion(label),
        );
        const optionId = c.optionIds[at];
        if (optionId === undefined)
          throw new HarnessRefusalError("refused: option not on the page");
        await session.check(cssOf(optionId), true);
      }
      return;
    }
    case "unsupported":
      throw new HarnessRefusalError("refused: unsupported control");
  }
}

/** True when what the page kept equals what was planned (texts exactly, choices and files by normalized label). */
function kept(c: DomControl, value: string | string[], got: readonly string[]): boolean {
  if (c.kind === "text" || c.kind === "textarea") return got.length === 1 && got[0] === value;
  const want = (Array.isArray(value) ? value : [value]).map((v) =>
    c.kind === "file" ? basename(v) : normalizeQuestion(v),
  );
  const have = got.map((v) => (c.kind === "file" ? v : normalizeQuestion(v)));
  return want.length === have.length && want.every((w) => have.includes(w));
}

const valueText = (p: Extract<PlannedField, { filled: true }>): string =>
  p.source === "resume" && typeof p.value === "string"
    ? basename(p.value)
    : Array.isArray(p.value)
      ? p.value.join("; ")
      : p.value;

/**
 * Greenhouse dry run: reads the form from the page, compares it with the stored questions (a difference stops the run
 * `form_changed`), plans the values (`planFill`), fills every covered field through the session helpers, checks what the
 * page kept, takes the screenshot and records the run. Nothing is ever submitted: the session cannot click a submit
 * control, and both guard layers abort every non-GET request. Never returns or logs a value.
 */
export async function runGreenhouseDryRun(
  opts: GreenhouseRunOptions,
): Promise<GreenhouseRunSummary> {
  assertUrl(opts.url, opts.fixture);
  const stored = loadStoredQuestions(opts.db, opts.postingId);
  if (stored.length === 0)
    throw new HarnessRefusalError("refused: the posting has no stored Greenhouse questions");
  const session = await openDryRunSession({
    db: opts.db,
    dataDir: opts.dataDir,
    postingId: opts.postingId,
    ats: "greenhouse",
    url: opts.url,
    fixture: opts.fixture,
    ...(opts.headless !== undefined ? { headless: opts.headless } : {}),
  });
  const done = async (
    result: Parameters<DryRunSession["finish"]>[0],
    filled = 0,
    total = 0,
  ): Promise<GreenhouseRunSummary> => ({ ...(await session.finish(result)), filled, total });
  try {
    if (session.stop) return await done(undefined);

    const controls = await session.snapshot<DomControl[] | null>(READ_CONTROLS_EXPRESSION);
    if (controls === null)
      return await done({
        status: "stopped",
        stop_reason: "form_changed",
        stop_detail: "application form not found",
      });
    const comparison = compareForm(stored, controls);
    if (!comparison.ok)
      return await done({
        status: "stopped",
        stop_reason: "form_changed",
        stop_detail: describeComparison(comparison),
      });

    const byId = new Map(controls.map((c) => [c.id, c]));
    const order = new Map(controls.map((c, i) => [c.id, i]));
    const fields = [...stored].sort(
      (a, b) => (order.get(a.ats.id) ?? 0) - (order.get(b.ats.id) ?? 0),
    );
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
      const control = byId.get(p.field.ats.id) as DomControl;
      try {
        await apply(session, control, p.value);
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
      const control = byId.get(id) as DomControl;
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
