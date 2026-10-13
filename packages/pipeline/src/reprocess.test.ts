import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import {
  analysis,
  fx_rates,
  intel,
  llm_calls,
  loadConfig,
  openDb,
  postings,
  type Db,
  type NewPosting,
} from "@job-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli.ts";
import { selectPostings } from "./enrich.ts";
import { ExtractionSchema, type Extraction } from "./intel/extract.ts";
import { runProcess } from "./process.ts";
import { runReprocess } from "./reprocess.ts";

const NOW = new Date("2026-10-07T03:00:00Z");
const exampleDir = join(dirname(fileURLToPath(import.meta.url)), "../../../config");
const configDir = mkdtempSync(join(tmpdir(), "job-agent-reprocess-"));
copyFileSync(join(exampleDir, "salary.example.yaml"), join(configDir, "salary.yaml"));
copyFileSync(join(exampleDir, "companies.example.yaml"), join(configDir, "companies.yaml"));
const SALARY = loadConfig(configDir).salary;

const EXTRACTION: Extraction = ExtractionSchema.parse({
  listedSalary: null,
  listedSalaryScope: null,
  hiringScope: null,
  regions: [],
  remoteRegions: [],
  allowedCountries: [],
  indonesiaExplicit: null,
  companyHq: null,
  companyType: null,
  payPolicy: null,
  employment: null,
  eorProvider: null,
  seniority: null,
  roleFamily: null,
  contactChannels: [],
  personalEmailDomain: null,
  asksForPaymentOrId: null,
  repoAssessmentEarly: null,
  urgencyLanguage: null,
  vagueDescription: null,
});

let db: Db;
let n = 0;
const DIGESTED = "2026-10-03T00:00:00.000Z";

function add(id: string, over: Partial<NewPosting> = {}) {
  n += 1;
  db.insert(postings)
    .values({
      id,
      source: "test",
      external_id: id,
      url: `https://example.com/${id}`,
      title: "Senior Frontend Engineer",
      company_name: `Company ${id}`,
      location_text: "Worldwide",
      remote: true,
      description_text: "Build things with React.",
      first_seen_at: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
      last_seen_at: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
      normalized_at: NOW.toISOString(),
      ...over,
    })
    .run();
}

/** An analysis row as an older rule set left it. */
function oldAnalysis(id: string, decision: "keep" | "reject", digestedAt: string | null = null) {
  db.insert(analysis)
    .values({
      id: `a-${id}`,
      posting_id: id,
      location_class: "worldwide",
      indonesia_rule: "not_applicable",
      salary_status: "unknown",
      decision,
      flags: "[]",
      reasons: "[]",
      analyzed_at: "2026-10-02T00:00:00.000Z",
      digested_at: digestedAt,
    })
    .run();
}

function addIntel(
  id: string,
  over: Partial<typeof intel.$inferInsert> = {},
  x: Partial<Extraction> = {},
) {
  db.insert(intel)
    .values({
      id: `i-${id}`,
      posting_id: id,
      status: "done",
      extraction: JSON.stringify({ ...EXTRACTION, ...x }),
      extract_prompt_version: "old",
      final_decision: "keep",
      resolved_reasons: "[]",
      scam_score: 5,
      fit_score: 80,
      fit_prompt_version: "old",
      updated_at: "2026-10-02T00:00:00.000Z",
      ...over,
    })
    .run();
}

const analysisOf = (id: string) =>
  db.select().from(analysis).where(eq(analysis.posting_id, id)).get();
const intelOf = (id: string) => db.select().from(intel).where(eq(intel.posting_id, id)).get();

function reprocess() {
  const out: string[] = [];
  const err: string[] = [];
  const code = runReprocess({
    db,
    salary: SALARY,
    floorIdrMonth: 10_000_000,
    now: () => NOW,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  return { code, out: out.join(""), err: err.join("") };
}

beforeEach(() => {
  db = openDb(":memory:");
  n = 0;
  db.insert(fx_rates)
    .values({
      id: "fx1",
      date: "2026-10-06",
      base: "USD",
      quote: "IDR",
      rate: "16000",
      source: "test",
      fetched_at: NOW.toISOString(),
    })
    .run();
});

afterEach(() => vi.unstubAllGlobals());

describe("runReprocess: rules", () => {
  it("rejects old keeps with the current rule and keeps digested_at", () => {
    add("german", { title: "Senior Frontend Entwickler (m/w/d)" });
    oldAnalysis("german", "keep", DIGESTED);
    add("place", { location_text: "Berlin, Germany", remote: null });
    oldAnalysis("place", "keep");
    const r = reprocess();
    expect(r.code).toBe(0);
    for (const id of ["german", "place"]) expect(analysisOf(id)?.decision).toBe("reject");
    expect(analysisOf("german")?.reasons).toContain("language:");
    expect(analysisOf("place")?.location_class).toBe("restricted");
    expect(analysisOf("german")?.digested_at).toBe(DIGESTED);
    expect(analysisOf("german")?.analyzed_at).toBe(NOW.toISOString());
    expect(r.out).toContain("rules keep->reject 2, reject->keep 0");
  });

  it("keeps a posting the current rules keep, and enrich selects it when it has no intel row", () => {
    add("revived");
    oldAnalysis("revived", "reject");
    expect(selectPostings(db, undefined)).toHaveLength(0);
    const r = reprocess();
    expect(analysisOf("revived")?.decision).toBe("keep");
    expect(selectPostings(db, undefined).map((p) => p.id)).toEqual(["revived"]);
    expect(r.out).toBe(
      "reprocessed 1 postings: rules keep->reject 0, reject->keep 1; resolve keep->reject 0, reject->keep 0; now pending for enrich 1\n",
    );
  });

  it("ignores non-canonical and unnormalized postings and never deletes rows", () => {
    add("canon");
    oldAnalysis("canon", "keep");
    add("dupe", { canonical_posting_id: "canon" });
    add("raw", { normalized_at: null });
    reprocess();
    expect(db.select().from(postings).all()).toHaveLength(3);
    expect(db.select().from(analysis).all()).toHaveLength(1);
  });
});

describe("runReprocess: intel", () => {
  it("rejects a kept, fit-scored design posting with the family reason", () => {
    add("design");
    oldAnalysis("design", "keep");
    addIntel("design", {}, { roleFamily: "design" });
    const r = reprocess();
    const row = intelOf("design");
    expect(row?.final_decision).toBe("reject");
    expect(JSON.parse(row?.resolved_reasons ?? "[]")).toEqual([
      expect.stringContaining("design role, outside the target"),
    ]);
    expect(row?.fit_score).toBe(80); // paid data stays
    expect(row?.extraction).not.toBeNull();
    expect(r.out).toContain("resolve keep->reject 1, reject->keep 0");
  });

  it("leaves suspicious rows unchanged", () => {
    add("scam");
    oldAnalysis("scam", "keep");
    addIntel("scam", { final_decision: "suspicious", fit_score: null }, { roleFamily: "design" });
    const before = intelOf("scam");
    reprocess();
    expect(intelOf("scam")).toEqual(before);
  });

  it("moves a reject to keep: pending without a fit score, done with tier when fit-scored", () => {
    add("nofit");
    oldAnalysis("nofit", "keep");
    addIntel(
      "nofit",
      { final_decision: "reject", fit_score: null, scam_score: null },
      { roleFamily: "frontend" },
    );
    add("fit");
    oldAnalysis("fit", "keep");
    addIntel(
      "fit",
      { final_decision: "reject", resolved_reasons: '["old"]' },
      { roleFamily: "frontend" },
    );
    const r = reprocess();
    const nofit = intelOf("nofit");
    expect(nofit?.status).toBe("pending");
    expect(nofit?.final_decision).toBeNull();
    expect(nofit?.extraction).not.toBeNull();
    expect(selectPostings(db, undefined).map((p) => p.id)).toEqual(["nofit"]);
    const fit = intelOf("fit");
    expect(fit?.final_decision).toBe("keep");
    expect(fit?.status).toBe("done");
    expect(fit?.tier).not.toBeNull();
    expect(r.out).toContain("resolve keep->reject 0, reject->keep 2; now pending for enrich 1");
  });

  it("a rule reject also rejects the intel row and keeps its paid data", () => {
    add("german", { title: "Senior Frontend Entwickler (m/w/d)" });
    oldAnalysis("german", "keep");
    addIntel("german", {}, { roleFamily: "frontend" });
    reprocess();
    expect(intelOf("german")?.final_decision).toBe("reject");
    expect(intelOf("german")?.fit_score).toBe(80);
  });
});

describe("runReprocess: guarantees", () => {
  function seed() {
    add("german", { title: "Senior Frontend Entwickler (m/w/d)" });
    oldAnalysis("german", "keep", DIGESTED);
    add("revived");
    oldAnalysis("revived", "reject");
    add("design");
    oldAnalysis("design", "keep");
    addIntel("design", {}, { roleFamily: "design" });
    add("nofit");
    oldAnalysis("nofit", "keep");
    addIntel(
      "nofit",
      { final_decision: "reject", fit_score: null, scam_score: null },
      { roleFamily: "frontend" },
    );
  }

  it("makes no HTTP request and no llm_calls row, without an API key", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const fetchSpy = vi.fn(() => Promise.reject(new Error("network call")));
    vi.stubGlobal("fetch", fetchSpy);
    seed();
    expect(reprocess().code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.select().from(llm_calls).all()).toHaveLength(0);
    vi.unstubAllEnvs();
  });

  it("is idempotent: the second run reports 0 changes and writes nothing", () => {
    seed();
    reprocess();
    const snapshot = JSON.stringify([
      db.select().from(analysis).all(),
      db.select().from(intel).all(),
    ]);
    const second = reprocess();
    expect(second.out).toBe(
      "reprocessed 4 postings: rules keep->reject 0, reject->keep 0; resolve keep->reject 0, reject->keep 0; now pending for enrich 0\n",
    );
    expect(JSON.stringify([db.select().from(analysis).all(), db.select().from(intel).all()])).toBe(
      snapshot,
    );
  });

  it("reports a failing posting, continues with the rest and returns 1", () => {
    add("bad");
    oldAnalysis("bad", "keep");
    addIntel("bad", {}, { roleFamily: "design" });
    db.update(intel).set({ extraction: "{" }).where(eq(intel.posting_id, "bad")).run();
    add("revived");
    oldAnalysis("revived", "reject");
    const r = reprocess();
    expect(r.code).toBe(1);
    expect(r.err).toContain("reprocess: posting bad failed");
    expect(analysisOf("revived")?.decision).toBe("keep");
    expect(r.out).toContain("reprocessed 1 postings");
    expect(r.out).toContain("failed 1");
  });
});

describe("process command", () => {
  function withDb() {
    vi.stubEnv("JOB_AGENT_CONFIG_DIR", configDir);
    vi.stubEnv("JOB_AGENT_DB", ":memory:");
  }
  afterEach(() => vi.unstubAllEnvs());

  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) } };
  }

  it("runs the normal summary then the reprocess line with --reprocess", async () => {
    withDb();
    const c = capture();
    expect(await main(["process", "--reprocess"], c.io)).toBe(0);
    expect(c.out.join("")).toMatch(
      /^processed 0, kept 0.*\nreprocessed 0 postings: rules keep->reject 0/,
    );
  });

  it("plain process prints no reprocess line", async () => {
    withDb();
    const c = capture();
    expect(await main(["process"], c.io)).toBe(0);
    expect(c.out.join("")).not.toContain("reprocessed");
  });

  it("rejects unknown flags and lists --reprocess in the usage text", async () => {
    withDb();
    const c = capture();
    expect(await main(["process", "--bogus"], c.io)).toBe(1);
    expect(c.err.join("")).toContain("process:");
    const u = capture();
    await main([], u.io);
    expect(u.err.join("")).toContain("process --reprocess");
  });

  it("process alone still analyses only new postings (runProcess untouched)", () => {
    add("x");
    oldAnalysis("x", "reject");
    const out: string[] = [];
    runProcess({
      db,
      floorIdrMonth: 10_000_000,
      now: () => NOW,
      out: (t) => out.push(t),
      err: () => {},
    });
    expect(analysisOf("x")?.decision).toBe("reject");
  });
});
