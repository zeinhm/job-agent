import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { companies, openDb, parseCompaniesYaml, type Db } from "@job-agent/core";
import { normalizeCompanyName } from "../normalize/index.ts";
import { runResolveApply } from "./index.ts";
import { saveFoundAts } from "./save-ats.ts";

const ORIGINAL = `# my list (invented)
companies:
  # keep this comment
  - { name: Alpha Works, ats: greenhouse, slug: alphaworks }  # old note
  - { name: Beta Co, ats: lever, slug: betaco }
`;
const NOW = () => new Date("2026-10-14T12:30:45.123Z");

let root: string;
let cfg: string;
let backups: string;
let db: Db;
let out: string[];
let errs: string[];

type Ats = "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "workable" | "recruitee";
function addCompany(
  name: string,
  ats: Ats,
  slug: string,
  via: "apply_resolve" | "search" = "apply_resolve",
  verified = true,
) {
  db.insert(companies)
    .values({
      id: randomUUID(),
      name,
      normalized_name: normalizeCompanyName(name),
      ats_type: ats,
      ats_slug: slug,
      discovered_via: via,
      verified,
      created_at: NOW().toISOString(),
    })
    .run();
}
const save = () =>
  saveFoundAts({
    db,
    configDir: cfg,
    backupDir: backups,
    now: NOW,
    out: (t) => out.push(t),
    err: (t) => errs.push(t),
  });
const file = () => join(cfg, "companies.yaml");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "save-ats-"));
  cfg = join(root, "config");
  backups = join(root, "data", "backups");
  mkdirSync(cfg);
  writeFileSync(file(), ORIGINAL);
  db = openDb(":memory:");
  out = [];
  errs = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("saveFoundAts", () => {
  it("appends with marker, keeps every existing byte, backs up, and still validates", () => {
    addCompany("Gamma Labs", "ashby", "gammalabs");
    expect(save()).toBe(0);
    const text = readFileSync(file(), "utf8");
    expect(text.startsWith(ORIGINAL)).toBe(true);
    expect(text.slice(ORIGINAL.length)).toBe(
      "  - { name: Gamma Labs, ats: ashby, slug: gammalabs }  # added by job-agent 2026-10-14 (apply resolve)\n",
    );
    expect(parseCompaniesYaml(text).map((c) => c.name)).toEqual([
      "Alpha Works",
      "Beta Co",
      "Gamma Labs",
    ]);
    const backupFile = join(backups, "companies.yaml.2026-10-14T12-30-45Z");
    expect(readFileSync(backupFile, "utf8")).toBe(ORIGINAL);
    expect(out[0]).toBe(`companies.yaml: added 1 (backup ${backupFile})\n`);
    expect(readdirSync(cfg)).toEqual(["companies.yaml"]);
  });

  it("adds a missing trailing newline before appending", () => {
    writeFileSync(file(), ORIGINAL.trimEnd());
    addCompany("Gamma Labs", "ashby", "gammalabs");
    expect(save()).toBe(0);
    expect(readFileSync(file(), "utf8").startsWith(ORIGINAL)).toBe(true);
  });

  it("writes nothing and makes no backup when nothing is new", () => {
    addCompany("Gamma Labs", "ashby", "gammalabs", "search");
    addCompany("Delta", "lever", "delta", "apply_resolve", false);
    expect(save()).toBe(0);
    expect(readFileSync(file(), "utf8")).toBe(ORIGINAL);
    expect(existsSync(backups)).toBe(false);
    expect(out).toEqual([]);
  });

  it("does not add case/punctuation variants of listed names", () => {
    addCompany("ALPHA WORKS, Inc.", "lever", "alpha2");
    addCompany("beta-co", "ashby", "beta2");
    expect(save()).toBe(0);
    expect(readFileSync(file(), "utf8")).toBe(ORIGINAL);
    expect(existsSync(backups)).toBe(false);
  });

  it("round-trips a name with YAML special characters", () => {
    addCompany("Acme: Labs #1", "workable", "acmelabs1");
    addCompany('Zed, "Q" & Co', "recruitee", "zedco");
    expect(save()).toBe(0);
    const names = parseCompaniesYaml(readFileSync(file(), "utf8")).map((c) => c.name);
    expect(names).toContain("Acme: Labs #1");
    expect(names).toContain('Zed, "Q" & Co');
  });

  it("two runs in a row add each company once", () => {
    addCompany("Gamma Labs", "ashby", "gammalabs");
    expect(save()).toBe(0);
    const after1 = readFileSync(file(), "utf8");
    expect(save()).toBe(0);
    expect(readFileSync(file(), "utf8")).toBe(after1);
    expect(readdirSync(backups)).toHaveLength(1);
  });

  it("restores the original and returns 1 when the written file would not validate", () => {
    const flow = "companies: []\n";
    writeFileSync(file(), flow);
    addCompany("Gamma Labs", "ashby", "gammalabs");
    expect(save()).toBe(1);
    expect(readFileSync(file(), "utf8")).toBe(flow);
    expect(readdirSync(cfg)).toEqual(["companies.yaml"]);
    expect(readFileSync(join(backups, readdirSync(backups)[0] ?? ""), "utf8")).toBe(flow);
    expect(errs.join("")).toContain("original kept");
    expect(errs.join("")).not.toContain("Gamma");
  });

  it("does nothing when companies.yaml is missing", () => {
    rmSync(file());
    addCompany("Gamma Labs", "ashby", "gammalabs");
    expect(save()).toBe(0);
    expect(existsSync(file())).toBe(false);
    expect(existsSync(backups)).toBe(false);
    expect(out).toEqual(["companies.yaml: not found, nothing added\n"]);
  });

  it("returns 1 and changes nothing when the existing file is invalid", () => {
    writeFileSync(file(), "companies: nope\n");
    addCompany("Gamma Labs", "ashby", "gammalabs");
    expect(save()).toBe(1);
    expect(readFileSync(file(), "utf8")).toBe("companies: nope\n");
    expect(existsSync(backups)).toBe(false);
  });

  it("touches nothing outside the config dir and the backup dir", () => {
    const sibling = join(root, "sibling");
    mkdirSync(sibling);
    writeFileSync(join(sibling, "salary.yaml"), "x: 1\n");
    chmodSync(join(sibling, "salary.yaml"), 0o444);
    chmodSync(sibling, 0o555);
    const before = statSync(sibling).mtimeMs;
    addCompany("Gamma Labs", "ashby", "gammalabs");
    try {
      expect(save()).toBe(0);
      expect(readdirSync(sibling)).toEqual(["salary.yaml"]);
      expect(readFileSync(join(sibling, "salary.yaml"), "utf8")).toBe("x: 1\n");
      expect(statSync(sibling).mtimeMs).toBe(before);
      expect(readdirSync(root).sort()).toEqual(["config", "data", "sibling"]);
    } finally {
      chmodSync(sibling, 0o755);
    }
  });
});

describe("runResolveApply saveAts", () => {
  it("prints the summary line and returns 1 when the save fails", async () => {
    addCompany("Gamma Labs", "ashby", "gammalabs");
    const lines: string[] = [];
    const code = await runResolveApply({
      db,
      saveAts: { configDir: cfg, backupDir: backups },
      now: NOW,
      out: (t) => lines.push(t),
      err: () => undefined,
    });
    expect(code).toBe(0);
    expect(lines.join("")).toContain("companies.yaml: added 1 (backup ");
    writeFileSync(file(), "companies: []\n");
    addCompany("Epsilon", "lever", "epsilon");
    const bad = await runResolveApply({
      db,
      saveAts: { configDir: cfg, backupDir: backups },
      now: NOW,
      out: () => undefined,
      err: () => undefined,
    });
    expect(bad).toBe(1);
  });
});
