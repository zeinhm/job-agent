import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import { analysis, postings, source_runs, type Db } from "@job-agent/core";
import { formatSalary, isAtsSource, parseList } from "./format.ts";

export { formatSalary } from "./format.ts";

export interface DigestOptions {
  db: Db;
  /** YYYY-MM-DD, default today in Asia/Jakarta. */
  date?: string;
  /** Default `data/digests`. */
  outDir?: string;
  now?: () => Date;
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

interface Entry {
  title: string;
  company: string;
  line: string[];
  postedAt: string | null;
  flagged: boolean;
}

function buildEntry(
  db: Db,
  p: typeof postings.$inferSelect,
  a: typeof analysis.$inferSelect,
): Entry {
  const flags = parseList(a.flags);
  const dupSources = db
    .select({ source: postings.source })
    .from(postings)
    .where(eq(postings.canonical_posting_id, p.id))
    .all()
    .map((d) => d.source);
  const sources = [p.source, ...[...new Set(dupSources)].filter((s) => s !== p.source).sort()];
  const link = isAtsSource(p.source) ? (p.apply_url ?? p.url) : p.url;
  const location = [a.location_class, p.location_text].filter((x) => x).join(" — ");
  const lines = [
    `### ${p.title} — ${p.company_name}`,
    "",
    `- Location: ${location}`,
    `- Salary: ${formatSalary({
      status: a.salary_status,
      idrMonthMin: a.salary_idr_month_min,
      idrMonthMax: a.salary_idr_month_max,
    })}`,
    `- Flags: ${flags.length > 0 ? flags.join(", ") : "none"}`,
    `- Link: ${link}`,
    `- Sources: ${sources.join(", ")}`,
    `- Posted: ${p.posted_at !== null ? p.posted_at.slice(0, 10) : "unknown"}`,
    "",
  ];
  return {
    title: p.title,
    company: p.company_name,
    line: lines,
    postedAt: p.posted_at,
    flagged: flags.length > 0,
  };
}

/** posted_at descending, nulls last; ties by title then company so output is stable. */
function byPostedDesc(a: Entry, b: Entry): number {
  if (a.postedAt !== b.postedAt) {
    if (a.postedAt === null) return 1;
    if (b.postedAt === null) return -1;
    return a.postedAt < b.postedAt ? 1 : -1;
  }
  return a.title.localeCompare(b.title) || a.company.localeCompare(b.company);
}

function section(heading: string, entries: Entry[]): string[] {
  return [
    `## ${heading}`,
    "",
    ...(entries.length === 0 ? ["None.", ""] : entries.flatMap((e) => e.line)),
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
      .filter((r) => r.source === name && r.started_at >= since)
      .sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0));
    const latest = recent[0];
    const noOk = !recent.some((r) => r.status === "ok");
    let text: string;
    if (latest === undefined) text = "no run in the last 24h";
    else {
      text = `${latest.status}, found ${latest.found}, new ${latest.new}`;
      if (latest.error_message !== null)
        text += `, error: ${latest.error_message.replace(/\s+/g, " ")}`;
    }
    lines.push(`- **${name}**: ${text}${noOk ? " — NO SUCCESSFUL RUN" : ""}`);
  }
  return [...lines, ""];
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
    return t
      .select({ p: postings, a: analysis })
      .from(analysis)
      .innerJoin(postings, eq(postings.id, analysis.posting_id))
      .where(
        and(
          eq(analysis.decision, "keep"),
          eq(analysis.digested_at, date),
          isNull(postings.canonical_posting_id),
        ),
      )
      .all()
      .map(({ p, a }) => buildEntry(t, p, a));
  });

  const matches = entries.filter((e) => !e.flagged).sort(byPostedDesc);
  const looks = entries.filter((e) => e.flagged).sort(byPostedDesc);

  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const rejected = db
    .select()
    .from(analysis)
    .where(and(eq(analysis.decision, "reject"), gte(analysis.analyzed_at, since)))
    .all();
  const byReason = { location: 0, indonesia: 0, salary: 0 };
  for (const r of rejected) {
    if (r.location_class === "restricted") byReason.location += 1;
    if (r.indonesia_rule === "domestic") byReason.indonesia += 1;
    if (parseList(r.reasons).includes("salary: max below floor")) byReason.salary += 1;
  }

  const body = [
    `# Job digest ${date}`,
    "",
    `- Kept today: ${entries.length}`,
    `- Flagged (needs a look): ${looks.length}`,
    `- Rejected in the last 24h: ${rejected.length} ` +
      `(location ${byReason.location}, indonesia ${byReason.indonesia}, salary ${byReason.salary})`,
    "",
    ...(entries.length === 0 ? ["No new matches.", ""] : []),
    ...(entries.length === 0 ? [] : section("Matches", matches)),
    ...(entries.length === 0 ? [] : section("Needs a look", looks)),
    ...sourceHealth(db, now),
  ].join("\n");

  const dir = opts.outDir ?? join("data", "digests");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${date}.md`);
  writeFileSync(path, body);
  out(`${path}\n`);
  return path;
}
