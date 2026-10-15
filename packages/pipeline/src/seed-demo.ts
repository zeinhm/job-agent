import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analysis,
  answer_bank,
  apply_links,
  companies,
  intel,
  posting_questions,
  postings,
  unknown_questions,
  type Db,
} from "@job-agent/core";
import { sql } from "drizzle-orm";
import { isDigestDate, jakartaDate } from "./digest/index.ts";
import { normalizeCompanyName } from "./normalize/index.ts";
import { DEMO_ANSWERS, DEMO_COMPANIES, DEMO_POSTINGS } from "./seed-demo.fixtures.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function isUnder(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Realpath of `path`; for a path that does not exist yet, the realpath of its nearest existing ancestor plus the rest.
 * A dangling symlink is followed to its (missing) target, so a link into a not-yet-created `data/` dir still resolves there.
 */
function realpathLoose(path: string): string {
  try {
    return realpathSync(path);
  } catch (e) {
    const parent = dirname(path);
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" || parent === path) throw e;
    const base = resolve(realpathLoose(parent), basename(path));
    try {
      if (lstatSync(base).isSymbolicLink())
        return realpathLoose(resolve(dirname(base), readlinkSync(base)));
    } catch {
      // not a link (or unreadable): the plain parent + name is the best answer
    }
    return base;
  }
}

/** The `data/` directories a demo seed must never write into: this checkout's and, in a worktree, the main checkout's. */
function protectedDataDirs(): string[] {
  const dirs = [resolve(REPO_ROOT, "data"), resolve("data")];
  const idx = REPO_ROOT.indexOf("/.worktrees/");
  if (idx > 0) dirs.push(resolve(REPO_ROOT.slice(0, idx), "data"));
  return dirs.flatMap((d) => {
    try {
      return [d, realpathLoose(d)];
    } catch {
      return [d];
    }
  });
}

/** Why the DB path may not be seeded, or null when it is a scratch DB. `dbEnv` is `JOB_AGENT_DB` as given. */
export function refusalReason(dbEnv: string | undefined): string | null {
  if (dbEnv === undefined || dbEnv === "")
    return "the default database (set JOB_AGENT_DB to a smoke DB)";
  if (dbEnv === ":memory:") return null;
  const path = resolve(dbEnv);
  let real: string;
  try {
    real = realpathLoose(path);
  } catch {
    return `a database whose path cannot be resolved (${dbEnv})`;
  }
  if (protectedDataDirs().some((d) => isUnder(d, path) || isUnder(d, real))) {
    return `a database under data/ (${dbEnv})`;
  }
  return null;
}

const id = (...parts: string[]) => `demo-${parts.join("-")}`;
const normLabel = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Thrown before any write when the DB already holds a posting that is not demo data. */
export class NonDemoDbError extends Error {
  constructor(count: number) {
    super(`the database holds ${count} non-demo posting(s)`);
  }
}

export interface SeedResult {
  postings: number;
  questions: number;
}

/** Writes the fake day for `date`; every row has a fixed id, so a repeat run inserts nothing. */
export function seedDemo(db: Db, date: string): SeedResult {
  const at = (hhmm: string) => `${date}T${hhmm}:00.000Z`;
  let newPostings = 0;
  let newQuestions = 0;
  db.transaction((tx) => {
    const t = tx as unknown as Db;
    // First statement of the transaction, before any write: a DB with real postings is never seeded.
    const foreign =
      t
        .select({ n: sql<number>`count(*)` })
        .from(postings)
        .where(sql`substr(${postings.id}, 1, 5) <> 'demo-'`)
        .get()?.n ?? 0;
    if (foreign > 0) throw new NonDemoDbError(foreign);
    for (const c of DEMO_COMPANIES) {
      t.insert(companies)
        .values({
          id: id("company", c.slug),
          name: c.name,
          normalized_name: normalizeCompanyName(c.name),
          domain: c.domain,
          ats_type: c.ats ?? null,
          ats_slug: c.ats ? c.slug : null,
          discovered_via: "manual",
          created_at: at("00:00"),
        })
        .onConflictDoNothing()
        .run();
    }
    for (const a of DEMO_ANSWERS) {
      t.insert(answer_bank)
        .values({
          id: id("answer", a.key),
          ...a,
          approved: true,
          approved_at: at("00:00"),
          source: "dashboard",
          updated_at: at("00:00"),
        })
        .onConflictDoNothing()
        .run();
    }
    for (const p of DEMO_POSTINGS) {
      const company = DEMO_COMPANIES.find((c) => c.name === p.company);
      if (company === undefined) throw new Error(`seed-demo fixture: unknown company ${p.company}`);
      const pid = id(date, p.key);
      const url = `https://${company.domain}/jobs/${p.key}`;
      const salary = p.salaryIdr;
      const inserted = t
        .insert(postings)
        .values({
          id: pid,
          source: p.source,
          external_id: pid,
          url,
          apply_url: url,
          title: p.title,
          company_id: id("company", company.slug),
          company_name: p.company,
          description_text: `Fake demo posting for ${p.title}. Not a real job.`,
          location_text: p.location,
          remote: true,
          salary_text: p.salaryText ?? null,
          posted_at: at("03:00"),
          first_seen_at: at("04:00"),
          last_seen_at: at("04:00"),
          normalized_at: at("04:00"),
        })
        .onConflictDoNothing()
        .run();
      newPostings += inserted.changes;
      t.insert(analysis)
        .values({
          id: id("analysis", date, p.key),
          posting_id: pid,
          location_class: p.locationClass,
          indonesia_rule: p.flags.includes("indonesia_unclear") ? "unclear" : "not_applicable",
          salary_idr_month_min: salary?.[0] ?? null,
          salary_idr_month_max: salary?.[1] ?? null,
          salary_status: salary ? "listed" : "unknown",
          decision: "keep",
          flags: JSON.stringify(p.flags),
          reasons: JSON.stringify([]),
          analyzed_at: at("04:05"),
          digested_at: date,
        })
        .onConflictDoNothing()
        .run();
      t.insert(apply_links)
        .values({
          id: id("apply", date, p.key),
          posting_id: pid,
          apply_url: url,
          apply_type: p.apply.type,
          method: p.apply.method,
          ats_type: company.ats ?? null,
          ats_slug: company.ats ? company.slug : null,
          found_on: p.source,
          checked_at: at("04:10"),
        })
        .onConflictDoNothing()
        .run();
      const i = p.intel;
      if (i.kind !== "none") {
        const base = { id: id("intel", date, p.key), posting_id: pid, updated_at: at("05:00") };
        if (i.kind === "scored") {
          t.insert(intel)
            .values({
              ...base,
              status: "done",
              final_decision: "keep",
              resolved_reasons: JSON.stringify([]),
              scam_score: i.scam?.[0] ?? 0,
              scam_reasons: JSON.stringify(i.scam ? [i.scam[1]] : []),
              fit_score: i.fit,
              fit_reasons: JSON.stringify(i.reasons),
              fit_model: "demo",
              fit_prompt_version: "demo",
              tier: i.tier,
              ask_usd_year: i.askUsdYear,
              ask_idr_month: Math.round((i.askUsdYear * 16_000) / 12),
              ask_reason: "demo data",
            })
            .onConflictDoNothing()
            .run();
        } else if (i.kind === "suspicious") {
          t.insert(intel)
            .values({
              ...base,
              status: "done",
              final_decision: "suspicious",
              resolved_reasons: JSON.stringify([]),
              scam_score: i.score,
              scam_reasons: JSON.stringify(i.reasons),
            })
            .onConflictDoNothing()
            .run();
        } else {
          t.insert(intel)
            .values({ ...base, status: i.status, resolved_reasons: JSON.stringify([]) })
            .onConflictDoNothing()
            .run();
        }
      }
      for (const q of p.questions ?? []) {
        const label = normLabel(q.label);
        const r = t
          .insert(posting_questions)
          .values({
            id: id("question", date, p.key, q.id),
            posting_id: pid,
            ats_type: company.ats ?? "greenhouse",
            question_id: q.id,
            label: q.label,
            required: q.required,
            type: q.type,
            normalized_label: label,
            matched_key: q.matchedKey ?? null,
            fetched_at: at("04:20"),
          })
          .onConflictDoNothing()
          .run();
        newQuestions += r.changes;
        if (q.matchedKey === undefined) {
          t.insert(unknown_questions)
            .values({
              id: id("unknown", label.replace(/ /g, "-")),
              normalized_label: label,
              label: q.label,
              posting_count: 1,
              first_seen_at: at("04:20"),
              last_seen_at: at("04:20"),
              status: "open",
            })
            .onConflictDoNothing()
            .run();
        }
      }
    }
  });
  return { postings: newPostings, questions: newQuestions };
}

export interface SeedDemoOptions {
  /** `JOB_AGENT_DB` as set, or undefined. */
  dbEnv: string | undefined;
  date?: string;
  openDb: () => Db;
  out: (t: string) => void;
  err: (t: string) => void;
}

export function runSeedDemo(opts: SeedDemoOptions): number {
  const date = opts.date ?? jakartaDate(new Date());
  let validDate = false;
  try {
    validDate = isDigestDate(date);
  } catch {
    // isDigestDate throws on an impossible month or day (e.g. 2026-13-40); that is an invalid date here.
  }
  if (!validDate) {
    opts.err(`seed-demo: invalid date "${date}", expected YYYY-MM-DD\n`);
    return 1;
  }
  const reason = refusalReason(opts.dbEnv);
  if (reason !== null) {
    opts.err(`seed-demo: refusing to write ${reason}\n`);
    return 2;
  }
  const db = opts.openDb();
  try {
    const r = seedDemo(db, date);
    opts.out(`seed-demo ${date}: added ${r.postings} postings, ${r.questions} questions\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof NonDemoDbError)) throw e;
    opts.err(`seed-demo: refusing to write, ${e.message} (seed a fresh DB before discover)\n`);
    return 1;
  } finally {
    db.$client.close();
  }
}
