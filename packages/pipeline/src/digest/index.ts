import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, gte, inArray, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import {
  analysis,
  apply_links,
  effectiveCapUsd,
  intel,
  log,
  postings,
  source_runs,
  type Db,
  type Intel,
} from "@job-agent/core";
import { classifyLanguage } from "../filters/language.ts";
import { classifyRole } from "../filters/role.ts";
import { SALARY_BELOW_FLOOR_REASON } from "../filters/salary-floor.ts";
import { ExtractionSchema } from "../intel/extract.ts";
import { failedFitRuns, MAX_FIT_ATTEMPTS } from "../intel/fit.ts";
import { resolveFlags, UNPAID_REASON } from "../intel/resolve.ts";
import { TIER_SKIPPED_NO_FX } from "../intel/tier.ts";
import { formatSalary, isAtsSource, parseList } from "./format.ts";
import { capText, compressZones, groupPostings, joinLocations } from "./group.ts";
import { compareRanked, rankScore, TOP_MATCH_MIN_FIT } from "./rank.ts";
import { spendSection } from "./spend.ts";
import { hoursLine } from "./why.ts";

export { formatSalary } from "./format.ts";

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
  out: (text: string) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Date as YYYY-MM-DD in Asia/Jakarta. */
export function jakartaDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(now);
}

export function isDigestDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
}

type Kind = "top" | "not_a_fit" | "waiting" | "suspicious";

interface Entry {
  kind: Kind;
  title: string;
  company: string;
  line: string[];
  postedAt: string | null;
  rank: number;
  /** Fit score, set for `not_a_fit` entries. */
  fit?: number;
  /** Unclear flags still open, for the "Needs a look" section. */
  unclear: string[];
}

type Row = {
  p: typeof postings.$inferSelect;
  a: typeof analysis.$inferSelect;
  i: Intel | null;
};

const UNCLEAR_FLAGS = ["location_unclear", "indonesia_unclear", "role_unclear"];
const MAX_REASONS = 3;
const PAID_ONLY_LABEL = "(paid-only apply)";

/** Unclear flags the resolve stage could not settle; all of them when there is no usable extraction. */
function remainingUnclear(flags: string[], i: Intel | null): string[] {
  const present = flags.filter((f) => UNCLEAR_FLAGS.includes(f));
  if (i?.extraction == null) return present;
  try {
    const parsed = ExtractionSchema.safeParse(JSON.parse(i.extraction));
    if (!parsed.success) return present;
    return resolveFlags({ ruleDecision: "keep", flags, extraction: parsed.data }).remainingFlags;
  } catch {
    return present;
  }
}

function askLabel(i: Intel): string | null {
  const parts: string[] = [];
  if (i.ask_idr_month !== null) {
    parts.push(
      formatSalary({
        status: "listed",
        idrMonthMin: i.ask_idr_month,
        idrMonthMax: i.ask_idr_month,
      }),
    );
  }
  if (i.ask_usd_year !== null) parts.push(`USD ${i.ask_usd_year.toLocaleString("en-US")} / year`);
  if (i.ask_text !== null && i.ask_text.trim() !== "")
    parts.push(`text answer: ${i.ask_text.trim()}`);
  return parts.length > 0 ? parts.join(" | ") : null;
}

/** A kept posting that has no tier only because no IDR rate was stored (waiting state or legacy `done` row). */
function tierMissingForFx(i: Intel): boolean {
  return (
    i.status === "fx_wait" ||
    (i.tier === null && parseList(i.resolved_reasons).includes(TIER_SKIPPED_NO_FX))
  );
}

/** A failed fit shows its short cause and whether the next run tries again; other failures point to the database. */
function failedText(i: Intel): string {
  const runs = failedFitRuns(i.resolved_reasons);
  if (runs === 0) return "scoring failed, see `resolved_reasons` in the database";
  if (runs >= MAX_FIT_ATTEMPTS) return `scoring failed ${MAX_FIT_ATTEMPTS} times`;
  const cause = parseList(i.resolved_reasons).find(
    (r) => r.startsWith("fit ") && !r.startsWith("fit_attempt"),
  );
  const short = cause === undefined ? "unknown" : cause.slice("fit ".length);
  return `scoring failed (${short}), retried next run`;
}

/** Why a kept posting has no fit score yet, in plain words. */
function waitingReason(i: Intel | null): string {
  if (i?.status === "done" && i.final_decision === "keep" && i.fit_score !== null)
    return "scored, but no ask decided yet";
  if (i === null) return "not enriched yet";
  if (i.status === "budget_wait") return "waiting for the daily LLM budget";
  if (tierMissingForFx(i)) return "waiting for an FX rate: run fx";
  if (i.status === "failed") return failedText(i);
  if (i.status === "pending") return "not enriched yet";
  return "no fit score (no CV configured or fit not run)";
}

const EMPLOYMENT_LABELS: Record<string, string> = {
  employee: "employee",
  contractor: "contractor",
  eor: "EOR",
};

/** Employment type from the stored extraction; "unknown" when null, missing or unreadable. */
function employmentLabel(extraction: string | null): string {
  if (extraction == null) return "unknown";
  try {
    const e: unknown = (JSON.parse(extraction) as { employment?: unknown } | null)?.employment;
    return (typeof e === "string" && EMPLOYMENT_LABELS[e]) || "unknown";
  } catch {
    return "unknown";
  }
}

const isScored = (r: Row) =>
  r.i !== null && r.i.status === "done" && r.i.final_decision === "keep" && r.i.fit_score !== null;

/**
 * The one member whose posting, analysis and intel the entry shows, so title, link, salary, fit,
 * scam score and why never mix members. A suspicious member wins (scam conventions: such a group
 * is never Top), then a scored member with an ask, then any scored member, then any member with
 * intel, then the group's best member.
 */
function pickLead(group: Row[]): Row {
  return (
    group.find((r) => r.i?.final_decision === "suspicious") ??
    group.find((r) => isScored(r) && r.i !== null && askLabel(r.i) !== null) ??
    group.find(isScored) ??
    group.find((r) => r.i !== null) ??
    (group[0] as Row)
  );
}

/**
 * HN first lines are free text, so the stored title can be a location or a link; for source `hn` the extracted
 * role title wins when there is one. ATS and board titles are authoritative and stay. `postings.title` is not rewritten.
 */
function displayTitle(p: Row["p"], i: Intel | null): string {
  if (p.source !== "hn" || i?.extraction == null) return p.title;
  try {
    const parsed = ExtractionSchema.safeParse(JSON.parse(i.extraction));
    const roleTitle = parsed.success ? parsed.data.roleTitle?.trim() : undefined;
    return roleTitle ? roleTitle : p.title;
  } catch {
    return p.title;
  }
}

/** One entry for a group of same company + title postings; sources and locations span the group. */
function buildEntry(db: Db, group: Row[]): Entry | null {
  const lead = pickLead(group);
  const { p, a, i } = lead;
  if (i?.final_decision === "reject") return null;

  const title = displayTitle(p, i);
  const flags = [...new Set(group.flatMap((r) => parseList(r.a.flags)))];
  const unclear = remainingUnclear(flags, i);
  // Settled unclear flags are dropped; rule flags that are not unclear flags stay.
  const openFlags = flags.filter((f) => !UNCLEAR_FLAGS.includes(f) || unclear.includes(f));
  const sources: string[] = [];
  for (const r of group) {
    const dups = db
      .select({ source: postings.source })
      .from(postings)
      .where(eq(postings.canonical_posting_id, r.p.id))
      .all()
      .map((d) => d.source);
    for (const s of [r.p.source, ...[...new Set(dups)].sort()]) {
      if (!sources.includes(s)) sources.push(s);
    }
  }
  const link = isAtsSource(p.source) ? (p.apply_url ?? p.url) : p.url;
  // Apply route of the same lead member as the rest of the block; the unresolved fallback is the old link.
  const resolved = db.select().from(apply_links).where(eq(apply_links.posting_id, p.id)).get();
  const applyUrl = resolved?.apply_url ?? link;
  const paidOnly = resolved?.apply_type === "paid_aggregator";
  const applyLine = `- Apply: ${applyUrl} (${resolved === undefined ? "unknown, not resolved yet" : resolved.apply_type})`;
  const foundOnLine = `- Found on: ${resolved?.found_on ?? p.source} — ${p.url}`;
  const locations = joinLocations(group.map((r) => r.p.location_text));
  const location = capText(
    compressZones([a.location_class, locations].filter((x) => x).join(" — ")),
  );
  const dates = group.map((r) => r.p.posted_at).filter((d): d is string => d !== null);
  const posted = dates.length > 0 ? dates.reduce((x, y) => (x > y ? x : y)) : null;
  const salary = formatSalary({
    status: a.salary_status,
    idrMonthMin: a.salary_idr_month_min,
    idrMonthMax: a.salary_idr_month_max,
  });
  const paidLabel = paidOnly ? ` ${PAID_ONLY_LABEL}` : "";
  const head = [`### ${title} — ${p.company_name}${paidLabel}`, ""];
  const common = [
    `- Location: ${location}`,
    `- Salary: ${salary}`,
    `- Flags: ${openFlags.length > 0 ? openFlags.join(", ") : "none"}`,
    applyLine,
    foundOnLine,
    `- Sources: ${sources.join(", ")}`,
    `- Posted: ${posted !== null ? posted.slice(0, 10) : "unknown"}`,
    "",
  ];
  const base = { title, company: p.company_name, postedAt: posted, unclear };

  if (i?.final_decision === "suspicious") {
    const reasons = parseList(i.scam_reasons).slice(0, MAX_REASONS);
    return {
      ...base,
      kind: "suspicious",
      rank: 0,
      line: [
        ...head,
        `- Scam score: ${i.scam_score ?? 0}`,
        ...reasons.map((r) => `- Reason: ${r}`),
        `- Link: ${link}`,
        `- Sources: ${sources.join(", ")}`,
        "",
      ],
    };
  }

  // A group (several postings) with no member that has an ask is not a Top match without one.
  const askless = group.length > 1 && i !== null && askLabel(i) === null;
  if (isScored(lead) && i !== null && i.fit_score !== null && !askless && !tierMissingForFx(i)) {
    const fitReasons = parseList(i.fit_reasons).slice(0, MAX_REASONS);
    const label = askLabel(i);
    const rank = rankScore({
      fitScore: i.fit_score,
      remainingUnclearFlags: unclear.length,
      listedMaxIdrMonth: a.salary_idr_month_max,
      askIdrMonth: i.ask_idr_month,
    });
    if (i.fit_score < TOP_MATCH_MIN_FIT) {
      const reason = fitReasons[0];
      return {
        ...base,
        kind: "not_a_fit",
        rank,
        fit: i.fit_score,
        line: [
          `- ${title} — ${p.company_name}${paidLabel} — fit ${i.fit_score}/100${reason !== undefined ? ` — ${reason}` : ""} — ${applyUrl}`,
        ],
      };
    }
    const scamReason = parseList(i.scam_reasons)[0];
    return {
      ...base,
      kind: "top",
      rank,
      line: [
        ...head,
        `- Fit: ${i.fit_score}/100 (rank ${rank})${fitReasons.length > 0 ? ` — ${fitReasons.join("; ")}` : ""}`,
        `- Type: ${employmentLabel(i.extraction)}`,
        `- Tier / ask: ${i.tier ?? "no tier"} — ${label ?? "no ask decided"}`,
        ...hoursLine(i.extraction),
        ...(i.scam_score !== null && i.scam_score > 0
          ? [`- Scam score: ${i.scam_score}${scamReason !== undefined ? ` — ${scamReason}` : ""}`]
          : []),
        ...common,
      ],
    };
  }

  return {
    ...base,
    kind: "waiting",
    rank: 0,
    line: [`- ${title} — ${p.company_name}${paidLabel} — ${waitingReason(i)} — ${applyUrl}`],
  };
}

/** posted_at descending, nulls last; ties by title then company so output is stable. */
function byPostedDesc(a: Entry, b: Entry): number {
  return (
    compareRanked({ rank: 0, postedAt: a.postedAt }, { rank: 0, postedAt: b.postedAt }) ||
    a.title.localeCompare(b.title) ||
    a.company.localeCompare(b.company)
  );
}

function byRank(a: Entry, b: Entry): number {
  return compareRanked(a, b) || byPostedDesc(a, b);
}

function section(heading: string, entries: Entry[], empty = "None."): string[] {
  return [
    `## ${heading}`,
    "",
    ...(entries.length === 0 ? [empty, ""] : entries.flatMap((e) => e.line)),
  ];
}

function needsALook(entries: Entry[]): string[] {
  const flagged = entries.filter((e) => e.unclear.length > 0);
  return [
    "## Needs a look",
    "",
    ...(flagged.length === 0
      ? ["None.", ""]
      : [...flagged.map((e) => `- ${e.title} — ${e.company}: ${e.unclear.join(", ")}`), ""]),
  ];
}

function sourceHealth(db: Db, now: Date): string[] {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const all = db.select().from(source_runs).all();
  const names = [...new Set(all.map((r) => r.source))].sort();
  const lines = ["## Source health", ""];
  if (names.length === 0) return [...lines, "No source runs recorded.", ""];
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
      if (latest.error_message !== null)
        text += `, ${latest.status === "error" ? "error" : "warning"}: ${latest.error_message.replace(/\s+/g, " ")}`;
    }
    lines.push(`- **${name}**: ${text}${noOk ? " — NO SUCCESSFUL RUN" : ""}`);
  }
  return [...lines, ""];
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

  const entries = db.transaction((tx) => {
    const t = tx as unknown as Db;
    const fresh = t
      .select({ id: analysis.id })
      .from(analysis)
      .innerJoin(postings, eq(postings.id, analysis.posting_id))
      .where(
        and(
          eq(analysis.decision, "keep"),
          isNull(analysis.digested_at),
          isNull(postings.canonical_posting_id),
        ),
      )
      .all()
      .map((r) => r.id);
    if (fresh.length > 0) {
      t.update(analysis).set({ digested_at: date }).where(inArray(analysis.id, fresh)).run();
    }
    // Today's stamped postings, plus earlier ones that have an intel row and are still unscored
    // or were scored today, so enrichment results are not stuck in the digest of the first day.
    // Earlier postings with no intel row at all are not re-sent (Phase 1 rule).
    const dayStart = new Date(`${date}T00:00:00+07:00`);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    const rows: Row[] = t
      .select({ p: postings, a: analysis, i: intel })
      .from(analysis)
      .innerJoin(postings, eq(postings.id, analysis.posting_id))
      .leftJoin(intel, eq(intel.posting_id, postings.id))
      .where(
        and(
          eq(analysis.decision, "keep"),
          isNull(postings.canonical_posting_id),
          or(
            eq(analysis.digested_at, date),
            and(
              lt(analysis.digested_at, date),
              isNotNull(intel.id),
              or(
                ne(intel.status, "done"),
                and(
                  gte(intel.updated_at, dayStart.toISOString()),
                  lt(intel.updated_at, dayEnd.toISOString()),
                ),
              ),
            ),
          ),
        ),
      )
      .all();
    const groups = groupPostings(
      rows.map((r) => ({
        row: r,
        id: r.p.id,
        title: r.p.title,
        company: r.p.company_name,
        isAts: isAtsSource(r.p.source),
        postedAt: r.p.posted_at,
      })),
    );
    return groups.flatMap((g) => {
      const e = buildEntry(
        t,
        g.map((x) => x.row),
      );
      return e === null ? [] : [e];
    });
  });

  const top = entries.filter((e) => e.kind === "top").sort(byRank);
  const notAFit = entries
    .filter((e) => e.kind === "not_a_fit")
    .sort(
      (a, b) =>
        compareRanked(
          { rank: a.fit ?? 0, postedAt: a.postedAt },
          { rank: b.fit ?? 0, postedAt: b.postedAt },
        ) || byPostedDesc(a, b),
    );
  const waiting = entries.filter((e) => e.kind === "waiting").sort(byPostedDesc);
  const suspicious = entries.filter((e) => e.kind === "suspicious").sort(byPostedDesc);
  const kept = top.length + notAFit.length + waiting.length;

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
    ...needsALook([...top, ...waiting]),
    ...section("Suspicious", suspicious),
    ...sourceHealth(db, now),
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
