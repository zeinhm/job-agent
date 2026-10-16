import { join } from "node:path";
import { apply_links, postings, type Db } from "@job-agent/core";
import {
  BrowserMissingError,
  FIXTURE_FORM_PATH,
  HarnessRefusalError,
  LEVER_FIXTURE_FORM_PATH,
  dataDirOfDb,
  fixtureContext,
  loadFillContext,
  leverFixtureContext,
  loadStoredQuestions,
  runGreenhouseDryRun,
  runLeverDryRun,
  seedGreenhouseFixture,
  seedLeverFixture,
  startGreenhouseFixtureServer,
  startLeverFixtureServer,
  type GreenhouseRunSummary,
  type LeverRunSummary,
} from "@job-agent/apply";
import { eq } from "drizzle-orm";
import { atsLinkOf, type AtsLink } from "./apply-links/ats-links.ts";

export const DRY_RUN_USAGE =
  "Usage: job-agent dry-run <posting-id> [--headless]\n       job-agent dry-run --fixture greenhouse|lever\n";

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
}

/** The hosted job-boards URL of a Greenhouse job link, or null when board slug or job id is missing. */
export function formUrl(link: AtsLink, storedSlug: string | null): string | null {
  const slug = link.slug !== "" ? link.slug : (storedSlug ?? "");
  const u = new URL(link.url);
  const seg = u.pathname.split("/").filter((s) => s !== "");
  const at = seg.indexOf("jobs");
  const jobId = at >= 0 ? (seg[at + 1] ?? "") : (u.searchParams.get("gh_jid") ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) || !/^\d+$/.test(jobId)) return null;
  const host = u.hostname.includes(".eu.")
    ? "job-boards.eu.greenhouse.io"
    : "job-boards.greenhouse.io";
  return `https://${host}/${slug}/jobs/${jobId}`;
}

/** The hosted apply URL of a Lever job link, or null when the company or the posting id is missing. */
export function leverFormUrl(link: AtsLink): string | null {
  const u = new URL(link.url);
  const seg = u.pathname.split("/").filter((s) => s !== "");
  const id = seg[1] ?? "";
  if (link.slug === "" || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(id)) return null;
  return `https://${u.hostname}/${link.slug}/${id}/apply`;
}

function summaryLine(s: GreenhouseRunSummary | LeverRunSummary, dataDir: string): string {
  return `dry-run: status=${s.status} reason=${s.stopReason ?? "-"} fields=${s.filled}/${s.total} screenshot=${join(dataDir, s.screenshotPath)}\n`;
}

/** Never prints a value: only our own fixed refusal wordings reach the terminal. */
function describeError(e: unknown): string {
  if (e instanceof BrowserMissingError || e instanceof HarnessRefusalError) return e.message;
  return `unexpected ${e instanceof Error ? e.name : "error"} (nothing was submitted)`;
}

/**
 * `dry-run <posting-id> [--headless]`: fills the posting's Greenhouse or Lever form (headed unless --headless), screenshots it
 * and records the run. Never submits. `dry-run --fixture greenhouse|lever`: the same on the committed fixture form served
 * from 127.0.0.1 with a fake persona; refused on the real database. Returns the exit code.
 */
export async function runDryRun(opts: DryRunCommandOptions): Promise<number> {
  const { db, out, err } = opts;
  const refuse = (reason: string): number => {
    err(`dry-run: refused: ${reason}\n`);
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
    if ((values.fixture !== "greenhouse" && values.fixture !== "lever") || positionals.length > 0) {
      err(DRY_RUN_USAGE);
      return 1;
    }
    if (opts.isRealDb)
      return refuse("--fixture never runs on the real database (use bin/smoke run <dir> ...)");
    if (dataDir === null) return refuse("a dry run needs a DB file");
    const lever = values.fixture === "lever";
    const postingId = lever ? seedLeverFixture(db) : seedGreenhouseFixture(db);
    const server = lever ? await startLeverFixtureServer() : await startGreenhouseFixtureServer();
    try {
      const summary = lever
        ? await runLeverDryRun({
            db,
            dataDir,
            postingId,
            url: `${server.origin}${LEVER_FIXTURE_FORM_PATH}`,
            fixture: true,
            context: leverFixtureContext(dataDir),
          })
        : await runGreenhouseDryRun({
            db,
            dataDir,
            postingId,
            url: `${server.origin}${FIXTURE_FORM_PATH}`,
            fixture: true,
            context: fixtureContext(dataDir),
          });
      out(summaryLine(summary, dataDir));
      return summary.status === "error" ? 1 : 0;
    } catch (e) {
      err(`dry-run: ${describeError(e)}\n`);
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
      "a real form is only opened with the real database (agents use --fixture greenhouse|lever)",
    );
  if (dataDir === null) return refuse("a dry run needs a DB file");
  const posting = db.select().from(postings).where(eq(postings.id, postingId)).get();
  if (posting === undefined) return refuse(`no posting ${postingId}`);
  const link = db.select().from(apply_links).where(eq(apply_links.posting_id, postingId)).get();
  const parsedLink = atsLinkOf(link?.apply_url ?? posting.apply_url ?? posting.url);
  if (
    parsedLink === null ||
    (parsedLink.vendor !== "greenhouse" && parsedLink.vendor !== "lever") ||
    parsedLink.kind !== "job"
  )
    return refuse("the posting's apply link is not a Greenhouse or Lever job link");
  const lever = parsedLink.vendor === "lever";
  const url = lever ? leverFormUrl(parsedLink) : formUrl(parsedLink, link?.ats_slug ?? null);
  if (url === null)
    return refuse(
      lever
        ? "the Lever company or posting id is missing from the apply link"
        : "the Greenhouse board or job id is missing from the apply link",
    );
  if (loadFillContext(db, postingId).scamFlagged) return refuse("the posting is scam-flagged");
  // Greenhouse questions come from fetch-questions; Lever has no questions API, the run stores what its page shows.
  if (!lever && loadStoredQuestions(db, postingId).length === 0)
    return refuse("the posting has no stored Greenhouse questions (run fetch-questions)");

  try {
    const run = lever ? runLeverDryRun : runGreenhouseDryRun;
    const summary = await run({
      db,
      dataDir,
      postingId,
      url,
      fixture: false,
      headless: values.headless,
    });
    out(summaryLine(summary, dataDir));
    return summary.status === "error" ? 1 : 0;
  } catch (e) {
    err(`dry-run: ${describeError(e)}\n`);
    return 1;
  }
}
