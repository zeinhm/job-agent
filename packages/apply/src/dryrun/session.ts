import { randomUUID } from "node:crypto";
import { dry_runs, type Db, type DRY_RUN_STOP_REASONS } from "@job-agent/core";
import { eq } from "drizzle-orm";
import type { Browser, BrowserContext, Locator, Page } from "playwright";
import { launchChromium, newGuardedContext } from "./browser.ts";
import { detectCaptcha, detectStop, type PassiveCaptcha, type StopSignal } from "./detectors.ts";
import { finalizeScreenshot, writePendingScreenshot } from "./output.ts";
import { SUBMIT_ATTEMPT_KINDS, type PageAttempt } from "./page-guard.ts";
import type { AbortedRequest, GuardAts } from "./request-guard.ts";
import { recordDryRun, type DryRunFieldInput } from "../dry-runs-store.ts";
import { chooseSuggestion, type SuggestionResult } from "./autocomplete.ts";

export type FieldRef = { css: string } | { label: string };

export class HarnessRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessRefusalError";
  }
}

export interface DryRunSessionOptions {
  db: Db;
  /** Folder of the DB (see `dataDirOfDb`); output goes under `<dataDir>/dryruns/`. */
  dataDir: string;
  postingId: string;
  ats: GuardAts;
  /** The form page. Fixture mode: must be on 127.0.0.1. */
  url: string;
  /** Fixture mode (tests, `bin/smoke`): every host other than 127.0.0.1 is aborted too. */
  fixture: boolean;
  /** Default true; the owner-run CLI opens a visible window. */
  headless?: boolean;
  /**
   * CSS selector of an element that shows the form is rendered. For pages whose form arrives after `load` (Ashby, through
   * GraphQL): the session waits for it (at most the default timeout; a page that never shows it goes on without) before the
   * stop detectors look at the page.
   */
  ready?: string;
  /** Opened once when `url` redirects to another host (same guards and detectors); never tried after any other stop. */
  fallbackUrl?: string;
  /** Written with the run row (`started_by`, `operator_batch`); omitted for fixture runs. */
  starter?: { by: "owner" | "operator"; batch: string | null };
}

export interface DryRunResult {
  status: "filled" | "needs_input" | "stopped" | "error";
  stop_reason?: StopSignal["reason"] | null;
  stop_detail?: string | null;
  fields?: DryRunFieldInput[];
}

export interface FinishedRun {
  runId: string;
  status: DryRunResult["status"];
  stopReason: (typeof DRY_RUN_STOP_REASONS)[number] | null;
  screenshotPath: string;
  /** Method, host and path of every blocked request (never a body). */
  aborted: readonly AbortedRequest[];
  attempts: readonly PageAttempt[];
  /** Passive CAPTCHA signals seen during the run (labels only); the run went on with them present. */
  captchaPassive: readonly PassiveCaptcha[];
}

/** One run per process: no loop, retry or batch mode. */
let runStarted = false;

/** @internal test seam: the page behind a session, and the run limit reset. Not exported from the package index. */
export const internals = {
  pages: new WeakMap<DryRunSession, Page>(),
  resetRunLimit: () => {
    runStarted = false;
  },
};

const TEXT_INPUT_TYPES = new Set(["", "text", "email", "tel", "url", "number", "search", "date"]);
/** The suggestion items of the three ATS location widgets (react-select / listbox options, Lever's dropdown rows). */
const SUGGESTION_SELECTOR = "[role='option'], .dropdown-location";
/** `detectStop`'s wording for a redirect away from the requested host. */
const REDIRECT_DETAIL = "redirected to another host";
const SUGGESTION_WAIT_MS = 3_000;
const SUGGESTION_SETTLE_MS = 300;
const SUBMIT_LIKE =
  "button, [role='button'], [type='submit' i], input[type='image' i], input[type='button' i], input[type='reset' i]";

interface ElementFacts {
  tag: string;
  type: string;
  role: string;
  submitLike: boolean;
}

export class DryRunSession {
  /** Set when a detector stopped the run: at load (nothing filled) or after a fill (a challenge appeared mid-run). */
  get stop(): StopSignal | null {
    return this.#stop;
  }
  /** Passive CAPTCHA signals seen so far (dry-run rule, decisions.md 2026-10-17); they did not stop the run. */
  get captchaPassive(): readonly PassiveCaptcha[] {
    return [...this.#passive];
  }
  #stop: StopSignal | null;
  #passive: Set<PassiveCaptcha>;
  #seenUrls: readonly string[];
  // ES private fields: the page is not a property, so nothing can reach `session.page` and click.
  #opts: DryRunSessionOptions;
  #browser: Browser;
  #context: BrowserContext;
  #page: Page;
  #startedAt: Date;
  #finished = false;

  constructor(
    opts: DryRunSessionOptions,
    browser: Browser,
    context: BrowserContext,
    page: Page,
    startedAt: Date,
    /** Filled by the guards for the whole life of the session. */
    readonly aborted: AbortedRequest[],
    readonly attempts: PageAttempt[],
    stop: StopSignal | null,
    passive: readonly PassiveCaptcha[],
    seenUrls: readonly string[],
  ) {
    this.#opts = opts;
    this.#browser = browser;
    this.#context = context;
    this.#page = page;
    this.#startedAt = startedAt;
    this.#stop = stop;
    this.#passive = new Set(passive);
    this.#seenUrls = seenUrls;
    internals.pages.set(this, page);
  }

  /**
   * The CAPTCHA re-check of the dry-run rule: after every fill and before the screenshot. A challenge can appear when a
   * field changes (e.g. on a risk score); polling after each action needs no page-side code (a DOM-change hook would), so
   * the guards stay the only script the harness puts in the page. A visible challenge sets the stop: later helpers refuse
   * and `finish()` records `stopped` / `captcha`. Read-only, never touches a CAPTCHA.
   */
  private async recheck(): Promise<void> {
    if (this.#stop) return;
    try {
      const check = await detectCaptcha(this.#page, this.#seenUrls, "dry-run", "run");
      for (const label of check.passive) this.#passive.add(label);
      if (check.stop) this.#stop = check.stop;
    } catch {
      this.#stop = { reason: "page_error", detail: "page unreadable" };
    }
  }

  private async locate(ref: FieldRef): Promise<{ locator: Locator; facts: ElementFacts }> {
    if (this.stop)
      throw new HarnessRefusalError(`run is stopped (${this.stop.reason}): nothing is filled`);
    if (this.#finished) throw new HarnessRefusalError("run is finished");
    const locator =
      "css" in ref
        ? this.#page.locator(ref.css)
        : this.#page.getByLabel(ref.label, { exact: true });
    return { locator, facts: await this.inspect(locator) };
  }

  /** The one element behind `locator`, or a refusal when it is not exactly one or is (inside) a submit control. */
  private async inspect(locator: Locator): Promise<ElementFacts> {
    const count = await locator.count();
    if (count !== 1) throw new HarnessRefusalError(`expected exactly one element, found ${count}`);
    const facts = await locator.evaluate((el, submitLike): ElementFacts => {
      const attrs = [el.id, el.getAttribute("name") ?? "", el.getAttribute("data-qa") ?? ""].join(
        " ",
      );
      return {
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute("type") ?? "").toLowerCase(),
        role: (el.getAttribute("role") ?? "").toLowerCase(),
        submitLike: el.closest(submitLike) !== null || /submit/i.test(attrs),
      };
    }, SUBMIT_LIKE);
    if (facts.submitLike)
      throw new HarnessRefusalError("refused: element is, or sits inside, a submit control");
    return facts;
  }

  /**
   * Read-only snapshot: evaluates a fixed JS expression in the page and returns its JSON result. The fillers use it to
   * read the form's controls and the values the page kept. Refused after a stop, like every other helper.
   */
  async snapshot<T>(expression: string): Promise<T> {
    if (this.stop)
      throw new HarnessRefusalError(`run is stopped (${this.stop.reason}): nothing is read`);
    if (this.#finished) throw new HarnessRefusalError("run is finished");
    return this.#page.evaluate<T>(expression);
  }

  /** Waits `ms` for the page to settle (a late re-render), then re-checks for a CAPTCHA. Refused after a stop. */
  async settle(ms: number): Promise<void> {
    if (this.stop)
      throw new HarnessRefusalError(`run is stopped (${this.stop.reason}): nothing is read`);
    if (this.#finished) throw new HarnessRefusalError("run is finished");
    await this.#page.waitForTimeout(ms);
    await this.recheck();
  }

  /** Sets the value of a text-like input or textarea. */
  async fill(ref: FieldRef, value: string): Promise<void> {
    const { locator, facts } = await this.locate(ref);
    const ok =
      facts.tag === "textarea" || (facts.tag === "input" && TEXT_INPUT_TYPES.has(facts.type));
    if (!ok) throw new HarnessRefusalError(`refused: cannot fill a ${facts.tag}[${facts.type}]`);
    await locator.fill(value);
    await locator.blur();
    await this.recheck();
  }

  /** Picks an option of a `<select>` by value or visible label. */
  async select(ref: FieldRef, option: { value: string } | { label: string }): Promise<void> {
    const { locator, facts } = await this.locate(ref);
    if (facts.tag !== "select")
      throw new HarnessRefusalError(`refused: cannot select in a ${facts.tag}`);
    await locator.selectOption(option);
    await this.recheck();
  }

  /** Picks several options of a `<select multiple>` by visible label (the others are unselected). */
  async selectMany(ref: FieldRef, labels: readonly string[]): Promise<void> {
    const { locator, facts } = await this.locate(ref);
    const multiple =
      facts.tag === "select" && (await locator.evaluate((el) => el.hasAttribute("multiple")));
    if (!multiple) throw new HarnessRefusalError(`refused: ${facts.tag} is not a multi-select`);
    await locator.selectOption(labels.map((label) => ({ label })));
    await this.recheck();
  }

  /**
   * Picks options of a combobox (react-select style: click the input, click the `role=option` item with that exact
   * text). Each option must match exactly one element, and neither the combobox nor an option may be a submit control.
   */
  async choose(ref: FieldRef, labels: readonly string[]): Promise<void> {
    const { locator, facts } = await this.locate(ref);
    if (facts.role !== "combobox")
      throw new HarnessRefusalError(`refused: ${facts.tag} is not a combobox`);
    for (const label of labels) {
      await locator.click();
      const option = this.#page.getByRole("option", { name: label, exact: true });
      await this.inspect(option);
      await option.click();
    }
    await this.recheck();
  }

  /**
   * Location autocomplete: types the answer into the input, reads the suggestions the page shows and picks one only when
   * exactly one matches, or one is the exact match (`chooseSuggestion`). With none or several, or when the page does not keep the pick, the typed
   * text is cleared again and the field stays empty. A suggestion is a plain click on a `role=option` / `.dropdown-location`
   * element (never a submit control); the guards still abort every non-GET request the page sends meanwhile.
   */
  async pickSuggestion(ref: FieldRef, answer: string): Promise<SuggestionResult> {
    const { locator, facts } = await this.locate(ref);
    if (facts.tag !== "input" || !TEXT_INPUT_TYPES.has(facts.type))
      throw new HarnessRefusalError(`refused: cannot type into a ${facts.tag}[${facts.type}]`);
    const clear = async (): Promise<void> => {
      await locator.fill("");
      await locator.blur();
    };
    await locator.click();
    await locator.fill("");
    await locator.pressSequentially(answer, { delay: 20 });
    const options = this.#page.locator(SUGGESTION_SELECTOR);
    await options
      .first()
      .waitFor({ state: "visible", timeout: SUGGESTION_WAIT_MS })
      .catch(() => undefined);
    // The list refilters while the page answers: give it a moment to settle before reading.
    await this.#page.waitForTimeout(SUGGESTION_SETTLE_MS);
    const shown: { index: number; text: string }[] = [];
    const count = await options.count();
    for (let index = 0; index < count; index++) {
      const option = options.nth(index);
      if (!(await option.isVisible())) continue;
      shown.push({ index, text: ((await option.textContent()) ?? "").replace(/\s+/g, " ").trim() });
    }
    const choice = chooseSuggestion(
      answer,
      shown.map((s) => s.text),
    );
    if (!("index" in choice)) {
      await clear();
      await this.recheck();
      return { picked: false, reason: choice.reason };
    }
    const hit = shown[choice.index] as { index: number; text: string };
    const option = options.nth(hit.index);
    await this.inspect(option);
    await option.click();
    // The input shows the pick, or the widget shows it next to an emptied input (react-select).
    const keptPick =
      (await locator.inputValue()) !== "" ||
      (await locator.evaluate(
        (el, text) =>
          (
            el.closest(
              ".select__container, .location-widget, .application-field, [class*='combobox']",
            )?.textContent ?? ""
          ).includes(text),
        hit.text,
      ));
    if (!keptPick) await clear();
    await this.recheck();
    return keptPick ? { picked: true, text: hit.text } : { picked: false, reason: "notKept" };
  }

  /** Checks or unchecks a checkbox or radio. */
  async check(ref: FieldRef, checked = true): Promise<void> {
    const { locator, facts } = await this.locate(ref);
    if (facts.tag !== "input" || (facts.type !== "checkbox" && facts.type !== "radio")) {
      throw new HarnessRefusalError(`refused: cannot check a ${facts.tag}[${facts.type}]`);
    }
    await locator.setChecked(checked);
    await this.recheck();
  }

  /**
   * Opens the "Enter manually" text option of a Greenhouse file upload (the `cover_letter` upload only): the one
   * `button[type=button][data-testid=cover_letter-text]`. This is the only button the session ever clicks. It refuses a
   * button that is not an explicit `type=button`, that carries "submit" in its id / name / data-qa, or that sits inside
   * the submit area, and it returns false when the page has no such button. The guards still abort every non-GET request.
   */
  async revealCoverLetterText(): Promise<boolean> {
    if (this.stop)
      throw new HarnessRefusalError(`run is stopped (${this.stop.reason}): nothing is filled`);
    if (this.#finished) throw new HarnessRefusalError("run is finished");
    const button = this.#page.locator('button[data-testid="cover_letter-text"]');
    const count = await button.count();
    if (count === 0) return false;
    if (count !== 1) throw new HarnessRefusalError(`expected exactly one element, found ${count}`);
    const safe = await button.evaluate((el) => {
      const attrs = [el.id, el.getAttribute("name") ?? "", el.getAttribute("data-qa") ?? ""].join(
        " ",
      );
      return (
        el.getAttribute("type") === "button" &&
        !/submit/i.test(attrs) &&
        el.closest(".application--submit, [type='submit' i]") === null
      );
    });
    if (!safe)
      throw new HarnessRefusalError("refused: element is, or sits inside, a submit control");
    await button.click();
    await this.recheck();
    return true;
  }

  /** Attaches a local file to a file input. */
  async upload(ref: FieldRef, filePath: string): Promise<void> {
    const { locator, facts } = await this.locate(ref);
    if (facts.tag !== "input" || facts.type !== "file") {
      throw new HarnessRefusalError(`refused: cannot upload into a ${facts.tag}[${facts.type}]`);
    }
    await locator.setInputFiles(filePath);
    await this.recheck();
  }

  /**
   * Attaches a local file the way a user's file picker does: the input is clicked, the page's own file chooser opens and
   * the file is handed to it. For a widget that drops a programmatic attach (second attempt after `upload`).
   */
  async uploadViaChooser(ref: FieldRef, filePath: string): Promise<void> {
    const { locator, facts } = await this.locate(ref);
    if (facts.tag !== "input" || facts.type !== "file") {
      throw new HarnessRefusalError(`refused: cannot upload into a ${facts.tag}[${facts.type}]`);
    }
    const [chooser] = await Promise.all([
      this.#page.waitForEvent("filechooser", { timeout: 5_000 }),
      locator.evaluate((el) => (el as unknown as { click(): void }).click()),
    ]);
    await chooser.setFiles(filePath);
    await this.recheck();
  }

  /**
   * Takes the full-page screenshot, writes it and the run + fields through the D1 store, and closes the browser.
   * After a detector stop the run is recorded as stopped with no fields, whatever `result` says.
   * A "filled" run during which the page tried to submit is recorded as stopped (`blocked_request`).
   */
  async finish(result?: DryRunResult): Promise<FinishedRun> {
    if (this.#finished) throw new HarnessRefusalError("run is finished");
    this.#finished = true;
    try {
      await this.recheck();
      const png = await this.#page.screenshot({ fullPage: true });
      const day = this.#startedAt.toISOString().slice(0, 10);
      const pending = writePendingScreenshot(this.#opts.dataDir, day, randomUUID(), png);
      const resolved = this.resolve(result);
      const runId = recordDryRun(this.#opts.db, {
        posting_id: this.#opts.postingId,
        ats_type: this.#opts.ats,
        started_at: this.#startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        status: resolved.status,
        stop_reason: resolved.stopReason,
        stop_detail: resolved.stopDetail,
        screenshot_path: null,
        fixture: this.#opts.fixture,
        ...(this.#opts.starter !== undefined
          ? { started_by: this.#opts.starter.by, operator_batch: this.#opts.starter.batch }
          : {}),
        fields: resolved.fields,
      });
      const screenshotPath = finalizeScreenshot(this.#opts.dataDir, day, pending, runId);
      this.#opts.db
        .update(dry_runs)
        .set({ screenshot_path: screenshotPath })
        .where(eq(dry_runs.id, runId))
        .run();
      return {
        runId,
        status: resolved.status,
        stopReason: resolved.stopReason,
        screenshotPath,
        aborted: this.aborted,
        attempts: this.attempts,
        captchaPassive: this.captchaPassive,
      };
    } finally {
      await this.close();
    }
  }

  private resolve(result?: DryRunResult) {
    if (this.stop) {
      return {
        status: this.stop.reason === "page_error" ? ("error" as const) : ("stopped" as const),
        stopReason: this.stop.reason,
        stopDetail: this.stop.detail,
        fields: [] as DryRunFieldInput[],
      };
    }
    const given = result ?? { status: "needs_input" as const };
    if (given.status === "filled" && this.attempts.some((a) => SUBMIT_ATTEMPT_KINDS.has(a.kind))) {
      return {
        status: "stopped" as const,
        stopReason: "blocked_request" as const,
        stopDetail: this.withPassive("the page tried to submit; the attempt was blocked"),
        fields: given.fields ?? [],
      };
    }
    return {
      status: given.status,
      stopReason: given.stop_reason ?? null,
      stopDetail: this.withPassive(given.stop_detail ?? null),
      fields: given.fields ?? [],
    };
  }

  /** Adds `captcha=passive:<labels>` to a detail (labels only) when the run went on with a passive CAPTCHA present. */
  private withPassive(detail: string | null): string | null {
    if (this.#passive.size === 0) return detail;
    const note = `captcha=passive:${[...this.#passive].join(",")}`;
    return detail === null ? note : `${detail}; ${note}`.slice(0, 200);
  }

  /** Closes the browser without recording anything (error paths). Safe to call twice. */
  async close(): Promise<void> {
    this.#finished = true;
    await this.#context.close().catch(() => undefined);
    await this.#browser.close().catch(() => undefined);
  }
}

/**
 * Opens the form page in Chromium behind the guards and runs the stop detectors. A stop is kept on the session
 * (`session.stop`); fill helpers then refuse and `finish()` records it.
 */
export async function openDryRunSession(opts: DryRunSessionOptions): Promise<DryRunSession> {
  if (runStarted) throw new HarnessRefusalError("one dry run per process");
  runStarted = true;
  const aborted: AbortedRequest[] = [];
  const attempts: PageAttempt[] = [];
  const seenUrls: string[] = [];
  const startedAt = new Date();
  const browser = await launchChromium({ headless: opts.headless ?? true });
  try {
    const context = await newGuardedContext(
      browser,
      { ats: opts.ats, fixture: opts.fixture },
      { onAbort: (a) => aborted.push(a), onAttempt: (a) => attempts.push(a) },
    );
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on("request", (r) => seenUrls.push(r.url()));
    const open = async (
      url: string,
    ): Promise<{ stop: StopSignal | null; passive: PassiveCaptcha[] }> => {
      let mainStatus: number | null = null;
      try {
        const response = await page.goto(url, { waitUntil: "load" });
        mainStatus = response?.status() ?? null;
      } catch {
        mainStatus = null;
      }
      if (opts.ready !== undefined && mainStatus !== null && mainStatus < 400)
        await page.waitForSelector(opts.ready).catch(() => undefined);
      // The dry-run CAPTCHA rule (decisions.md 2026-10-17): a passive script or badge does not stop, a visible challenge does.
      return detectStop({
        page,
        requestedUrl: url,
        mainStatus,
        seenUrls,
        captchaMode: "dry-run",
      }).catch((): { stop: StopSignal; passive: PassiveCaptcha[] } => ({
        stop: { reason: "page_error", detail: "page unreadable" },
        passive: [],
      }));
    };
    let detected = await open(opts.url);
    // A board that sends its job page on to another host (a company career page): the same ATS's embedded application
    // form is opened once instead. A redirect from there to anywhere else still stops the run.
    if (opts.fallbackUrl !== undefined && detected.stop?.detail === REDIRECT_DETAIL)
      detected = await open(opts.fallbackUrl);
    const { stop, passive } = detected;
    return new DryRunSession(
      opts,
      browser,
      context,
      page,
      startedAt,
      aborted,
      attempts,
      stop,
      passive,
      seenUrls,
    );
  } catch (err) {
    await browser.close().catch(() => undefined);
    throw err;
  }
}
