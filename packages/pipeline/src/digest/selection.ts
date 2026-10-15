import { and, eq, gte, inArray, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import {
  analysis,
  apply_links,
  intel,
  postings,
  type ApplyLink,
  type Db,
  type Intel,
} from "@job-agent/core";
import { ExtractionSchema } from "../intel/extract.ts";
import { failedFitRuns, MAX_FIT_ATTEMPTS } from "../intel/fit.ts";
import { resolveFlags } from "../intel/resolve.ts";
import { TIER_SKIPPED_NO_FX } from "../intel/tier.ts";
import { formatSalary, isAtsSource, parseList } from "./format.ts";
import {
  capText,
  compressZones,
  distinctLocations,
  groupPostings,
  joinLocations,
} from "./group.ts";
import { compareRanked, rankScore, TOP_MATCH_MIN_FIT } from "./rank.ts";
import { hoursLine } from "./why.ts";

/**
 * The day's matches: which postings the digest for a date lists, in which section and rank.
 * Shared by the digest (markdown) and the dashboard API (JSON), so both always agree.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Date as YYYY-MM-DD in Asia/Jakarta. */
export function jakartaDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(now);
}

export function isDigestDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  try {
    return new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
  } catch {
    return false; // out-of-range month or day: Date is invalid and toISOString throws
  }
}

export type Kind = "top" | "not_a_fit" | "waiting" | "suspicious";

/** Structured facts of one posting entry, as the dashboard shows them. */
export interface PostingView {
  /** Canonical posting id of the entry's lead member. */
  postingId: string;
  /** Section the digest puts it in; `rejected` only for a posting looked up directly. */
  kind: Kind | "rejected";
  title: string;
  company: string;
  locations: string[];
  locationClass: string;
  fitScore: number | null;
  fitReasons: string[];
  flags: string[];
  tier: string | null;
  /** Ask label (IDR / USD / text answer), null when none is decided. */
  ask: string | null;
  askText: string | null;
  listedSalary: string;
  scamScore: number | null;
  scamReason: string | null;
  applyUrl: string;
  /** `unknown` when the apply link is not resolved yet. */
  applyType: string;
  postedAt: string | null;
  firstSeenAt: string;
  sources: string[];
}

export interface Entry {
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
  view: PostingView;
}

export type Row = {
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

/** Sources whose stored title is not a role title (free text or a placeholder). */
const ROLE_TITLE_SOURCES: readonly string[] = ["hn", "linkedin_posts"];

/**
 * HN first lines are free text, so the stored title can be a location or a link; for sources `hn` and `linkedin_posts` (title is a placeholder) the extracted
 * role title wins when there is one. ATS and board titles are authoritative and stay. `postings.title` is not rewritten.
 */
export function displayTitle(p: Row["p"], i: Intel | null): string {
  if (!ROLE_TITLE_SOURCES.includes(p.source) || i?.extraction == null) return p.title;
  try {
    const parsed = ExtractionSchema.safeParse(JSON.parse(i.extraction));
    const roleTitle = parsed.success ? parsed.data.roleTitle?.trim() : undefined;
    return roleTitle ? roleTitle : p.title;
  } catch {
    return p.title;
  }
}

/** Everything one entry shows, gathered once for a group of same company + title postings. */
interface Gathered {
  lead: Row;
  title: string;
  flags: string[];
  openFlags: string[];
  unclear: string[];
  sources: string[];
  link: string;
  resolved: ApplyLink | undefined;
  applyUrl: string;
  locationRaw: string[];
  location: string;
  posted: string | null;
  firstSeen: string;
  salary: string;
}

function gather(db: Db, group: Row[]): Gathered {
  const lead = pickLead(group);
  const { p, a, i } = lead;
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
  const locationTexts = group.map((r) => r.p.location_text);
  const location = capText(
    compressZones([a.location_class, joinLocations(locationTexts)].filter((x) => x).join(" — ")),
  );
  const dates = group.map((r) => r.p.posted_at).filter((d): d is string => d !== null);
  const posted = dates.length > 0 ? dates.reduce((x, y) => (x > y ? x : y)) : null;
  const firstSeen = group.map((r) => r.p.first_seen_at).reduce((x, y) => (x < y ? x : y));
  const salary = formatSalary({
    status: a.salary_status,
    idrMonthMin: a.salary_idr_month_min,
    idrMonthMax: a.salary_idr_month_max,
  });
  return {
    lead,
    title,
    flags,
    openFlags,
    unclear,
    sources,
    link,
    resolved,
    applyUrl,
    locationRaw: distinctLocations(locationTexts),
    location,
    posted,
    firstSeen,
    salary,
  };
}

function viewOf(g: Gathered, kind: PostingView["kind"]): PostingView {
  const { p, a, i } = g.lead;
  return {
    postingId: p.id,
    kind,
    title: g.title,
    company: p.company_name,
    locations: g.locationRaw,
    locationClass: a.location_class,
    fitScore: i?.fit_score ?? null,
    fitReasons: i === null ? [] : parseList(i.fit_reasons),
    flags: g.openFlags,
    tier: i?.tier ?? null,
    ask: i === null ? null : askLabel(i),
    askText: i?.ask_text ?? null,
    listedSalary: g.salary,
    scamScore: i?.scam_score ?? null,
    scamReason: i === null ? null : (parseList(i.scam_reasons)[0] ?? null),
    applyUrl: g.applyUrl,
    applyType: g.resolved?.apply_type ?? "unknown",
    postedAt: g.posted,
    firstSeenAt: g.firstSeen,
    sources: g.sources,
  };
}

/** One entry for a group of same company + title postings; sources and locations span the group. */
function buildEntry(db: Db, group: Row[]): Entry | null {
  const g = gather(db, group);
  const { p, i } = g.lead;
  if (i?.final_decision === "reject") return null;

  const { title, openFlags, unclear, sources, link, resolved, applyUrl, location, posted } = g;
  const paidOnly = resolved?.apply_type === "paid_aggregator";
  const applyLine = `- Apply: ${applyUrl} (${resolved === undefined ? "unknown, not resolved yet" : resolved.apply_type})`;
  const foundOnLine = `- Found on: ${resolved?.found_on ?? p.source} — ${p.url}`;
  const paidLabel = paidOnly ? ` ${PAID_ONLY_LABEL}` : "";
  const head = [`### ${title} — ${p.company_name}${paidLabel}`, ""];
  const common = [
    `- Location: ${location}`,
    `- Salary: ${g.salary}`,
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
      view: viewOf(g, "suspicious"),
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
  if (isScored(g.lead) && i !== null && i.fit_score !== null && !askless && !tierMissingForFx(i)) {
    const fitReasons = parseList(i.fit_reasons).slice(0, MAX_REASONS);
    const label = askLabel(i);
    const rank = rankScore({
      fitScore: i.fit_score,
      remainingUnclearFlags: unclear.length,
      listedMaxIdrMonth: g.lead.a.salary_idr_month_max,
      askIdrMonth: i.ask_idr_month,
    });
    if (i.fit_score < TOP_MATCH_MIN_FIT) {
      const reason = fitReasons[0];
      return {
        ...base,
        kind: "not_a_fit",
        rank,
        fit: i.fit_score,
        view: viewOf(g, "not_a_fit"),
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
      view: viewOf(g, "top"),
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
    view: viewOf(g, "waiting"),
    line: [`- ${title} — ${p.company_name}${paidLabel} — ${waitingReason(i)} — ${applyUrl}`],
  };
}

/** The view of a single canonical posting, whatever its decision (used for the posting detail). */
export function describePosting(db: Db, row: Row): PostingView {
  const entry = buildEntry(db, [row]);
  return entry !== null ? entry.view : viewOf(gather(db, [row]), "rejected");
}

/** posted_at descending, nulls last; ties by title then company so output is stable. */
export function byPostedDesc(a: Entry, b: Entry): number {
  return (
    compareRanked({ rank: 0, postedAt: a.postedAt }, { rank: 0, postedAt: b.postedAt }) ||
    a.title.localeCompare(b.title) ||
    a.company.localeCompare(b.company)
  );
}

function byRank(a: Entry, b: Entry): number {
  return compareRanked(a, b) || byPostedDesc(a, b);
}

export interface DaySelection {
  top: Entry[];
  notAFit: Entry[];
  waiting: Entry[];
  suspicious: Entry[];
  /** Top and waiting entries with an unclear flag still open (they also stay in their own section). */
  needsALook: Entry[];
}

/**
 * Sections of the day's matches for `date`. With `stamp` (the digest) newly kept postings are first
 * stamped with the date; without it (the dashboard) nothing is written.
 */
export function selectDay(db: Db, date: string, opts: { stamp: boolean }): DaySelection {
  const entries = db.transaction((tx) => {
    const t = tx as unknown as Db;
    if (opts.stamp) {
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
  return {
    top,
    notAFit,
    waiting,
    suspicious,
    needsALook: [...top, ...waiting].filter((e) => e.unclear.length > 0),
  };
}
