import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, asc, eq, gte, inArray, isNull } from "drizzle-orm";
import { analysis, postings, source_runs, type Db, type Posting } from "@job-agent/core";
import { formatSalary } from "./format.ts";

export { formatMillions, formatSalary } from "./format.ts";

const ATS_SOURCES = new Set(["greenhouse", "lever", "ashby"]);
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DigestOptions {
  db: Db;
  /** YYYY-MM-DD; default today in Asia/Jakarta. */
  date?: string;
  now?: () => Date;
  /** Output folder; default data/digests. */
  dir?: string;
}

export function jakartaDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(now);
}

export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

interface Entry {
  posting: Posting;
  locationClass: string;
  salary: string;
  flags: string[];
  sources: string[];
}

function parseList(json: string | null): string[] {
  if (json === null) return [];
  const v: unknown = JSON.parse(json);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** posted_at desc, nulls last; id as tiebreak so output is deterministic. */
function byPostedDesc(a: Entry, b: Entry): number {
  const pa = a.posting.posted_at;
  const pb = b.posting.posted_at;
  if (pa !== pb) {
    if (pa === null) return 1;
    if (pb === null) return -1;
    return pa < pb ? 1 : -1;
  }
  return a.posting.id < b.posting.id ? -1 : 1;
}

function renderEntry(e: Entry): string {
  const p = e.posting;
  const link = ATS_SOURCES.has(p.source) ? (p.apply_url ?? p.url) : p.url;
  const location =
    p.location_text === null ? e.locationClass : `${e.locationClass} — ${p.location_text}`;
  return [
    `### ${p.title} — ${p.company_name}`,
    "",
    `- Location: ${location}`,
    `- Salary: ${e.salary}`,
    `- Flags: ${e.flags.length > 0 ? e.flags.join(", ") : "none"}`,
    `- Link: ${link}`,
    `- Sources: ${e.sources.join(", ")}`,
    `- Posted: ${p.posted_at === null ? "date unknown" : p.posted_at.slice(0, 10)}`,
    "",
  ].join("\n");
}

function renderSection(title: string, entries: Entry[], empty: string): string[] {
  return [`## ${title}`, "", ...(entries.length === 0 ? [empty, ""] : entries.map(renderEntry))];
}

function renderHealth(db: Db, now: Date): string[] {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const runs = db
    .select()
    .from(source_runs)
    .orderBy(asc(source_runs.source), asc(source_runs.started_at), asc(source_runs.id))
    .all();
  const lines = ["## Source health", ""];
  const names = [...new Set(runs.map((r) => r.source))].sort();
  if (names.length === 0) return [...lines, "No source runs recorded.", ""];
  for (const name of names) {
    const recent = runs.filter(
      (r) => r.source === name && r.started_at >= since && r.started_at <= now.toISOString(),
    );
    const latest = recent.at(-1);
    const hasOk = recent.some((r) => r.status === "ok");
    const detail =
      latest === undefined
        ? "no run in the last 24h"
        : `${latest.status}, found ${latest.found}, new ${latest.new}` +
          (latest.error_message === null ? "" : `, error: ${latest.error_message}`);
    lines.push(`- ${name}: ${detail}${hasOk ? "" : " — NO SUCCESSFUL RUN"}`);
  }
  return [...lines, ""];
}

/** Stamps new kept canonical postings with the digest date and writes data/digests/<date>.md. Returns the path. */
export function runDigest(opts: DigestOptions): { path: string; content: string } {
  const { db } = opts;
  const now = (opts.now ?? (() => new Date()))();
  const date = opts.date ?? jakartaDate(now);
  if (!isValidDate(date)) throw new Error(`Invalid date: ${date} (expected YYYY-MM-DD)`);

  // Stamp and read in one transaction so a concurrent process run cannot split the two.
  const { stamped, recent } = db.transaction((tx) => {
    const t = tx as unknown as Db;
    const pending = t
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
      .all();
    for (const row of pending) {
      t.update(analysis).set({ digested_at: date }).where(eq(analysis.id, row.id)).run();
    }
    const rows = t
      .select({ posting: postings, a: analysis })
      .from(analysis)
      .innerJoin(postings, eq(postings.id, analysis.posting_id))
      .where(and(eq(analysis.digested_at, date), eq(analysis.decision, "keep")))
      .all();
    const since = new Date(now.getTime() - DAY_MS).toISOString();
    const recentRows = t
      .select({ a: analysis })
      .from(analysis)
      .where(and(eq(analysis.decision, "reject"), gte(analysis.analyzed_at, since)))
      .all();
    return { stamped: rows, recent: recentRows.map((r) => r.a) };
  });

  const ids = stamped.map((r) => r.posting.id);
  const dupSources = new Map<string, string[]>();
  if (ids.length > 0) {
    for (const d of db
      .select()
      .from(postings)
      .where(inArray(postings.canonical_posting_id, ids))
      .all()) {
      const key = d.canonical_posting_id ?? "";
      dupSources.set(key, [...(dupSources.get(key) ?? []), d.source]);
    }
  }

  const entries: Entry[] = stamped.map(({ posting, a }) => ({
    posting,
    locationClass: a.location_class,
    salary: formatSalary({
      status: a.salary_status,
      idrMonthMin: a.salary_idr_month_min,
      idrMonthMax: a.salary_idr_month_max,
    }),
    flags: parseList(a.flags),
    sources: [
      posting.source,
      ...[...new Set(dupSources.get(posting.id) ?? [])].filter((s) => s !== posting.source).sort(),
    ],
  }));
  const matches = entries.filter((e) => e.flags.length === 0).sort(byPostedDesc);
  const lookAt = entries.filter((e) => e.flags.length > 0).sort(byPostedDesc);

  // Reject reasons are derived from the analysis columns; the salary floor is the remaining rule.
  const byReason = { location: 0, indonesia: 0, salary: 0 };
  for (const a of recent) {
    if (a.location_class === "restricted") byReason.location += 1;
    else if (a.indonesia_rule === "domestic") byReason.indonesia += 1;
    else byReason.salary += 1;
  }

  const content = [
    `# Job digest ${date}`,
    "",
    `- Kept today: ${entries.length}`,
    `- Flagged: ${lookAt.length}`,
    `- Rejected in the last 24h: ${recent.length} (location ${byReason.location}, indonesia ${byReason.indonesia}, salary ${byReason.salary})`,
    "",
    ...renderSection("Matches", matches, "No new matches"),
    ...renderSection("Needs a look", lookAt, "Nothing needs a look"),
    ...renderHealth(db, now),
  ].join("\n");

  const dir = opts.dir ?? join("data", "digests");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${date}.md`);
  writeFileSync(path, content);
  return { path, content };
}
