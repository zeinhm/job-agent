import { join } from "node:path";
import { apply_links, companies, postings, type Db } from "@job-agent/core";
import {
  BATCH_ID,
  BrowserMissingError,
  FIXTURE_FORM_PATH,
  ASHBY_FIXTURE_FORM_PATH,
  LEVER_FIXTURE_FORM_PATH,
  acquireOwner,
  ashbyFixtureContext,
  batchState,
  pacingWaitSeconds,
  dataDirOfDb,
  errorLine,
  isDryRunCandidate,
  fixtureContext,
  loadFillContext,
  leverFixtureContext,
  loadStoredQuestions,
  ownerWaiting,
  refusalLine,
  runAshbyDryRun,
  runGreenhouseDryRun,
  runLeverDryRun,
  seedAshbyFixture,
  seedGreenhouseFixture,
  seedLeverFixture,
  startAshbyFixtureServer,
  startGreenhouseFixtureServer,
  sanitizeText,
  startLeverFixtureServer,
  tryAcquire,
  type AshbyRunSummary,
  type GreenhouseRunSummary,
  type LeverRunSummary,
  type LockOptions,
} from "@job-agent/apply";
import { eq } from "drizzle-orm";
import {
  atsLinkOf,
  effectiveApplyUrl,
  greenhouseJobIdOf,
  type AtsLink,
} from "./apply-links/ats-links.ts";

export const DRY_RUN_USAGE =
  "Usage: job-agent dry-run <posting-id> [--headless]\n       job-agent dry-run --fixture greenhouse|lever|ashby\n";

export interface DryRunCommandOptions {
  /** Arguments that are not flags: the posting id. */
  positionals: string[];
  /** `--fixture <name>` */
  fixture: string | undefined;
  /** `--headless` */
  headless: boolean;
  db: Db;
  /** Path of the DB file: its folder is the data dir (`dryruns/` lives there). */
  dbPath: string;
  /** True for the owner's real database (the default or one under `data/`); false for a scratch / smoke DB. */
  isRealDb: boolean;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Test seam for the lock's clock and waiting; empty in production. */
  lock?: LockOptions;
}

/** The hosted job-boards URL of a Greenhouse job link, or null when board slug or job id is missing. */
export function formUrl(link: AtsLink, storedSlug: string | null): string | null {
  const slug = link.slug !== "" ? link.slug : (storedSlug ?? "");
  const u = new URL(link.url);
  const jobId = greenhouseJobIdOf(link.url);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) || !/^\d+$/.test(jobId)) return null;
  const host = u.hostname.includes(".eu.")
    ? "job-boards.eu.greenhouse.io"
    : "job-boards.greenhouse.io";
  return `https://${host}/${slug}/jobs/${jobId}`;
}

/** The stored Greenhouse board of a posting: `apply_links.ats_slug`, then the company's Greenhouse board. */
export function storedGreenhouseSlug(
  db: Db,
  link: { ats_type: string | null; ats_slug: string | null } | null,
  companyId: string | null,
): string | null {
  if (link?.ats_slug && (link.ats_type === null || link.ats_type === "greenhouse")) {
    return link.ats_slug;
  }
  if (companyId === null) return null;
  const c = db.select().from(companies).where(eq(companies.id, companyId)).get();
  return c?.ats_type === "greenhouse" ? (c.ats_slug ?? null) : null;
}

/** The hosted apply URL of a Lever job link, or null when the company or the posting id is missing. */
export function leverFormUrl(link: AtsLink): string | null {
  const u = new URL(link.url);
  const seg = u.pathname.split("/").filter((s) => s !== "");
  const id = seg[1] ?? "";
  if (link.slug === "" || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(id)) return null;
  return `https://${u.hostname}/${link.slug}/${id}/apply`;
}

/** The hosted application URL of an Ashby job link, or null when the organization or the posting id is missing. */
export function ashbyFormUrl(link: AtsLink): string | null {
  const u = new URL(link.url);
  const seg = u.pathname.split("/").filter((s) => s !== "");
  const id = seg[1] ?? "";
  if (link.slug === "" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return null;
  return `https://${u.hostname}/${link.slug}/${id}/application`;
}

/**
 * The one summary line. `dataDir` is given only by the owner's own `dry-run` command (owner-only code path: the
 * screenshot path is printed); operator-facing callers pass `null` and the line carries no path at all.
 */
export function summaryLine(
  s: GreenhouseRunSummary | LeverRunSummary | AshbyRunSummary,
  dataDir: string | null,
): string {
  // `captcha=passive`: the run went on with a CAPTCHA script / badge / hidden widget on the page (labels in stop_detail).
  const captcha = s.captchaPassive.length > 0 ? " captcha=passive" : "";
  const shot = dataDir === null ? "" : ` screenshot=${join(dataDir, s.screenshotPath)}`;
  return `dry-run: status=${s.status} reason=${s.stopReason ?? "-"} fields=${s.filled}/${s.total}${captcha}${shot}\n`;
}

/**
 * What a thrown error prints: the fixed "browser missing" wording, otherwise `dry-run: error <Name> at <path>:<line>`.
 * Never a message (a Playwright error can quote a typed value) and never stack text.
 */
export function describeError(e: unknown): string {
  if (e instanceof BrowserMissingError) return `dry-run: ${e.message}\n`;
  return errorLine("dry-run", e);
}

/**
 * `dry-run <posting-id> [--headless]`: fills the posting's Greenhouse, Lever or Ashby form (headed unless --headless),
 * screenshots it and records the run. Never submits. `dry-run --fixture greenhouse|lever|ashby`: the same on the committed fixture form served
 * from 127.0.0.1 with a fake persona; refused on the real database. Returns the exit code.
 */
export async function runDryRun(opts: DryRunCommandOptions): Promise<number> {
  try {
    return await runDryRunUnguarded(opts);
  } catch (e) {
    // Anything the steps below did not handle (a stored row that fails its schema, a failed read, ...).
    opts.err(describeError(e));
    return 1;
  }
}

async function runDryRunUnguarded(opts: DryRunCommandOptions): Promise<number> {
  const { db, out, err } = opts;
  const refuse = (reason: string): number => {
    err(refusalLine("dry-run", reason));
    return 1;
  };
  const { positionals } = opts;
  const values = { headless: opts.headless, fixture: opts.fixture };
  const dataDir = (() => {
    try {
      return dataDirOfDb(opts.dbPath);
    } catch {
      return null;
    }
  })();

  if (values.fixture !== undefined) {
    if (
      (values.fixture !== "greenhouse" &&
        values.fixture !== "lever" &&
        values.fixture !== "ashby") ||
      positionals.length > 0
    ) {
      err(DRY_RUN_USAGE);
      return 1;
    }
    if (opts.isRealDb)
      return refuse("--fixture never runs on the real database (use bin/smoke run <dir> ...)");
    if (dataDir === null) return refuse("a dry run needs a DB file");
    const kind = values.fixture;
    const postingId =
      kind === "ashby"
        ? seedAshbyFixture(db)
        : kind === "lever"
          ? seedLeverFixture(db)
          : seedGreenhouseFixture(db);
    const server =
      kind === "ashby"
        ? await startAshbyFixtureServer()
        : kind === "lever"
          ? await startLeverFixtureServer()
          : await startGreenhouseFixtureServer();
    try {
      const base = { db, dataDir, postingId, fixture: true };
      const summary =
        kind === "ashby"
          ? await runAshbyDryRun({
              ...base,
              url: `${server.origin}${ASHBY_FIXTURE_FORM_PATH}`,
              context: ashbyFixtureContext(dataDir),
            })
          : kind === "lever"
            ? await runLeverDryRun({
                ...base,
                url: `${server.origin}${LEVER_FIXTURE_FORM_PATH}`,
                context: leverFixtureContext(dataDir),
              })
            : await runGreenhouseDryRun({
                ...base,
                url: `${server.origin}${FIXTURE_FORM_PATH}`,
                context: fixtureContext(dataDir),
              });
      out(summaryLine(summary, dataDir));
      return summary.status === "error" ? 1 : 0;
    } catch (e) {
      err(describeError(e));
      return 1;
    } finally {
      await server.close();
    }
  }

  const [postingId, ...extra] = positionals;
  if (postingId === undefined || postingId === "" || extra.length > 0) {
    err(DRY_RUN_USAGE);
    return 1;
  }
  // Agents only have scratch databases: a real employer form is opened only on the owner's real DB.
  if (!opts.isRealDb)
    return refuse(
      "a real form is only opened with the real database (agents use --fixture greenhouse|lever|ashby)",
    );
  if (dataDir === null) return refuse("a dry run needs a DB file");
  const prepared = prepareRealRun(db, postingId);
  if ("refusal" in prepared) return refuse(prepared.refusal);

  // The owner's run wins: it waits for the one form the operator is on, never for a whole batch.
  const lock = await acquireOwner(
    dataDir,
    () => out("dry-run: waiting for the operator's current form\n"),
    opts.lock,
  );
  if (!lock.ok) return refuse("another dry run is running");
  try {
    const summary = await runFiller(prepared, {
      db,
      dataDir,
      postingId,
      headless: values.headless,
      starter: { by: "owner", batch: null },
    });
    out(summaryLine(summary, dataDir));
    return summary.status === "error" ? 1 : 0;
  } catch (e) {
    err(describeError(e));
    return 1;
  } finally {
    lock.release();
  }
}

interface PreparedRun {
  vendor: "greenhouse" | "lever" | "ashby";
  url: string;
}

/**
 * What both real-form commands check before a form is opened: the posting, its Greenhouse / Lever / Ashby job link, the
 * form URL, the scam flag and (Greenhouse) the stored questions. A refusal is fixed text, never an id or a typed value.
 */
export function prepareRealRun(db: Db, postingId: string): PreparedRun | { refusal: string } {
  const posting = db.select().from(postings).where(eq(postings.id, postingId)).get();
  if (posting === undefined) return { refusal: `no posting ${postingId}` };
  const link = db.select().from(apply_links).where(eq(apply_links.posting_id, postingId)).get();
  const parsedLink = atsLinkOf(effectiveApplyUrl(link?.apply_url, posting.apply_url, posting.url));
  if (
    parsedLink === null ||
    (parsedLink.vendor !== "greenhouse" &&
      parsedLink.vendor !== "lever" &&
      parsedLink.vendor !== "ashby") ||
    parsedLink.kind !== "job"
  )
    return { refusal: "the posting's apply link is not a Greenhouse, Lever or Ashby job link" };
  const vendor = parsedLink.vendor;
  const url =
    vendor === "ashby"
      ? ashbyFormUrl(parsedLink)
      : vendor === "lever"
        ? leverFormUrl(parsedLink)
        : formUrl(parsedLink, storedGreenhouseSlug(db, link ?? null, posting.company_id));
  if (url === null)
    return {
      refusal:
        vendor === "ashby"
          ? "the Ashby organization or posting id is missing from the apply link"
          : vendor === "lever"
            ? "the Lever company or posting id is missing from the apply link"
            : "the Greenhouse board or job id is missing from the apply link",
    };
  if (loadFillContext(db, postingId).scamFlagged) return { refusal: "the posting is scam-flagged" };
  // Greenhouse questions come from fetch-questions; Lever and Ashby have no public questions endpoint, the run stores what its page shows.
  if (vendor === "greenhouse" && loadStoredQuestions(db, postingId).length === 0)
    return { refusal: "the posting has no stored Greenhouse questions (run fetch-questions)" };
  return { vendor, url };
}

/** The one filler path of `dry-run` and `operator-dry-run`. */
function runFiller(
  p: PreparedRun,
  o: {
    db: Db;
    dataDir: string;
    postingId: string;
    headless: boolean;
    starter: { by: "owner" | "operator"; batch: string | null };
  },
): Promise<GreenhouseRunSummary | LeverRunSummary | AshbyRunSummary> {
  const run =
    p.vendor === "ashby"
      ? runAshbyDryRun
      : p.vendor === "lever"
        ? runLeverDryRun
        : runGreenhouseDryRun;
  return run({ ...o, url: p.url, fixture: false });
}

/** The fixed, value-free code `operator-dry-run` prints on stdout with every refusal: `operator-dry-run: refused:<code>`. */
export type OperatorRefusalCode =
  | "not_real_db"
  | "no_db_file"
  | "owner_waiting"
  | "lock_held"
  | "batch_limit"
  | "daily_ceiling"
  | "unknown_posting"
  | "not_fillable";

export const OPERATOR_DRY_RUN_USAGE = "Usage: job-agent operator-dry-run <batch-id> <posting-id>\n";

export interface OperatorDryRunOptions {
  /** Arguments that are not flags: the batch id and the posting id. */
  positionals: string[];
  db: Db;
  dbPath: string;
  isRealDb: boolean;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Test seam for the lock's clock; empty in production. */
  lock?: LockOptions;
  /** Test seam for the pacing clock and gap; empty in production (real clock, random 60 to 120 s gap). */
  pacing?: { nowMs?: () => number; gapMs?: (prevRunId: string) => number };
}

/** Exit code of "the pacing gap has not passed": nothing was opened, `bin/operator run` sleeps and calls again. */
export const OPERATOR_WAIT_EXIT = 75;

/**
 * `operator-dry-run <batch-id> <posting-id>`: the agent-only twin of `dry-run` (same filler path, always headed: no flag
 * changes it, owner decision 4), real database only. The batch limits are enforced here, not by the role prompt: one form
 * at a time (the shared lock; an owner run that waits wins), at most the batch maximum of runs (a re-run counts), no run in
 * a batch that stopped on a CAPTCHA, and only a candidate posting. A refusal is one fixed line and exit 2; an unexpected
 * error is `operator-dry-run: error <Name> at <path>:<line>` and exit 1. Prints ids, enums and counts only.
 */
export async function runOperatorDryRun(opts: OperatorDryRunOptions): Promise<number> {
  try {
    return await runOperatorDryRunUnguarded(opts);
  } catch (e) {
    opts.err(errorLine("operator-dry-run", e));
    return 1;
  }
}

async function runOperatorDryRunUnguarded(opts: OperatorDryRunOptions): Promise<number> {
  const { db, out, err } = opts;
  // Every refusal also prints its fixed code on stdout: bin/operator drops stderr, so the code is all the operator sees.
  const refuse = (reason: string, code: OperatorRefusalCode): number => {
    err(refusalLine("operator-dry-run", reason));
    out(`operator-dry-run: refused:${code}\n`);
    return 2;
  };
  const [batchId, postingId, ...extra] = opts.positionals;
  if (
    batchId === undefined ||
    !BATCH_ID.test(batchId) ||
    postingId === undefined ||
    postingId === "" ||
    extra.length > 0
  ) {
    err(`operator-dry-run: refused: invalid arguments\n${OPERATOR_DRY_RUN_USAGE}`);
    out("operator-dry-run: refused:invalid_arguments\n");
    return 2;
  }
  if (!opts.isRealDb)
    return refuse("a real form is only opened with the real database", "not_real_db");
  let dataDir: string;
  try {
    dataDir = dataDirOfDb(opts.dbPath);
  } catch {
    return refuse("a dry run needs a DB file", "no_db_file");
  }
  if (ownerWaiting(dataDir, opts.lock)) return refuse("an owner run is waiting", "owner_waiting");
  const lock = tryAcquire(dataDir, "operator", opts.lock);
  if (!lock.ok) return refuse("a dry run is already running", "lock_held");
  try {
    // Counted under the lock, so two operator calls cannot both take the last place.
    const state = batchState(db, batchId);
    if (state.captchaHalt) {
      err("operator-dry-run: batch halted: captcha\n");
      out("operator-dry-run: refused:captcha_stop\n");
      return 2;
    }
    if (state.runs >= state.limit) return refuse("batch full", "batch_limit");
    if (state.dailyCeilingReached) return refuse("daily operator limit reached", "daily_ceiling");
    if (!isDryRunCandidate(db, postingId)) return refuse("not a candidate", "unknown_posting");
    const prepared = prepareRealRun(db, postingId);
    if ("refusal" in prepared) return refuse(prepared.refusal, "not_fillable");
    // Pacing comes last, so a refusal never makes the caller wait. Not a refusal: the lock is freed and the caller sleeps.
    const wait = pacingWaitSeconds(db, (opts.pacing?.nowMs ?? Date.now)(), opts.pacing?.gapMs);
    if (wait > 0) {
      err("operator-dry-run: waiting: the pacing gap has not passed\n");
      out(`operator-dry-run: waiting:${wait}\n`);
      return OPERATOR_WAIT_EXIT;
    }
    // The starter goes into the run's own insert: a run that throws afterwards is still counted.
    const summary = await runFiller(prepared, {
      db,
      dataDir,
      postingId,
      headless: false,
      starter: { by: "operator", batch: batchId },
    });
    out(operatorSummaryLine(summary, postingId, prepared.vendor));
    return summary.status === "error" ? 1 : 0;
  } finally {
    lock.release();
  }
}

/** The operator's summary line: run id, posting id, ATS, status, stop reason, filled / total. No value, no path. */
export function operatorSummaryLine(
  s: GreenhouseRunSummary | LeverRunSummary | AshbyRunSummary,
  postingId: string,
  ats: string,
): string {
  const captcha = s.captchaPassive.length > 0 ? " captcha=passive" : "";
  return `operator-dry-run: run=${sanitizeText(s.runId)} posting=${sanitizeText(postingId)} ats=${ats} status=${s.status} reason=${s.stopReason ?? "-"} fields=${s.filled}/${s.total}${captcha}\n`;
}
