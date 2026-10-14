import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, eq, isNotNull } from "drizzle-orm";
import { companies, log, parseCompaniesYaml, type Db } from "@job-agent/core";
import { cleanLine, normalizeCompanyName } from "../normalize/index.ts";

const FILE = "companies.yaml";

export interface SaveAtsOptions {
  db: Db;
  /** Directory holding `companies.yaml` (`JOB_AGENT_CONFIG_DIR`). */
  configDir: string;
  /** Where `companies.yaml.<timestamp>` copies go (default: `backups/` next to the DB file). */
  backupDir: string;
  now?: () => Date;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

/** Plain YAML scalar when it is certainly safe inside a flow mapping, else a double-quoted one. */
function scalar(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 .&'_-]*$/.test(value) && !/\s$/.test(value)
    ? value
    : JSON.stringify(value);
}

/**
 * Appends the ATS boards that resolve-apply found (`discovered_via = apply_resolve`, verified) to `companies.yaml`.
 * Append-only: existing bytes are never changed. Returns the command's exit code contribution (0 or 1).
 */
export function saveFoundAts(opts: SaveAtsOptions): number {
  const out = opts.out ?? (() => undefined);
  const err = opts.err ?? (() => undefined);
  const now = (opts.now ?? (() => new Date()))();
  const path = join(opts.configDir, FILE);

  let original: string;
  try {
    original = readFileSync(path, "utf8");
  } catch {
    out(`${FILE}: not found, nothing added\n`);
    return 0;
  }

  let existing;
  try {
    existing = parseCompaniesYaml(original);
  } catch (e) {
    log.error("companies.yaml unreadable, nothing added", { file: FILE });
    err(`${FILE}: ${e instanceof Error ? e.message : String(e)}; nothing added\n`);
    return 1;
  }
  const known = new Set(existing.map((c) => normalizeCompanyName(cleanLine(c.name))));

  const rows = foundAtsRows(opts.db);
  const added: Array<{ name: string; ats: string; slug: string }> = [];
  for (const r of rows) {
    const name = cleanLine(r.name);
    const key = normalizeCompanyName(name);
    if (key === "" || name === "" || known.has(key)) continue;
    known.add(key);
    added.push({ name, ats: r.ats_type, slug: r.ats_slug });
  }
  if (added.length === 0) return 0;

  const date = now.toISOString().slice(0, 10);
  const stamp = now
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replace(/:/g, "-");
  const lines = added.map(
    (c) =>
      `  - { name: ${scalar(c.name)}, ats: ${c.ats}, slug: ${scalar(c.slug)} }  # added by job-agent ${date} (apply resolve)\n`,
  );
  const updated = (original.endsWith("\n") ? original : original + "\n") + lines.join("");

  const backup = join(opts.backupDir, `${FILE}.${stamp}`);
  const tmp = join(dirname(path), `.${FILE}.${process.pid}.tmp`);
  try {
    mkdirSync(opts.backupDir, { recursive: true });
    copyFileSync(path, backup);
    writeFileSync(tmp, updated);
    const parsed = parseCompaniesYaml(readFileSync(tmp, "utf8"));
    if (parsed.length !== existing.length + added.length) {
      throw new Error(`Config file ${FILE} entry count changed unexpectedly`);
    }
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    log.error("companies.yaml update failed, original kept", { file: FILE });
    err(`${FILE}: update failed, original kept (${e instanceof Error ? e.message : String(e)})\n`);
    return 1;
  }
  out(`${FILE}: added ${added.length} (backup ${backup})\n`);
  for (const c of added) out(`  + ${c.name} (${c.ats}/${c.slug})\n`);
  return 0;
}

function foundAtsRows(db: Db) {
  return db
    .select({ name: companies.name, ats_type: companies.ats_type, ats_slug: companies.ats_slug })
    .from(companies)
    .where(
      and(
        eq(companies.discovered_via, "apply_resolve"),
        eq(companies.verified, true),
        isNotNull(companies.ats_type),
        isNotNull(companies.ats_slug),
      ),
    )
    .orderBy(companies.normalized_name)
    .all()
    .flatMap((r) =>
      r.ats_type !== null && r.ats_slug !== null
        ? [{ name: r.name, ats_type: r.ats_type, ats_slug: r.ats_slug }]
        : [],
    );
}
