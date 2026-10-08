import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import { analysis, postings, source_runs, type Db } from "@job-agent/core";
import { classifyRole } from "../filters/role.ts";
import { SALARY_BELOW_FLOOR_REASON } from "../filters/salary-floor.ts";
import { formatSalary, isAtsSource, parseList } from "./format.ts";
import { groupPostings, joinLocations } from "./group.ts";

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

type Row = { p: typeof postings.$inferSelect; a: typeof analysis.$inferSelect };

/** One entry for a group of same company + title postings; the best member (ATS first) leads. */
function buildEntry(db: Db, group: Row[]): Entry {
  const { p, a } = group[0] as Row;
  const flags = [...new Set(group.flatMap((r) => parseList(r.a.flags)))];
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
  const locations = joinLocations(group.map((r) => r.p.location_text));
  const location = [a.location_class, locations].filter((x) => x).join(" — ");
  const dates = group.map((r) => r.p.posted_at).filter((d): d is string => d !== null);
  const posted = dates.length > 0 ? dates.reduce((x, y) => (x > y ? x : y)) : null;
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
    `- Posted: ${posted !== null ? posted.slice(0, 10) : "unknown"}`,
    "",
  ];
  return {
    title: p.title,
    company: p.company_name,
    line: lines,
    postedAt: posted,
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
    const rows: Row[] = t
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
    return groups.map((g) =>
      buildEntry(
        t,
        g.map((x) => x.row),
      ),
    );
  });

  const matches = entries.filter((e) => !e.flagged).sort(byPostedDesc);
  const looks = entries.filter((e) => e.flagged).sort(byPostedDesc);

  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const rejectedRows = db
    .select({ r: analysis, p: postings })
    .from(analysis)
    .innerJoin(postings, eq(postings.id, analysis.posting_id))
    .where(and(eq(analysis.decision, "reject"), gte(analysis.analyzed_at, since)))
    .all();
  const rejected = rejectedRows.map((x) => x.r);
  const byReason = { location: 0, indonesia: 0, role: 0, salary: 0 };
  for (const { r, p } of rejectedRows) {
    if (classifyRole({ title: p.title, descriptionText: p.description_text }).class === "reject")
      byReason.role += 1;
    if (r.location_class === "restricted") byReason.location += 1;
    if (r.indonesia_rule === "domestic") byReason.indonesia += 1;
    if (parseList(r.reasons).includes(`salary: ${SALARY_BELOW_FLOOR_REASON}`)) byReason.salary += 1;
  }

  const body = [
    `# Job digest ${date}`,
    "",
    `- Kept today: ${entries.length}`,
    `- Flagged (needs a look): ${looks.length}`,
    `- Rejected in the last 24h: ${rejected.length} ` +
      `(location ${byReason.location}, indonesia ${byReason.indonesia}, role ${byReason.role}, salary ${byReason.salary})`,
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
