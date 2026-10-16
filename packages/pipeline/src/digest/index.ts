import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, desc, eq, gte } from "drizzle-orm";
import {
  analysis,
  description_runs,
  effectiveCapUsd,
  intel,
  log,
  postings,
  source_runs,
  type Db,
  type Intel,
} from "@job-agent/core";
import { descriptionBackoffUntil } from "../description-state.ts";
import { classifyLanguage } from "../filters/language.ts";
import { classifyRole } from "../filters/role.ts";
import { SALARY_BELOW_FLOOR_REASON } from "../filters/salary-floor.ts";
import { UNPAID_REASON } from "../intel/resolve.ts";
import { reviewHistory } from "../review/record.ts";
import { reviewState } from "../review/state.ts";
import { freshnessSuffix, wibTime } from "./freshness.ts";
import { isAtsSource, parseList } from "./format.ts";
import {
  displayTitle,
  isDigestDate,
  jakartaDate,
  selectDay,
  type Entry,
  type Row,
} from "./selection.ts";
import { spendSection } from "./spend.ts";

export { formatSalary } from "./format.ts";
export { isDigestDate, jakartaDate } from "./selection.ts";

export interface DigestOptions {
  db: Db;
  /** YYYY-MM-DD, default today in Asia/Jakarta. */
  date?: string;
  /** Default `data/digests`. */
  outDir?: string;
  now?: () => Date;
  /** LLM cap shown in the spend section; default from `JOB_AGENT_LLM_CAP_USD` / the $1 hard cap. */
  capUsd?: number;
  /** Adds a "Volunteer / unpaid" section listing postings rejected as unpaid. Default off. */
  includeUnpaid?: boolean;
  /** Default-off sources that are not switched on; Source health shows them as "disabled", never skipped or LATE. */
  disabledSources?: readonly string[];
  /** Where the review line points; default the dashboard's default address. */
  dashboardUrl?: string;
  out: (text: string) => void;
}

const DEFAULT_DASHBOARD_URL = "http://127.0.0.1:4510/";

const DAY_MS = 24 * 60 * 60 * 1000;

function section(heading: string, entries: Entry[], empty = "None."): string[] {
  return [
    `## ${heading}`,
    "",
    ...(entries.length === 0 ? [empty, ""] : entries.flatMap((e) => e.line)),
  ];
}

function needsALook(flagged: Entry[]): string[] {
  return [
    "## Needs a look",
    "",
    ...(flagged.length === 0
      ? ["None.", ""]
      : [...flagged.map((e) => `- ${e.title} — ${e.company}: ${e.unclear.join(", ")}`), ""]),
  ];
}

/** ` (1 failed, 1 skipped)`, or an empty string when both are 0. */
function detailsCounts(failed: number, skipped: number): string {
  const parts = [
    ...(failed > 0 ? [`${failed} failed`] : []),
    ...(skipped > 0 ? [`${skipped} skipped`] : []),
  ];
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/** `details 7 (1 failed, 1 skipped)`: the detail requests of the source's latest fetch-descriptions run in the last 24h; undefined when none. */
function detailsText(db: Db, source: string, since: string, now: Date): string | undefined {
  const run = db
    .select()
    .from(description_runs)
    .where(and(eq(description_runs.source, source), gte(description_runs.started_at, since)))
    .orderBy(desc(description_runs.started_at))
    .limit(1)
    .get();
  if (run === undefined) return undefined;
  const backoff = descriptionBackoffUntil(db, now);
  return (
    `details ${run.requested}${detailsCounts(run.failed, run.skipped)}` +
    `${backoff ? `, details backoff until ${wibTime(backoff)}` : ""}`
  );
}

function sourceHealth(db: Db, now: Date, disabled: readonly string[] = []): string[] {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const all = db.select().from(source_runs).all();
  const names = [...new Set(all.map((r) => r.source))].filter((n) => !disabled.includes(n)).sort();
  const lines = ["## Source health", ""];
  const disabledLines = [...disabled].sort().map((n) => `- **${n}**: disabled`);
  if (names.length === 0 && disabledLines.length === 0)
    return [...lines, "No source runs recorded.", ""];
  for (const name of names) {
    const recent = all
      .filter((r) => r.source === name && r.started_at >= since && r.status !== "skipped")
      .sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0));
    const latest = recent[0];
    const noOk = !recent.some((r) => r.status === "ok");
    let text: string;
    if (latest === undefined) text = "no run in the last 24h";
    else {
      text = `${latest.status}, found ${latest.found}, new ${latest.new}`;
      const saturated = latest.saturated ?? recent.find((r) => r.saturated !== null)?.saturated;
      if (saturated !== null && saturated !== undefined) text += `, saturated ${saturated}`;
      const details = detailsText(db, name, since, now);
      if (details !== undefined) text += `, ${details}`;
      if (latest.error_message !== null)
        text += `, ${latest.status === "error" ? "error" : "warning"}: ${latest.error_message.replace(/\s+/g, " ")}`;
    }
    const fresh = freshnessSuffix(db, name, now);
    lines.push(
      `- **${name}**: ${text}${fresh !== undefined ? ` — ${fresh}` : ""}${noOk ? " — NO SUCCESSFUL RUN" : ""}`,
    );
  }
  return [...lines, ...disabledLines, ""];
}

/** Pay type from the stored extraction ("unpaid" or "equity_only"); "unpaid" when it cannot be read. */
function payTypeOf(i: Intel): string {
  if (i.extraction == null) return "unpaid";
  try {
    const v: unknown = (JSON.parse(i.extraction) as { payType?: unknown } | null)?.payType;
    return v === "equity_only" ? v : "unpaid";
  } catch {
    return "unpaid";
  }
}

/** Opt-in section: postings rejected as unpaid, volunteer or equity-only. Listed, never fit-scored. */
function unpaidSection(rows: { p: Row["p"]; i: Intel }[]): string[] {
  const lines = rows
    .filter((r) => r.p.canonical_posting_id === null)
    .sort(
      (a, b) =>
        (b.p.posted_at ?? "").localeCompare(a.p.posted_at ?? "") ||
        a.p.title.localeCompare(b.p.title) ||
        a.p.company_name.localeCompare(b.p.company_name),
    )
    .flatMap(({ p, i }) => [
      `### ${displayTitle(p, i)} — ${p.company_name}`,
      "",
      `- Pay type: ${payTypeOf(i)}`,
      `- Location: ${p.location_text ?? "unknown"}`,
      `- Link: ${isAtsSource(p.source) ? (p.apply_url ?? p.url) : p.url}`,
      `- Posted: ${p.posted_at !== null ? p.posted_at.slice(0, 10) : "unknown"}`,
      "",
    ]);
  return ["## Volunteer / unpaid", "", ...(lines.length === 0 ? ["None.", ""] : lines)];
}

/** Writes the digest for `date`, stamping newly kept postings with it. Returns the file path. */
export function runDigest(opts: DigestOptions): string {
  const { db, out } = opts;
  const now = (opts.now ?? (() => new Date()))();
  const date = opts.date ?? jakartaDate(now);
  if (!isDigestDate(date)) throw new Error(`Invalid date "${date}", expected YYYY-MM-DD`);

  const {
    top: allTop,
    notAFit,
    waiting,
    suspicious,
    needsALook: allFlagged,
  } = selectDay(db, date, {
    stamp: true,
  });

  // Postings the owner already processed (not `later`) leave Top matches and Needs a look.
  const dayIds = [...allTop, ...waiting, ...suspicious].map((e) => e.view.postingId);
  const history = reviewHistory(db, dayIds);
  const processedIds = new Set(dayIds.filter((id) => reviewState(history.get(id) ?? []).processed));
  const top = allTop.filter((e) => !processedIds.has(e.view.postingId));
  const flagged = allFlagged.filter((e) => !processedIds.has(e.view.postingId));
  const reviewLine =
    history.size === 0
      ? []
      : [
          `Reviewed: ${processedIds.size} processed, ${dayIds.length - processedIds.size} open — ${opts.dashboardUrl ?? DEFAULT_DASHBOARD_URL}`,
          "",
        ];
  const kept = allTop.length + notAFit.length + waiting.length;

  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const rejectedRows = db
    .select({ r: analysis, p: postings })
    .from(analysis)
    .innerJoin(postings, eq(postings.id, analysis.posting_id))
    .where(and(eq(analysis.decision, "reject"), gte(analysis.analyzed_at, since)))
    .all();
  const rejected = rejectedRows.map((x) => x.r);
  const byReason = { location: 0, indonesia: 0, role: 0, salary: 0, language: 0 };
  for (const { r, p } of rejectedRows) {
    if (classifyRole({ title: p.title, descriptionText: p.description_text }).class === "reject")
      byReason.role += 1;
    if (
      classifyLanguage({ title: p.title, descriptionText: p.description_text }).class === "reject"
    )
      byReason.language += 1;
    if (r.location_class === "restricted") byReason.location += 1;
    if (r.indonesia_rule === "domestic") byReason.indonesia += 1;
    if (parseList(r.reasons).includes(`salary: ${SALARY_BELOW_FLOOR_REASON}`)) byReason.salary += 1;
  }

  // Resolve-stage rejects are not in `analysis`: count the unpaid ones from intel.
  const unpaidRows = db
    .select({ p: postings, i: intel })
    .from(intel)
    .innerJoin(postings, eq(postings.id, intel.posting_id))
    .where(and(eq(intel.final_decision, "reject"), gte(intel.updated_at, since)))
    .all()
    .filter((x) => parseList(x.i.resolved_reasons).includes(UNPAID_REASON));
  const unpaidCount = unpaidRows.length;

  const body = [
    `# Job digest ${date}`,
    "",
    ...reviewLine,
    `- Top matches: ${top.length}`,
    `- Scored, not a fit: ${notAFit.length}`,
    `- Waiting for scoring: ${waiting.length}`,
    `- Suspicious: ${suspicious.length}`,
    `- Kept: ${kept}`,
    `- Rejected in the last 24h: ${rejected.length + unpaidCount} ` +
      `(location ${byReason.location}, indonesia ${byReason.indonesia}, role ${byReason.role}, salary ${byReason.salary}, language ${byReason.language}, unpaid ${unpaidCount})`,
    "",
    ...section("Top matches", top, "None scored yet."),
    "## Scored, not a fit",
    "",
    ...(notAFit.length === 0 ? ["None."] : notAFit.flatMap((e) => e.line)),
    "",
    ...section("Waiting for scoring", waiting),
    ...needsALook(flagged),
    ...section("Suspicious", suspicious),
    ...sourceHealth(db, now, opts.disabledSources),
    ...spendSection(db, date, opts.capUsd ?? effectiveCapUsd(process.env, (m) => log.warn(m))),
    ...(opts.includeUnpaid === true ? unpaidSection(unpaidRows) : []),
  ].join("\n");

  const dir = opts.outDir ?? join("data", "digests");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${date}.md`);
  writeFileSync(path, body);
  out(`${path}\n`);
  return path;
}
