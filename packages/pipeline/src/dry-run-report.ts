import { existsSync } from "node:fs";
import {
  DRY_RUN_ATS_TYPES,
  DRY_RUN_FIELD_SOURCES,
  DRY_RUN_REVIEW_REASONS,
  DRY_RUN_REVIEWS,
  DRY_RUN_STATUSES,
  DRY_RUN_STOP_REASONS,
  dry_run_fields,
  dry_runs,
  openDbReadonly,
  postings,
  type Db,
} from "@job-agent/core";
import { AUTOCOMPLETE_NOTES, errorLine, refusalLine, sanitizeText } from "@job-agent/apply";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

const COMMAND = "dry-run-report";

export const DRY_RUN_REPORT_USAGE =
  "Usage: job-agent dry-run-report [--batch <id>] [--posting <id>] [--since <ISO date>] [--last <n>]\n";

export const DEFAULT_LAST = 10;
export const MAX_LAST = 200;

/**
 * The only free-text field notes that are printed, exact match. The harness writes these fixed sentences; anything
 * else (a page's wording, a stored detail) prints `note: other`.
 */
export const KNOWN_FIELD_NOTES: readonly string[] = [
  ...Object.values(AUTOCOMPLETE_NOTES),
  "combobox / autocomplete: the owner picks the suggestion",
  "no approved choice mapping",
  "page kept a different value",
  "page refused the value",
  "page did not keep the uploaded file",
  "skipped: survey / self-identification block, never touched",
  "skipped: text message consent, never touched",
  "resume path is not absolute",
  "resume file is not a .pdf",
  "resume path is not a file",
  "resume file does not exist",
  "resume file is empty or 10 MB or more",
  "resume file cannot be read",
  "resume file is not a PDF",
  "salary: currency not supported",
  "salary: currency unclear",
  "salary: period not supported",
  "salary: period unclear",
  "salary: no ask",
];

export function printableNote(note: string | null): string | null {
  if (note === null) return null;
  return KNOWN_FIELD_NOTES.includes(note) ? note : "other";
}

// Only these columns are ever read from the database: value, review_note, screenshot_path and the free-text note
// are never selected for printing (the note is read only to be matched against the fixed list).
const RunRow = z.object({
  id: z.string().min(1),
  posting_id: z.string().min(1),
  ats_type: z.enum(DRY_RUN_ATS_TYPES),
  started_at: z.string().min(1),
  status: z.enum(DRY_RUN_STATUSES),
  stop_reason: z.enum(DRY_RUN_STOP_REASONS).nullable(),
  stop_detail: z.string().nullable(),
  review: z.enum(DRY_RUN_REVIEWS).nullable(),
  review_reason: z.enum(DRY_RUN_REVIEW_REASONS).nullable(),
  fixture: z.boolean(),
});
type RunRow = z.infer<typeof RunRow>;

const FieldRow = z.object({
  label: z.string(),
  field_type: z.string(),
  required: z.boolean(),
  source: z.enum(DRY_RUN_FIELD_SOURCES),
  answer_key: z.string().nullable(),
  filled: z.boolean(),
  note: z.string().nullable(),
});
type FieldRow = z.infer<typeof FieldRow>;

const runColumns = {
  id: dry_runs.id,
  posting_id: dry_runs.posting_id,
  ats_type: dry_runs.ats_type,
  started_at: dry_runs.started_at,
  status: dry_runs.status,
  stop_reason: dry_runs.stop_reason,
  stop_detail: dry_runs.stop_detail,
  review: dry_runs.review,
  review_reason: dry_runs.review_reason,
  fixture: dry_runs.fixture,
};

const idArg = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
const lastArg = z
  .string()
  .regex(/^\d{1,3}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(MAX_LAST));
const sinceArg = z.union([z.iso.date(), z.iso.datetime()]);

interface Options {
  batch: string | undefined;
  posting: string | undefined;
  since: string | undefined;
  last: number;
}

/** What `util.parseArgs` returned in cli.ts, or null when it threw (its message quotes what was typed). */
export interface RawArgs {
  values: {
    batch?: string | undefined;
    posting?: string | undefined;
    since?: string | undefined;
    last?: string | undefined;
  };
  positionals: string[];
}

/** Null for any bad argument: the caller prints fixed text only. */
function parseOptions(raw: RawArgs | null): Options | null {
  if (raw === null) return null;
  try {
    const { values, positionals } = raw;
    if (positionals.length > 0) return null;
    const batch = values.batch === undefined ? undefined : idArg.parse(values.batch);
    const posting = values.posting === undefined ? undefined : idArg.parse(values.posting);
    const sinceRaw = values.since === undefined ? undefined : sinceArg.parse(values.since);
    const since = sinceRaw === undefined ? undefined : new Date(sinceRaw).toISOString();
    const last = values.last === undefined ? DEFAULT_LAST : lastArg.parse(values.last);
    return { batch, posting, since, last };
  } catch {
    return null;
  }
}

const q = (text: string): string => JSON.stringify(sanitizeText(text));
const yn = (b: boolean): string => (b ? "yes" : "no");

interface RunView {
  run: RunRow;
  fields: FieldRow[];
  startedBy: string | null;
}

function fieldsOf(db: Db, runId: string): FieldRow[] {
  return db
    .select({
      label: dry_run_fields.label,
      field_type: dry_run_fields.field_type,
      required: dry_run_fields.required,
      source: dry_run_fields.source,
      answer_key: dry_run_fields.answer_key,
      filled: dry_run_fields.filled,
      note: dry_run_fields.note,
    })
    .from(dry_run_fields)
    .where(eq(dry_run_fields.dry_run_id, runId))
    .orderBy(sql`rowid`)
    .all()
    .map((r) => FieldRow.parse(r));
}

/** `started_by` exists once the operator migration is merged; before that the column is absent and nothing prints. */
function startedByMap(db: Db): Map<string, string> | null {
  const cols = db.$client.prepare("pragma table_info(dry_runs)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "started_by")) return null;
  const rows = db.$client.prepare("select id, started_by from dry_runs").all() as {
    id: string;
    started_by: unknown;
  }[];
  // A fixed shape (an enum-like word); anything else prints as `other`.
  return new Map(
    rows.map((r) => [
      r.id,
      typeof r.started_by === "string" && /^[a-z_]{1,20}$/.test(r.started_by)
        ? r.started_by
        : "other",
    ]),
  );
}

function view(db: Db, run: RunRow, by: Map<string, string> | null): RunView {
  return { run, fields: fieldsOf(db, run.id), startedBy: by?.get(run.id) ?? null };
}

function previousRun(db: Db, run: RunRow): RunRow | null {
  const row = db
    .select(runColumns)
    .from(dry_runs)
    .where(
      and(
        eq(dry_runs.posting_id, run.posting_id),
        eq(dry_runs.fixture, run.fixture),
        or(
          lt(dry_runs.started_at, run.started_at),
          and(eq(dry_runs.started_at, run.started_at), lt(dry_runs.id, run.id)),
        ),
      ),
    )
    .orderBy(desc(dry_runs.started_at), desc(dry_runs.id))
    .limit(1)
    .get();
  return row === undefined ? null : RunRow.parse(row);
}

const GOOD = new Set(["filled", "needs_input"]);
const BAD = new Set(["stopped", "error"]);
const filledCount = (fields: FieldRow[]): number => fields.filter((f) => f.filled).length;

/** Why `now` is worse than `before`: fixed words only. Empty when it is not worse. */
export function regressionReasons(
  before: { status: string; fields: FieldRow[] },
  now: { status: string; fields: FieldRow[] },
): string[] {
  const reasons: string[] = [];
  if (GOOD.has(before.status) && BAD.has(now.status)) reasons.push("status");
  if (filledCount(now.fields) < filledCount(before.fields)) reasons.push("fewer_filled");
  const nowFilled = new Set(now.fields.filter((f) => f.filled).map((f) => sanitizeText(f.label)));
  const lost = before.fields.some((f) => f.filled && !nowFilled.has(sanitizeText(f.label)));
  if (lost) reasons.push("field_lost");
  return reasons;
}

function runLines(db: Db, v: RunView): string[] {
  const { run, fields } = v;
  const lines = [
    `run ${q(run.id)} posting=${q(run.posting_id)} ats=${run.ats_type} started=${q(run.started_at)}` +
      `${v.startedBy === null ? "" : ` by=${v.startedBy}`}${run.fixture ? " fixture" : ""} status=${run.status} ` +
      `reason=${run.stop_reason ?? "-"} filled=${filledCount(fields)}/${fields.length} ` +
      `review=${run.review ?? "-"} review_reason=${run.review_reason ?? "-"}`,
  ];
  if (run.stop_detail !== null && sanitizeText(run.stop_detail) !== "")
    lines.push(`  detail: ${q(run.stop_detail)}`);
  const prev = previousRun(db, run);
  if (prev === null) {
    lines.push("  previous: none");
  } else {
    const before = view(db, prev, null);
    lines.push(
      `  previous: run ${q(prev.id)} status=${prev.status} reason=${prev.stop_reason ?? "-"} ` +
        `filled=${filledCount(before.fields)}/${before.fields.length}`,
    );
    const why = regressionReasons(
      { status: prev.status, fields: before.fields },
      { status: run.status, fields },
    );
    if (why.length > 0) lines.push(`  REGRESSION: ${why.join(",")}`);
  }
  for (const f of fields) {
    const note = printableNote(f.note);
    lines.push(
      `  field ${q(f.label)} type=${q(f.field_type)} required=${yn(f.required)} filled=${yn(f.filled)} ` +
        `source=${f.source} key=${f.answer_key === null ? "-" : q(f.answer_key)}` +
        `${note === null ? "" : ` note: ${note}`}`,
    );
  }
  return lines;
}

export interface DryRunReportOptions {
  args: RawArgs | null;
  dbPath: string;
  out: (text: string) => void;
  err: (text: string) => void;
}

/** Read-only, value-free report of recent dry runs. Never prints a value, review note, screenshot path or free note. */
export function runDryRunReport(o: DryRunReportOptions): number {
  const opts = parseOptions(o.args);
  if (opts === null) {
    o.err(refusalLine(COMMAND, "invalid arguments") + DRY_RUN_REPORT_USAGE);
    return 1;
  }
  if (opts.batch !== undefined) {
    // Runs are grouped into operator batches by the operator migration, which this build does not have yet.
    o.err(refusalLine(COMMAND, "--batch needs the operator batch table, not available"));
    return 1;
  }
  if (!existsSync(o.dbPath)) {
    o.err(refusalLine(COMMAND, "database not found"));
    return 1;
  }
  let db: Db | undefined;
  try {
    db = openDbReadonly(o.dbPath);
    if (opts.posting !== undefined) {
      const known = db
        .select({ id: postings.id })
        .from(postings)
        .where(eq(postings.id, opts.posting))
        .get();
      if (known === undefined) {
        o.err(refusalLine(COMMAND, "unknown posting"));
        return 1;
      }
    }
    const conds = [
      ...(opts.posting !== undefined ? [eq(dry_runs.posting_id, opts.posting)] : []),
      ...(opts.since !== undefined ? [sql`${dry_runs.started_at} >= ${opts.since}`] : []),
    ];
    const rows = db
      .select(runColumns)
      .from(dry_runs)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(dry_runs.started_at), desc(dry_runs.id))
      .limit(opts.last)
      .all()
      .map((r) => RunRow.parse(r));
    const by = startedByMap(db);
    // Everything is built before anything is printed: a corrupt row prints no partial report.
    const lines = rows.flatMap((r) => runLines(db as Db, view(db as Db, r, by)));
    if (rows.length === 0) o.out("dry-run-report: no runs\n");
    else o.out(`${lines.join("\n")}\n`);
    return 0;
  } catch (e) {
    o.err(errorLine(COMMAND, e));
    return 1;
  } finally {
    db?.$client.close();
  }
}
