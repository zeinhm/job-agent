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
import { readbackEqual } from "../readback.ts";
import { approvedLocation, autocompleteRow, type SuggestionResult } from "../autocomplete.ts";
import { FIXTURE_HOST } from "../request-guard.ts";
import {
  DryRunSession,
  HarnessRefusalError,
  openDryRunSession,
  type DryRunSessionOptions,
  type FinishedRun,
} from "../session.ts";
import {
  READ_CLOSED_EXPRESSION,
  READ_CONTROLS_EXPRESSION,
  alignGroups,
  compareForm,
  describeComparison,
  extraControls,
  pairLocation,
  readValuesExpression,
  type DomControl,
  type DomKind,
} from "./form.ts";

/** Hosts a real (owner-run) Greenhouse dry run may open: the hosted job-boards pages, nothing else. */
const GREENHOUSE_HOST = /^(?:job-)?boards(?:\.eu)?\.greenhouse\.io$/;

export type PlanContext = Pick<
  FillInput,
  "answers" | "choiceMappings" | "ask" | "scamFlagged" | "posting"
>;

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
  /** Who started the run (see `DryRunSessionOptions.starter`). */
  starter?: DryRunSessionOptions["starter"];
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

/** The posting's stored questions of one ATS as planner fields (`ats.id` = the page's control id / name). */
export function loadStoredQuestions(
  db: Db,
  postingId: string,
  atsType: "greenhouse" | "lever" | "ashby" = "greenhouse",
): FormField[] {
  return db
    .select()
    .from(posting_questions)
    .where(
      and(eq(posting_questions.posting_id, postingId), eq(posting_questions.ats_type, atsType)),
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
        ats: { type: atsType, id: q.question_id },
      };
    });
}

/** The page's controls, with a choice group that has no id of its own taking its stored question's id. */
async function readControls(
  session: DryRunSession,
  stored: readonly FormField[],
): Promise<DomControl[] | null> {
  const read = await session.snapshot<DomControl[] | null>(READ_CONTROLS_EXPRESSION);
  return read === null ? null : alignGroups(stored, read);
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

/**
 * The embedded application form of a hosted job page (`/<slug>/jobs/<id>` -> `/embed/job_app?for=<slug>&token=<id>`, same
 * host): opened once when the hosted page sends the visitor on to the company's career page. Null for any other path.
 */
export function embeddedFormUrl(url: string): string | null {
  const u = new URL(url);
  const m = /^\/([A-Za-z0-9][A-Za-z0-9._-]*)\/jobs\/(\d+)\/?$/.exec(u.pathname);
  return m === null ? null : `${u.origin}/embed/job_app?for=${m[1]}&token=${m[2]}`;
}

/** The cover letter upload (`input#cover_letter`) and the textarea its "Enter manually" option opens. */
const COVER_FILE_ID = "cover_letter";
const COVER_TEXT_ID = "cover_letter_text";

/** Readback settle: up to this many waits of this length before a mismatch counts (only paid when a field differs). */
const SETTLE_POLLS = 4;
/** A pending file field waits longer: the page uploads the file and swaps its input only when that completes. */
const UPLOAD_SETTLE_POLLS = 20;
/** Fixed note for a file the page did not keep (listed in the dry-run report's known notes). */
export const UPLOAD_NOT_KEPT_NOTE = "page did not keep the uploaded file";
/** Fixed note for a cover letter text the manual textarea refused or did not keep (listed in the report's known notes). */
export const COVER_TEXT_NOT_KEPT_NOTE = "cover letter text not kept by the page";
/** Fixed note for a page question that is not among the stored questions (listed in the dry-run report's known notes). */
export const EXTRA_QUESTION_NOTE = "question not in the stored set: needs an answer";
const EXTRA_FIELD_TYPE: Record<DomKind, string> = {
  text: "text",
  textarea: "long_text",
  file: "file",
  select: "choice",
  multiselect: "multi_choice",
  combobox: "choice",
  location: "text",
  education: "text",
  radio_group: "choice",
  checkbox_group: "multi_choice",
  unsupported: "other",
};
const SETTLE_MS = 250;
/** Waits for a late-rendering application form before the run reports none (about 10 s at most). */
const FORM_POLLS = 40;
/** Control kinds written once more after the settle wait; choices are not clicked twice. */
const REWRITABLE = new Set(["text", "textarea", "file", "select"]);

const cssOf = (id: string) => ({ css: `[id="${id.replace(/["\\]/g, "\\$&")}"]` });

/** Puts one planned value into its control, through the guarded session helpers only. */
async function apply(
  session: DryRunSession,
  c: DomControl,
  value: string | string[],
  again = false,
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
      // The second attempt goes through the page's own file chooser, like a user's picker (a widget may drop the first).
      return again
        ? session.uploadViaChooser(cssOf(c.id), first)
        : session.upload(cssOf(c.id), first);
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
    case "location": // never typed into: a typed location is not a picked suggestion
    case "education": // the owner's to fill
    case "unsupported":
      throw new HarnessRefusalError("refused: unsupported control");
  }
}

/** True when what the page kept equals what was planned (texts exactly, choices and files by normalized label). */
function kept(c: DomControl, value: string | string[], got: readonly string[]): boolean {
  return readbackEqual(c.kind, value, got);
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
    ...(embeddedFormUrl(opts.url) !== null
      ? { fallbackUrl: embeddedFormUrl(opts.url) as string }
      : {}),
    ...(opts.headless !== undefined ? { headless: opts.headless } : {}),
    ...(opts.starter !== undefined ? { starter: opts.starter } : {}),
  });
  const done = async (
    result: Parameters<DryRunSession["finish"]>[0],
    filled = 0,
    total = 0,
  ): Promise<GreenhouseRunSummary> => {
    const run = await session.finish(result);
    // A challenge that appeared mid-run stops the run: nothing counts as filled.
    return session.stop ? { ...run, filled: 0, total: 0 } : { ...run, filled, total };
  };
  try {
    if (session.stop) return await done(undefined);

    const context = opts.context ?? loadFillContext(opts.db, opts.postingId);
    let controls = await readControls(session, stored);
    // The page renders its form after the load event: wait for it before concluding there is none.
    for (let i = 0; controls === null && i < FORM_POLLS; i++) {
      await session.settle(SETTLE_MS);
      if (session.stop) return await done(undefined);
      controls = await readControls(session, stored);
    }
    if (controls === null) {
      // A closed posting has no form at all: say so instead of reporting a changed form.
      if (await session.snapshot<boolean>(READ_CLOSED_EXPRESSION))
        return await done({
          status: "stopped",
          stop_reason: "page_error",
          stop_detail: "posting closed: the page has no application form",
        });
      return await done({
        status: "stopped",
        stop_reason: "form_changed",
        stop_detail: "application form not found",
      });
    }
    // A Cover Letter file upload with an "Enter manually" option: open the text option (its textarea only exists
    // afterwards) and read the form again; the plan then fills it, or notes an unapproved or missing text.
    const coverFile = stored.find((f) => f.ats.id === COVER_FILE_ID && f.field_type === "file");
    if (coverFile !== undefined && !controls.some((c) => c.id === COVER_TEXT_ID)) {
      if (await session.revealCoverLetterText()) {
        await session.settle(SETTLE_MS);
        if (session.stop) return await done(undefined);
        controls = (await readControls(session, stored)) ?? controls;
      }
    }
    // The manual textarea stands for the stored cover letter file question (it is not a stored question of its own).
    const coverText =
      coverFile === undefined
        ? undefined
        : controls.find((c) => c.id === COVER_TEXT_ID && c.kind === "textarea");
    const comparison = compareForm(
      stored,
      coverText === undefined ? controls : controls.filter((c) => c !== coverText),
    );
    // Extra page questions are new, unmatched questions (listed below as needing input); only a stored question that is
    // missing from the page or of another kind / options means the form changed.
    if (comparison.missing.length > 0 || comparison.different.length > 0)
      return await done({
        status: "stopped",
        stop_reason: "form_changed",
        stop_detail: describeComparison(comparison),
      });

    // The location autocomplete is the stored Location question. It is never typed into (a typed location is not kept
    // and a suggestion is the owner's pick): it stays out of the plan and is recorded as not filled with a fixed note.
    const location = pairLocation(stored, controls);
    const locationField = stored.find((f) => f.ats.id === location?.storedId);
    const fillable = controls.filter((c) => c.kind !== "location" && c.kind !== "education");
    const byId = new Map(fillable.map((c) => [c.id, c]));
    const order = new Map(fillable.map((c, i) => [c.id, i]));
    const fields = stored
      .filter((f) => f.ats.id !== location?.storedId)
      // The cover letter file question becomes a long text field on its manual textarea.
      .map((f) =>
        coverText !== undefined && f === coverFile
          ? { ...f, field_type: "long_text", ats: { ...f.ats, id: COVER_TEXT_ID } }
          : f,
      )
      .sort((a, b) => (order.get(a.ats.id) ?? 0) - (order.get(b.ats.id) ?? 0));
    const plan = planFill({
      fields,
      ...context,
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
      if (session.stop) break; // a CAPTCHA challenge appeared: no further field is filled
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
    // The location autocomplete: type the approved location, pick the one matching suggestion (none / several: stays open).
    let locationRow: DryRunFieldInput | undefined;
    if (locationField !== undefined && location !== null && !session.stop) {
      const answer = approvedLocation(context.answers);
      let result: SuggestionResult = { picked: false, reason: "noAnswer" };
      if (answer !== null) {
        try {
          result = await session.pickSuggestion(cssOf(location.domId), answer);
        } catch {
          // Playwright messages quote what was typed: only the fixed wording is kept.
          result = { picked: false, reason: "refused" };
        }
      }
      locationRow = autocompleteRow(locationField, result);
    }
    if (session.stop) return await done(undefined);
    const readValues = () =>
      session.snapshot<Record<string, string[]>>(readValuesExpression(fillable));
    // A page may re-render a field after the write (blanking it, or putting the value back): wait for the settled value,
    // then write a still-missing text, file or select value once more. A value the page really refuses stays refused.
    const pending = (seen: Record<string, string[]>) =>
      plan.fields.filter(
        (p) =>
          p.filled &&
          !refused.has(p.field.ats.id) &&
          !kept(byId.get(p.field.ats.id) as DomControl, p.value, seen[p.field.ats.id] ?? []),
      );
    // One settle wait always comes before the first trusted read: a re-render queued by the write has not run yet.
    await session.settle(SETTLE_MS);
    if (session.stop) return await done(undefined);
    let got = await readValues();
    // Polls until nothing is pending (a pending file waits longer), at most the limit.
    const pollPending = async () => {
      for (let i = 0; !session.stop; i++) {
        const waiting = pending(got);
        const limit = waiting.some((p) => byId.get(p.field.ats.id)?.kind === "file")
          ? UPLOAD_SETTLE_POLLS
          : SETTLE_POLLS;
        if (waiting.length === 0 || i >= limit) break;
        await session.settle(SETTLE_MS);
        if (!session.stop) got = await readValues();
      }
    };
    await pollPending();
    const rewrite = session.stop
      ? []
      : pending(got).filter((p) => REWRITABLE.has((byId.get(p.field.ats.id) as DomControl).kind));
    for (const p of rewrite) {
      if (session.stop || !p.filled) break;
      try {
        await apply(session, byId.get(p.field.ats.id) as DomControl, p.value, true);
      } catch (err) {
        // A file whose input is gone or whose chooser never opens may still be kept by the page (a late upload-complete
        // line): the readback after the second wait decides, not the failed second attempt.
        if (byId.get(p.field.ats.id)?.kind === "file") continue;
        refused.set(
          p.field.ats.id,
          err instanceof HarnessRefusalError ? err.message.slice(0, 200) : "page refused the value",
        );
      }
    }
    if (rewrite.length > 0 && !session.stop) {
      await session.settle(SETTLE_MS);
      if (!session.stop) got = await readValues();
      await pollPending();
    }
    if (session.stop) return await done(undefined);
    const planned: DryRunFieldInput[] = plan.fields.map((p): DryRunFieldInput => {
      const base = {
        label: p.field.label,
        field_type: p.field.field_type,
        required: p.field.required,
        answer_key: p.answerKey,
      };
      if (!p.filled) return { ...base, source: "none", value: null, filled: false, note: p.detail };
      const id = p.field.ats.id;
      const control = byId.get(id) as DomControl;
      const raw =
        refused.get(id) ??
        (kept(control, p.value, got[id] ?? []) ? null : "page kept a different value");
      // A file the page does not keep (input swapped or cleared, upload never completes): name the upload as the cause.
      const why =
        raw === null
          ? null
          : control.kind === "file"
            ? UPLOAD_NOT_KEPT_NOTE
            : id === COVER_TEXT_ID
              ? COVER_TEXT_NOT_KEPT_NOTE
              : raw;
      return why === null
        ? { ...base, source: p.source, value: valueText(p), filled: true, note: null }
        : { ...base, source: p.source, value: null, filled: false, note: why };
    });
    // The education block (School, Degree, Discipline, dates) is the owner's to fill: a required control is listed as
    // needing input, an optional one is skipped. Never typed into, never a form change.
    const educationRows = controls
      .filter((c) => c.kind === "education" && c.required === true && c.label !== "")
      .map((c): DryRunFieldInput => ({
        label: c.label,
        field_type: "text",
        required: true,
        answer_key: null,
        source: "none",
        value: null,
        filled: false,
        note: "education block: the owner fills it",
      }));
    // Page questions no stored question explains (e.g. optional demographic ones): never typed into, listed as needing input.
    const extraRows = extraControls(
      stored,
      coverText === undefined ? controls : controls.filter((c) => c !== coverText),
    ).map((c): DryRunFieldInput => ({
      label: c.label || c.id,
      field_type: EXTRA_FIELD_TYPE[c.kind],
      required: c.required === true,
      answer_key: null,
      source: "none",
      value: null,
      filled: false,
      note: EXTRA_QUESTION_NOTE,
    }));
    const rows: DryRunFieldInput[] = [
      ...planned,
      ...extraRows,
      ...(locationRow === undefined ? [] : [locationRow]),
      ...educationRows,
    ];

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
