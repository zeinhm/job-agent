import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import {
  analysis,
  companies,
  loadConfig,
  log,
  postings,
  type Db,
  type NewAnalysis,
  type Posting,
} from "@job-agent/core";
import { STALE_ANALYZED_AT } from "./stale.ts";
import { dedupePending } from "./dedupe/index.ts";
import { classifyIndonesia } from "./filters/indonesia.ts";
import { classifyLanguage } from "./filters/language.ts";
import { classifyLocation } from "./filters/location.ts";
import { classifyRole } from "./filters/role.ts";
import { applySalaryFloor } from "./filters/salary-floor.ts";
import { normalizePending } from "./normalize/index.ts";
import { parseSalary, toIdrMonth } from "./salary/index.ts";

export interface ProcessOptions {
  db: Db;
  floorIdrMonth?: number;
  now?: () => Date;
  out: (text: string) => void;
  err: (text: string) => void;
}

const FLAG_ORDER = [
  "location_unclear",
  "indonesia_unclear",
  "role_unclear",
  "salary_unknown",
  "salary_unparsed",
  "salary_no_fx",
] as const;

type RejectRule = "location" | "indonesia" | "role" | "salary" | "language";

/** Today in Asia/Jakarta as YYYY-MM-DD. */
function jakartaDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(now);
}

function analyze(db: Db, p: Posting, floor: number, now: Date) {
  const hasNumbers = p.salary_min !== null || p.salary_max !== null;
  const parsed = parseSalary({
    ...(hasNumbers && p.salary_currency !== null && p.salary_period !== null
      ? {
          salary: {
            ...(p.salary_min !== null ? { min: p.salary_min } : {}),
            ...(p.salary_max !== null ? { max: p.salary_max } : {}),
            currency: p.salary_currency,
            period: p.salary_period,
          },
        }
      : {}),
    ...(p.salary_text !== null ? { salaryText: p.salary_text } : {}),
  });
  const idr = toIdrMonth(parsed, db, jakartaDate(now));

  const location = classifyLocation({
    locationText: p.location_text,
    descriptionText: p.description_text,
    remote: p.remote,
  });
  const company =
    p.company_id === null
      ? undefined
      : db.select().from(companies).where(eq(companies.id, p.company_id)).get();
  const indonesia = classifyIndonesia({
    locationText: p.location_text,
    descriptionText: p.description_text,
    companyHqCountry: company?.hq_country ?? null,
    companyDomain: company?.domain ?? null,
    salaryCurrency: "currency" in parsed ? parsed.currency : null,
  });
  const role = classifyRole({ title: p.title, descriptionText: p.description_text });
  const language = classifyLanguage({ title: p.title, descriptionText: p.description_text });
  const floorResult = applySalaryFloor(idr, floor);

  const rejectedBy: RejectRule[] = [];
  if (location.class === "restricted") rejectedBy.push("location");
  if (indonesia.value === "domestic") rejectedBy.push("indonesia");
  if (role.class === "reject") rejectedBy.push("role");
  if (floorResult.reject) rejectedBy.push("salary");
  if (language.class === "reject") rejectedBy.push("language");

  const flags = new Set<string>();
  if (location.class === "unclear") flags.add("location_unclear");
  if (indonesia.value === "unclear") flags.add("indonesia_unclear");
  if (role.class === "unclear") flags.add("role_unclear");
  if (floorResult.flag !== undefined) flags.add(floorResult.flag);

  // Same job already sent under another posting of the group: don't send it again.
  const digestedAt =
    db
      .select({ digested_at: analysis.digested_at })
      .from(analysis)
      .innerJoin(postings, eq(postings.id, analysis.posting_id))
      .where(
        and(
          or(eq(postings.id, p.id), eq(postings.canonical_posting_id, p.id)),
          isNotNull(analysis.digested_at),
        ),
      )
      .all()
      .map((g) => g.digested_at ?? "")
      .sort()
      .at(-1) ?? null;

  const row: NewAnalysis = {
    id: randomUUID(),
    posting_id: p.id,
    location_class: location.class,
    location_reason: location.reason,
    indonesia_rule: indonesia.value,
    indonesia_reason: indonesia.reason,
    salary_idr_month_min: idr.status === "listed" ? (idr.idrMonthMin ?? null) : null,
    salary_idr_month_max: idr.status === "listed" ? (idr.idrMonthMax ?? null) : null,
    salary_status: idr.status,
    fx_rate_date: idr.status === "listed" ? idr.fxDate : null,
    decision: rejectedBy.length > 0 ? "reject" : "keep",
    flags: JSON.stringify(FLAG_ORDER.filter((f) => flags.has(f))),
    reasons: JSON.stringify([
      `location: ${location.reason}`,
      `indonesia: ${indonesia.reason}`,
      `role: ${role.reason}`,
      `salary: ${floorResult.reason}`,
      `language: ${language.reason}`,
    ]),
    analyzed_at: now.toISOString(),
    digested_at: digestedAt,
  };
  return { row, rejectedBy, flagged: flags.size > 0 };
}

/** Normalizes, dedupes and analyses new postings. Returns the exit code (1 if any posting failed). */
export function runProcess(opts: ProcessOptions): number {
  const { db, out, err } = opts;
  const now = opts.now ?? (() => new Date());
  const floor = opts.floorIdrMonth ?? loadConfig().salary.floor_idr_month;

  normalizePending(db, { now });
  dedupePending(db);

  // A posting analysed while the FX table was empty (no_fx) is analysed again once rates exist,
  // unless it was already sent in a digest.
  const analysed = new Set(
    db
      .select({
        id: analysis.posting_id,
        status: analysis.salary_status,
        digested_at: analysis.digested_at,
        analyzed_at: analysis.analyzed_at,
      })
      .from(analysis)
      .all()
      // no_fx: redo once rates exist. Stale: the employer edited the posting (see discover).
      .filter((a) => !(a.status === "no_fx" && a.digested_at === null))
      .filter((a) => a.analyzed_at !== STALE_ANALYZED_AT)
      .map((a) => a.id),
  );
  const todo = db
    .select()
    .from(postings)
    .where(and(isNull(postings.canonical_posting_id), isNotNull(postings.normalized_at)))
    .all()
    .filter((p) => !analysed.has(p.id));

  let processed = 0;
  let kept = 0;
  let rejectedTotal = 0;
  let flagged = 0;
  let failed = 0;
  const rejected: Record<RejectRule, number> = {
    location: 0,
    indonesia: 0,
    role: 0,
    salary: 0,
    language: 0,
  };

  for (const p of todo) {
    try {
      const result = db.transaction((tx) => {
        const r = analyze(tx as unknown as Db, p, floor, now());
        tx.delete(analysis).where(eq(analysis.posting_id, p.id)).run();
        tx.insert(analysis).values(r.row).run();
        return r;
      });
      processed += 1;
      if (result.rejectedBy.length === 0) kept += 1;
      else {
        rejectedTotal += 1;
        for (const r of result.rejectedBy) rejected[r] += 1;
      }
      if (result.flagged) flagged += 1;
    } catch (e) {
      failed += 1;
      const message = e instanceof Error ? e.message : String(e);
      log.error("process: posting analysis failed", { postingId: p.id, error: message });
      err(`process: posting ${p.id} failed: ${message}\n`);
    }
  }

  out(
    `processed ${processed}, kept ${kept}, rejected ${rejectedTotal} ` +
      `(location ${rejected.location}, indonesia ${rejected.indonesia}, role ${rejected.role}, salary ${rejected.salary}, language ${rejected.language}), ` +
      `flagged ${flagged}${failed > 0 ? `, failed ${failed}` : ""}\n`,
  );
  return failed > 0 ? 1 : 0;
}
