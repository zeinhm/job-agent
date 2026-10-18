import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import {
  defaultDbPath,
  disabledSources,
  fetchAndStoreFx,
  loadConfig,
  loadDisabledSources,
  openDb,
  source_runs,
} from "@job-agent/core";
import { errorLine, importAnswers, loadAnswers, matchQuestions } from "@job-agent/apply";
import { buildAdapters, createLinkedInDetailFetcher } from "@job-agent/sources";
import { loadPollableCompanies, syncConfigCompanies } from "./companies.ts";
import { runResolveApply } from "./apply-links/index.ts";
import { runDigest } from "./digest/index.ts";
import { runDiscover } from "./discover.ts";
import { freshnessSuffix } from "./digest/freshness.ts";
import { runDiscoverCompanies } from "./discover-companies.ts";
import { loadEnvFile } from "./env.ts";
import { runExportReviews } from "./eval/export-reviews.ts";
import { runEnrich } from "./enrich.ts";
import { runFetchDescriptions } from "./fetch-descriptions.ts";
import { runFetchQuestions } from "./questions/index.ts";
import { runProcess } from "./process.ts";
import { runReprocess } from "./reprocess.ts";
import { computeDayStats, formatStats, isDigestDate, jakartaDate } from "./review/index.ts";
import {
  DRY_RUN_USAGE,
  OPERATOR_DRY_RUN_USAGE,
  describeError as describeDryRunError,
  runDryRun,
  runOperatorDryRun,
} from "./dry-run.ts";
import { runDryRunCandidates, type CandidatesArgs } from "./dry-run-candidates.ts";
import { runDryRunReport, type RawArgs } from "./dry-run-report.ts";
import { refusalReason, runSeedDemo } from "./seed-demo.ts";

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

type Command = (args: string[], io: Io) => Promise<number> | number;

const commands: Record<string, Command> = {
  discover: async (args, io) => {
    const { values } = parseArgs({
      args,
      options: { source: { type: "string" }, force: { type: "boolean", default: false } },
    });
    const db = openDb(defaultDbPath());
    try {
      const config = loadConfig();
      syncConfigCompanies(db, config);
      return await runDiscover({
        db,
        adapters: buildAdapters(config, loadPollableCompanies(db)),
        disabled: disabledSources(config),
        source: values.source,
        force: values.force,
        out: io.out,
        err: io.err,
      });
    } finally {
      db.$client.close();
    }
  },
  "discover-companies": async (_args, io) => {
    const db = openDb(defaultDbPath());
    try {
      return await runDiscoverCompanies({ db, out: io.out, err: io.err });
    } finally {
      db.$client.close();
    }
  },
  enrich: async (args, io) => {
    let limit: number | undefined;
    let noReextract = false;
    let reextractOnly = false;
    try {
      const { values } = parseArgs({
        args,
        options: {
          limit: { type: "string" },
          "no-reextract": { type: "boolean", default: false },
          "reextract-only": { type: "boolean", default: false },
        },
      });
      if (values.limit !== undefined) limit = Number(values.limit);
      noReextract = values["no-reextract"] === true;
      reextractOnly = values["reextract-only"] === true;
    } catch (e) {
      io.err(`enrich: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    let salary;
    try {
      salary = loadConfig().salary;
    } catch (e) {
      io.err(`enrich: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    const db = openDb(defaultDbPath());
    try {
      return await runEnrich({
        db,
        salary,
        limit,
        noReextract,
        reextractOnly,
        out: io.out,
        err: io.err,
      });
    } finally {
      db.$client.close();
    }
  },
  "fetch-descriptions": async (args, io) => {
    try {
      // --force is accepted like on `discover` and changes nothing: the linkedin block backoff holds with it too.
      parseArgs({ args, options: { force: { type: "boolean", default: false } } });
    } catch (e) {
      io.err(`fetch-descriptions: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    const db = openDb(defaultDbPath());
    try {
      return await runFetchDescriptions({
        db,
        fetchDescription: createLinkedInDetailFetcher(),
        out: io.out,
        err: io.err,
      });
    } finally {
      db.$client.close();
    }
  },
  "resolve-apply": async (args, io) => {
    let limit: number | undefined;
    try {
      const { values } = parseArgs({ args, options: { limit: { type: "string" } } });
      if (values.limit !== undefined) limit = Number(values.limit);
    } catch (e) {
      io.err(`resolve-apply: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    const db = openDb(defaultDbPath());
    try {
      return await runResolveApply({
        db,
        limit,
        saveAts: {
          configDir: process.env["JOB_AGENT_CONFIG_DIR"] ?? "config",
          backupDir: join(dirname(defaultDbPath()), "backups"),
        },
        out: io.out,
        err: io.err,
      });
    } finally {
      db.$client.close();
    }
  },
  "fetch-questions": async (args, io) => {
    let limit: number | undefined;
    try {
      const { values } = parseArgs({ args, options: { limit: { type: "string" } } });
      if (values.limit !== undefined) limit = Number(values.limit);
    } catch (e) {
      io.err(`fetch-questions: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    const db = openDb(defaultDbPath());
    try {
      return await runFetchQuestions({ db, limit, out: io.out, err: io.err });
    } finally {
      db.$client.close();
    }
  },
  "match-questions": (args, io) => {
    if (args.length > 0) {
      io.err("Usage: job-agent match-questions\n");
      return 1;
    }
    const db = openDb(defaultDbPath());
    try {
      const m = matchQuestions(db);
      io.out(
        `match-questions: ${m.questions} questions, ${m.covered} covered, ${m.needsMapping} need a choice mapping, ${m.salary} salary, ${m.unknown} unknown (${m.unknownWordings} wordings), ${m.changed} changed\n`,
      );
      return 0;
    } finally {
      db.$client.close();
    }
  },
  process: (args, io) => {
    let reprocess = false;
    try {
      const { values } = parseArgs({
        args,
        options: { reprocess: { type: "boolean", default: false } },
      });
      reprocess = values.reprocess === true;
    } catch (e) {
      io.err(`process: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    const db = openDb(defaultDbPath());
    try {
      const code = runProcess({ db, out: io.out, err: io.err });
      if (!reprocess) return code;
      return Math.max(code, runReprocess({ db, out: io.out, err: io.err }));
    } finally {
      db.$client.close();
    }
  },
  digest: (args, io) => {
    const { values } = parseArgs({
      args,
      options: {
        date: { type: "string" },
        "out-dir": { type: "string" },
        "include-unpaid": { type: "boolean" },
      },
    });
    const db = openDb(defaultDbPath());
    try {
      runDigest({
        disabledSources: loadDisabledSources(),
        ...(values["include-unpaid"] === true ? { includeUnpaid: true } : {}),
        db,
        ...(values.date !== undefined ? { date: values.date } : {}),
        ...(values["out-dir"] !== undefined ? { outDir: values["out-dir"] } : {}),
        out: io.out,
      });
      return 0;
    } catch (e) {
      io.err(`digest failed: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    } finally {
      db.$client.close();
    }
  },
  "eval-export-reviews": (args, io) => {
    const db = openDb(defaultDbPath());
    try {
      return runExportReviews({
        args,
        db,
        repoRoot: join(dirname(fileURLToPath(import.meta.url)), "../../.."),
        out: io.out,
        err: io.err,
      });
    } finally {
      db.$client.close();
    }
  },
  "review-stats": (args, io) => {
    let date: string | undefined;
    try {
      date = parseArgs({ args, options: { date: { type: "string" } } }).values.date;
      if (date !== undefined && !isDigestDate(date)) throw new Error(`invalid --date ${date}`);
    } catch (e) {
      io.err(`review-stats: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    const db = openDb(defaultDbPath());
    try {
      io.out(formatStats(computeDayStats(db, date ?? jakartaDate(new Date()))));
      return 0;
    } finally {
      db.$client.close();
    }
  },
  "dry-run": async (args, io) => {
    let parsed;
    try {
      parsed = parseArgs({
        args,
        allowPositionals: true,
        options: { headless: { type: "boolean", default: false }, fixture: { type: "string" } },
      });
    } catch {
      // The parser's message quotes what was typed: print fixed text only.
      io.err(`dry-run: refused: invalid arguments\n${DRY_RUN_USAGE}`);
      return 1;
    }
    let dbPath: string;
    let db;
    try {
      dbPath = defaultDbPath();
      db = openDb(dbPath);
    } catch (e) {
      io.err(describeDryRunError(e));
      return 1;
    }
    try {
      return await runDryRun({
        positionals: parsed.positionals,
        fixture: parsed.values.fixture,
        headless: parsed.values.headless === true,
        db,
        dbPath,
        // The same test seed-demo uses: the default DB or one under data/ is the owner's real database.
        isRealDb: refusalReason(process.env["JOB_AGENT_DB"]) !== null,
        out: io.out,
        err: io.err,
      });
    } finally {
      db.$client.close();
    }
  },
  "operator-dry-run": async (args, io) => {
    let positionals: string[];
    try {
      // No option exists: the run is always headed and always on the real database.
      positionals = parseArgs({ args, allowPositionals: true, options: {} }).positionals;
    } catch {
      io.err(`operator-dry-run: refused: invalid arguments\n${OPERATOR_DRY_RUN_USAGE}`);
      return 2;
    }
    let dbPath: string;
    let db;
    try {
      dbPath = defaultDbPath();
      db = openDb(dbPath);
    } catch (e) {
      io.err(errorLine("operator-dry-run", e));
      return 1;
    }
    try {
      return await runOperatorDryRun({
        positionals,
        db,
        dbPath,
        isRealDb: refusalReason(process.env["JOB_AGENT_DB"]) !== null,
        out: io.out,
        err: io.err,
      });
    } finally {
      db.$client.close();
    }
  },
  "dry-run-report": (args, io) => {
    let parsed: RawArgs | null = null;
    try {
      parsed = parseArgs({
        args,
        allowPositionals: true,
        options: {
          batch: { type: "string" },
          posting: { type: "string" },
          since: { type: "string" },
          last: { type: "string" },
        },
      });
    } catch {
      // The parser's message quotes what was typed: runDryRunReport prints fixed text only.
    }
    return runDryRunReport({ args: parsed, dbPath: defaultDbPath(), out: io.out, err: io.err });
  },
  "dry-run-candidates": (args, io) => {
    let parsed: CandidatesArgs | null = null;
    try {
      parsed = parseArgs({
        args,
        allowPositionals: true,
        options: { limit: { type: "string" } },
      });
    } catch {
      // The parser's message quotes what was typed: runDryRunCandidates prints fixed text only.
    }
    return runDryRunCandidates({ args: parsed, dbPath: defaultDbPath(), out: io.out, err: io.err });
  },
  "seed-demo": (args, io) => {
    let date: string | undefined;
    try {
      date = parseArgs({ args, options: { date: { type: "string" } } }).values.date;
    } catch (e) {
      io.err(`seed-demo: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    return runSeedDemo({
      dbEnv: process.env["JOB_AGENT_DB"],
      ...(date !== undefined ? { date } : {}),
      openDb: () => openDb(defaultDbPath()),
      out: io.out,
      err: io.err,
    });
  },
  status: (_args, io) => {
    const db = openDb(defaultDbPath());
    try {
      const tables = db
        .all<{
          name: string;
        }>(sql`select name from sqlite_master where type = 'table' order by name`)
        .filter(({ name }) => !name.startsWith("sqlite_") && !name.startsWith("__"));
      io.out("row counts\n");
      for (const { name } of tables) {
        const row = db.get<{ n: number }>(sql.raw(`select count(*) as n from "${name}"`));
        io.out(`  ${name}: ${row.n}\n`);
      }
      // Latest run per source; started_at is ISO so string order is time order.
      const runs = db.select().from(source_runs).orderBy(source_runs.started_at).all();
      const latest = new Map(runs.map((r) => [r.source, r]));
      io.out("source status (latest run)\n");
      const disabled = loadDisabledSources();
      for (const r of [...latest.values()].sort((a, b) => a.source.localeCompare(b.source))) {
        if (disabled.includes(r.source)) {
          io.out(`  ${r.source}: disabled\n`);
          continue;
        }
        const detail = r.error_message ? `, ${r.error_message}` : "";
        const fresh = freshnessSuffix(db, r.source, new Date());
        io.out(
          `  ${r.source}: ${r.status}, found ${r.found}, new ${r.new}${detail}${fresh !== undefined ? ` — ${fresh}` : ""}\n`,
        );
      }
      return 0;
    } finally {
      db.$client.close();
    }
  },
  answers: (args, io) => {
    if (args[0] !== "import" || args.length !== 1) {
      io.err("Usage: job-agent answers import\n");
      return 1;
    }
    const db = openDb(defaultDbPath());
    try {
      const entries = loadAnswers(process.env["JOB_AGENT_CONFIG_DIR"] ?? "config", (l) =>
        io.out(`${l}\n`),
      );
      importAnswers(db, entries, (l) => io.out(`${l}\n`));
      return 0;
    } catch (e) {
      io.err(`answers import failed: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    } finally {
      db.$client.close();
    }
  },
  fx: async (_args, io) => {
    const db = openDb(defaultDbPath());
    try {
      const rows = await fetchAndStoreFx(db);
      for (const r of rows) io.out(`${r.date} USD/${r.quote} ${r.rate}\n`);
      return 0;
    } catch (e) {
      io.err(`fx failed: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    } finally {
      db.$client.close();
    }
  },
};

const usage = (): string =>
  `Usage: job-agent <command> [options]\n\nCommands:\n${
    Object.keys(commands)
      .map((name) => `  ${name}`)
      .join("\n") || "  (none yet)"
  }\n\nOptions:\n  process --reprocess  re-apply the current rules and resolve to every stored posting (no LLM call)\n  dry-run <posting-id> [--headless]  fill the posting's Greenhouse, Lever or Ashby form and screenshot it; never submits (owner-run, headed by default)\n  dry-run --fixture greenhouse|lever|ashby  the same on the committed fixture form (127.0.0.1, fake persona, scratch DB only)\n  operator-dry-run <batch-id> <posting-id>  agent-only: the same real-form run, always headed, with the batch limits, the shared lock and the CAPTCHA halt enforced (real DB only)\n  dry-run-report [--batch <id>] [--posting <id>] [--since <ISO date>] [--last <n>]  read-only, value-free report of recent dry runs with a regression flag\n  dry-run-candidates [--limit <n>]  read-only list of the postings worth a real dry run, nearest to a full fill first (ids, ATS, title, counts; no values)\n`;

export async function main(
  argv: string[],
  io: Io = {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
  },
): Promise<number> {
  // The command is the first argument; the rest (flags with values) belongs to the command's own parser.
  const [name, ...rest] = argv;
  const command = name === undefined ? undefined : commands[name];
  if (name === undefined || command === undefined) {
    if (name !== undefined) io.err(`Unknown command: ${name}\n`);
    io.err(usage());
    return 1;
  }
  return command(rest, io);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Before any command, so cron needs no keys in the crontab. Not inside main(): tests call main() and must not read a real .env.
  loadEnvFile((t) => process.stderr.write(t));
  process.exitCode = await main(process.argv.slice(2));
}
