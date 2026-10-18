import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { posting_questions, type Db } from "@job-agent/core";
import { and, eq } from "drizzle-orm";
import { loadFillContext, recordUncoveredLabels } from "../../fill-plan-db.ts";
import { planFill, type FormField, type PlannedField, type ResumeProbe } from "../../fill-plan.ts";
import type { DryRunFieldInput } from "../../dry-runs-store.ts";
import { normalizeQuestion } from "../../match.ts";
import { readbackEqual } from "../readback.ts";
import { matchQuestions } from "../../match-questions.ts";
import { autocompleteRow, type SuggestionResult } from "../autocomplete.ts";
import { FIXTURE_HOST } from "../request-guard.ts";
import {
  DryRunSession,
  HarnessRefusalError,
  openDryRunSession,
  type DryRunSessionOptions,
  type FinishedRun,
} from "../session.ts";
import { describeComparison } from "../greenhouse/form.ts";
import { loadStoredQuestions, type PlanContext } from "../greenhouse/filler.ts";
import {
  READ_CONTROLS_EXPRESSION,
  compareQuestions,
  fieldsFromControls,
  readValuesExpression,
  type LeverControl,
} from "./form.ts";

/** Hosts a real (owner-run) Lever dry run may open: the hosted apply pages, nothing else. */
const LEVER_HOST = /^jobs(?:\.eu)?\.lever\.co$/;

export interface LeverRunOptions {
  db: Db;
  /** Folder of the DB (see `dataDirOfDb`); the screenshot goes under `<dataDir>/dryruns/`. */
  dataDir: string;
  postingId: string;
  /** The hosted apply page. Fixture mode: on 127.0.0.1. Real mode: a Lever `jobs.lever.co` page. */
  url: string;
  fixture: boolean;
  /** Default true; the owner-run CLI opens a visible window unless `--headless`. */
  headless?: boolean;
  /** Who started the run (see `DryRunSessionOptions.starter`). */
  starter?: DryRunSessionOptions["starter"];
  /** Answers, choice mappings, tier ask and scam flag; default: read from the DB (`loadFillContext`). */
  context?: PlanContext;
  probeResume?: ResumeProbe;
  /** Test seam: called with the filled session just before the screenshot. */
  beforeFinish?: (session: DryRunSession) => Promise<void>;
}

export interface LeverRunSummary extends FinishedRun {
  /** Fields of the form the run put a value into / fields of the form the plan covered (0 after a stop). */
  filled: number;
  total: number;
}

/** The posting's stored Lever questions as planner fields (`ats.id` = the control's `name`). */
export const loadStoredLeverQuestions = (db: Db, postingId: string): FormField[] =>
  loadStoredQuestions(db, postingId, "lever");

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
  } else if (parsed.protocol !== "https:" || !LEVER_HOST.test(parsed.hostname)) {
    throw new HarnessRefusalError("refused: not a Lever apply page");
  }
}

/**
 * Replaces the posting's stored Lever questions with the fields the page shows now (Lever has no questions API: the
 * apply page is the only source, and it is the page this run already opened). `matched_key` starts empty; `matchQuestions`
 * fills it right after.
 */
export function storeQuestions(
  db: Db,
  postingId: string,
  atsType: string,
  fields: readonly FormField[],
  now: Date,
): void {
  const at = now.toISOString();
  db.transaction((tx) => {
    tx.delete(posting_questions)
      .where(
        and(eq(posting_questions.posting_id, postingId), eq(posting_questions.ats_type, atsType)),
      )
      .run();
    for (const f of fields) {
      tx.insert(posting_questions)
        .values({
          id: randomUUID(),
          posting_id: postingId,
          ats_type: atsType,
          question_id: f.ats.id,
          label: f.label,
          required: f.required,
          type: f.field_type,
          options: f.options === null ? null : JSON.stringify(f.options),
          normalized_label: normalizeQuestion(f.label),
          matched_key: null,
          fetched_at: at,
        })
        .run();
    }
  });
}

const cssEscape = (s: string): string => s.replace(/["\\]/g, "\\$&");

/** CSS scope of the Lever form; the Ashby filler passes its own container. */
const LEVER_SCOPE = "form#application-form";

/**
 * Puts one planned value into its control (found by `name` inside `scope`), through the guarded session helpers only.
 * Shared with the Ashby filler, whose controls have the same shape.
 */
export async function applyControl(
  session: DryRunSession,
  c: LeverControl,
  value: string | string[],
  scope: string,
): Promise<void> {
  const cssOf = (name: string) => ({ css: `${scope} [name="${cssEscape(name)}"]` });
  const optionCssOf = (name: string, optionValue: string) => ({
    css: `${scope} [name="${cssEscape(name)}"][value="${cssEscape(optionValue)}"]`,
  });
  const list = Array.isArray(value) ? value : [value];
  const first = list[0] ?? "";
  switch (c.kind) {
    case "text":
    case "textarea":
      return session.fill(cssOf(c.name), list.join("; "));
    case "select":
      return session.select(cssOf(c.name), { label: first });
    case "multiselect":
      return session.selectMany(cssOf(c.name), list);
    case "file":
      return session.upload(cssOf(c.name), first);
    case "radio_group":
    case "checkbox_group": {
      for (const label of list) {
        const at = (c.options ?? []).findIndex(
          (o) => normalizeQuestion(o) === normalizeQuestion(label),
        );
        const optionValue = c.optionValues[at];
        if (optionValue === undefined)
          throw new HarnessRefusalError("refused: option not on the page");
        await session.check(optionCssOf(c.name, optionValue), true);
      }
      return;
    }
    case "combobox":
      throw new HarnessRefusalError("refused: a combobox is picked by the owner");
    case "unsupported":
      throw new HarnessRefusalError("refused: unsupported control");
  }
}

/** Lever's "Current location" input: the control named `location` (its hidden `selectedLocation` is never read). */
const isLocationControl = (c: LeverControl): boolean => c.name === "location" && c.kind === "text";

const digitsOf = (s: string): string => s.replace(/\D/g, "");

/**
 * Phone rule: pages reformat a typed number (spaces, dashes, brackets, a country prefix), so only the digits count. The kept
 * digits must equal the typed digits or end with them (a prefix the page added); the typed digits must not be empty.
 */
export function phoneKept(value: string | string[], got: readonly string[]): boolean {
  const want = digitsOf(Array.isArray(value) ? value.join("") : value);
  const have = got.length === 1 ? digitsOf(got[0] ?? "") : "";
  return want !== "" && have.endsWith(want);
}

/**
 * True when what the page kept equals what was planned (texts exactly, choices and files by normalized label). A phone
 * field (`phone`) is compared by digits only (`phoneKept`).
 */
export function kept(
  c: LeverControl,
  value: string | string[],
  got: readonly string[],
  phone = false,
): boolean {
  if (phone && (c.kind === "text" || c.kind === "textarea")) return phoneKept(value, got);
  return readbackEqual(c.kind, value, got);
}

export const valueText = (p: Extract<PlannedField, { filled: true }>): string =>
  p.source === "resume" && typeof p.value === "string"
    ? basename(p.value)
    : Array.isArray(p.value)
      ? p.value.join("; ")
      : p.value;

/**
 * Lever dry run: reads the form from the page it opened (no other fetch), stores the fields as `posting_questions`
 * (a difference from the last stored set stops the run `form_changed`), matches them (`matchQuestions`: unknown wordings
 * reach the Inbox, choice questions get a mapping request), plans the values (`planFill`), fills every covered field
 * through the session helpers, checks what the page kept, takes the screenshot and records the run. Nothing is ever
 * submitted: the session cannot click a submit control, and both guard layers abort every non-GET request (Lever's
 * `/parseResume` upload included). Never returns or logs a value.
 */
export async function runLeverDryRun(opts: LeverRunOptions): Promise<LeverRunSummary> {
  assertUrl(opts.url, opts.fixture);
  const session = await openDryRunSession({
    db: opts.db,
    dataDir: opts.dataDir,
    postingId: opts.postingId,
    ats: "lever",
    url: opts.url,
    fixture: opts.fixture,
    ...(opts.headless !== undefined ? { headless: opts.headless } : {}),
    ...(opts.starter !== undefined ? { starter: opts.starter } : {}),
  });
  const done = async (
    result: Parameters<DryRunSession["finish"]>[0],
    filled = 0,
    total = 0,
  ): Promise<LeverRunSummary> => {
    const run = await session.finish(result);
    // A challenge that appeared mid-run stops the run: nothing counts as filled.
    return session.stop ? { ...run, filled: 0, total: 0 } : { ...run, filled, total };
  };
  try {
    if (session.stop) return await done(undefined);

    const controls = await session.snapshot<LeverControl[] | null>(READ_CONTROLS_EXPRESSION);
    if (controls === null || controls.length === 0)
      return await done({
        status: "stopped",
        stop_reason: "form_changed",
        stop_detail: controls === null ? "application form not found" : "no questions on the page",
      });

    const fields = fieldsFromControls(controls);
    const stored = loadStoredLeverQuestions(opts.db, opts.postingId);
    const comparison = compareQuestions(stored, fields);
    // First visit (nothing stored) and a changed page both store what the page shows now; only a change stops the run.
    if (stored.length === 0 || !comparison.ok)
      storeQuestions(opts.db, opts.postingId, "lever", fields, new Date());
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
    const picked = new Map<string, SuggestionResult>();
    for (const p of plan.fields) {
      if (session.stop) break; // a CAPTCHA challenge appeared: no further field is filled
      if (!p.filled) continue;
      const control = byName.get(p.field.ats.id) as LeverControl;
      try {
        if (isLocationControl(control)) {
          // The location autocomplete: the approved answer is typed, a suggestion is picked only when exactly one matches.
          const answer = Array.isArray(p.value) ? p.value.join(" ") : p.value;
          picked.set(
            p.field.ats.id,
            await session.pickSuggestion(
              { css: `${LEVER_SCOPE} [name="${cssEscape(control.name)}"]` },
              answer,
            ),
          );
          continue;
        }
        await applyControl(session, control, p.value, LEVER_SCOPE);
      } catch (err) {
        // Playwright messages quote the value being set: only the fixed harness wording is kept.
        refused.set(
          p.field.ats.id,
          err instanceof HarnessRefusalError ? err.message.slice(0, 200) : "page refused the value",
        );
      }
    }
    if (session.stop) return await done(undefined);
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
      const control = byName.get(id) as LeverControl;
      const suggestion = picked.get(id);
      if (suggestion !== undefined) return autocompleteRow(p.field, suggestion);
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
