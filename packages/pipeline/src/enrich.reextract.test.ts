import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runEnrich, selectOutdated } from "./enrich.ts";
import { EXTRACT_PROMPT_VERSION } from "./intel/extract.ts";
import { FIT_MODEL, FIT_PROMPT_VERSION } from "./intel/fit.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): { content: { type: string; text?: string }[] } =>
  JSON.parse(readFileSync(resolve(here, "../test/fixtures/anthropic", name), "utf-8"));

// The fake persona only (config/*.example.*); never the real config.
const CV = readFileSync(resolve(here, "../../../config/cv.example.md"), "utf-8");
const configDir = mkdtempSync(join(tmpdir(), "job-agent-enrich-reextract-"));
const exampleDir = resolve(here, "../../../config");
copyFileSync(join(exampleDir, "salary.example.yaml"), join(configDir, "salary.yaml"));
copyFileSync(join(exampleDir, "companies.example.yaml"), join(configDir, "companies.yaml"));
const SALARY = loadConfig(configDir).salary;
afterAll(() => rmSync(configDir, { recursive: true, force: true }));

const URL = "https://api.anthropic.com/v1/messages";
const NOW = new Date("2026-10-14T05:00:00Z");
const ENV = { ANTHROPIC_API_KEY: "sk-ant-test-key-0000" };
const OLD_VERSION = "extract-v5";
const DAY = 86_400_000;

type Req = Record<string, unknown>;
let requests: Req[] = [];
/** Extraction fields the next extract response overrides (on top of extract-ok.json). */
let extractOverride: Record<string, unknown> | "invalid" = {};
let onExtract: () => void = () => {};
const server = setupServer(
  http.post(URL, async ({ request }) => {
    const body = (await request.json()) as Req;
    requests.push(body);
    if (body["model"] === FIT_MODEL) return HttpResponse.json(fixture("fit-ok.json"));
    onExtract();
    if (extractOverride === "invalid") return HttpResponse.json(fixture("extract-invalid.json"));
    const x = fixture("extract-ok.json");
    const block = x.content[x.content.length - 1];
    if (block?.text === undefined) throw new Error("fixture shape");
    block.text = JSON.stringify({ ...JSON.parse(block.text), ...extractOverride });
    return HttpResponse.json(x);
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

let db: Db;
let n = 0;
const OLD_EXTRACTION = JSON.stringify({ marker: "old" });

function addPosting(id: string, over: Partial<NewPosting> = {}) {
  n += 1;
  const at = new Date(NOW.getTime() - (100 - n) * 60_000).toISOString();
  db.insert(postings)
    .values({
      id,
      source: "test",
      external_id: id,
      url: `https://example.com/${id}`,
      title: "Senior Frontend Engineer",
      company_name: "Acme Inc",
      description_text:
        "Responsibilities: build the web app. Requirements: experience with React and TypeScript. ".repeat(
          5,
        ),
      first_seen_at: at,
      last_seen_at: at,
      normalized_at: NOW.toISOString(),
      ...over,
    })
    .run();
  db.insert(analysis)
    .values({
      id: `a-${id}`,
      posting_id: id,
      location_class: "worldwide",
      indonesia_rule: "not_applicable",
      salary_status: "unknown",
      decision: "keep",
      analyzed_at: NOW.toISOString(),
    })
    .run();
}

/** A posting stored with an extraction made by an older prompt. */
function addOutdated(
  id: string,
  over: {
    decision?: "keep" | "reject" | "suspicious";
    lastSeenDaysAgo?: number;
    fit?: boolean;
  } = {},
) {
  const seen = new Date(NOW.getTime() - (over.lastSeenDaysAgo ?? 1) * DAY).toISOString();
  addPosting(id, { last_seen_at: seen });
  db.insert(intel)
    .values({
      id: `i-${id}`,
      posting_id: id,
      status: "done",
      extraction: OLD_EXTRACTION,
      extract_model: "claude-haiku-5-5",
      extract_prompt_version: OLD_VERSION,
      final_decision: over.decision ?? "keep",
      ...(over.fit
        ? {
            fit_score: 70,
            fit_reasons: JSON.stringify(["old fit"]),
            fit_model: FIT_MODEL,
            fit_prompt_version: FIT_PROMPT_VERSION,
          }
        : {}),
      updated_at: NOW.toISOString(),
    })
    .run();
}

async function enrich(
  opts: { limit?: number; noReextract?: boolean; reextractOnly?: boolean } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runEnrich({
    db,
    env: ENV,
    salary: SALARY,
    cv: CV,
    now: () => NOW,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    ...opts,
  });
  return { code, out: out.join(""), err: err.join("") };
}

const intelOf = (id: string) => db.select().from(intel).where(eq(intel.posting_id, id)).get();
const fitRequests = () => requests.filter((r) => r["model"] === FIT_MODEL);
const extractRequests = () => requests.filter((r) => r["model"] !== FIT_MODEL);

beforeEach(() => {
  db = openDb(":memory:");
  db.insert(fx_rates)
    .values({
      id: "fx-IDR",
      date: "2026-10-13",
      base: "USD",
      quote: "IDR",
      rate: "17900",
      source: "test",
      fetched_at: "2026-10-13T00:00:00Z",
    })
    .run();
  n = 0;
  requests = [];
  extractOverride = {};
  onExtract = () => {};
});

describe("enrich re-extraction of outdated extractions", () => {
  it("re-extracts an extract-v5 row after the new posting of the same run", async () => {
    addOutdated("old1");
    addPosting("new1");
    const r = await enrich();
    expect(r.code).toBe(0);
    const order = db
      .select()
      .from(llm_calls)
      .all()
      .filter((c) => c.purpose === "extract")
      .map((c) => c.posting_id);
    expect(order).toEqual(["new1", "old1"]);
    const row = intelOf("old1");
    expect(row?.extract_prompt_version).toBe(EXTRACT_PROMPT_VERSION);
    expect(row?.extraction).not.toBe(OLD_EXTRACTION);
    expect(row?.status).toBe("done");
    expect(row?.final_decision).toBe("keep");
    expect(row?.fit_score).not.toBeNull();
    expect(r.out).toContain("re-extracted 1 (decision changes: keep->reject 0, reject->keep 0)\n");
  });

  it("skips a suspicious row and a row last seen 20 days ago (and the 14-day edge is inclusive)", async () => {
    addOutdated("susp", { decision: "suspicious" });
    addOutdated("stale", { lastSeenDaysAgo: 20 });
    addOutdated("edge", { lastSeenDaysAgo: 14 });
    const r = await enrich();
    expect(extractRequests()).toHaveLength(1);
    expect(intelOf("susp")?.extraction).toBe(OLD_EXTRACTION);
    expect(intelOf("stale")?.extraction).toBe(OLD_EXTRACTION);
    expect(intelOf("edge")?.extract_prompt_version).toBe(EXTRACT_PROMPT_VERSION);
    expect(r.out).toContain("re-extracted 1 ");
  });

  it("skips non-canonical postings and rows already on the current version", async () => {
    addPosting("canon");
    addOutdated("dup");
    db.update(postings).set({ canonical_posting_id: "canon" }).where(eq(postings.id, "dup")).run();
    addOutdated("cur");
    db.update(intel)
      .set({ extract_prompt_version: EXTRACT_PROMPT_VERSION })
      .where(eq(intel.posting_id, "cur"))
      .run();
    await enrich();
    // Only the new canonical posting is processed; "dup" and "cur" are not re-extracted.
    expect(extractRequests()).toHaveLength(1);
    expect(intelOf("dup")?.extraction).toBe(OLD_EXTRACTION);
    expect(intelOf("cur")?.extraction).toBe(OLD_EXTRACTION);
  });

  it("a rejected row whose new facts keep it gets a fit call", async () => {
    addOutdated("rej", { decision: "reject" });
    const r = await enrich();
    expect(fitRequests()).toHaveLength(1);
    const row = intelOf("rej");
    expect(row?.final_decision).toBe("keep");
    expect(row?.fit_score).toBe(82);
    expect(row?.tier).not.toBeNull();
    expect(r.out).toContain("(decision changes: keep->reject 0, reject->keep 1)");
  });

  it("a kept row with a current-version fit gets no fit call and keeps the fit", async () => {
    addOutdated("kept", { fit: true });
    await enrich();
    expect(extractRequests()).toHaveLength(1);
    expect(fitRequests()).toHaveLength(0);
    expect(intelOf("kept")?.fit_score).toBe(70);
    expect(intelOf("kept")?.tier).not.toBeNull();
  });

  it("counts keep->reject when the new facts reject, without a fit call", async () => {
    addOutdated("k2r");
    extractOverride = { roleFamily: "backend" };
    const r = await enrich();
    expect(fitRequests()).toHaveLength(0);
    expect(intelOf("k2r")?.final_decision).toBe("reject");
    expect(r.out).toContain("(decision changes: keep->reject 1, reject->keep 0)");
  });

  it("a failed re-extraction keeps the old row as it was", async () => {
    addOutdated("bad");
    const before = intelOf("bad");
    extractOverride = "invalid";
    const r = await enrich();
    expect(r.code).toBe(0);
    expect(intelOf("bad")).toEqual(before);
    expect(r.out).toContain("re-extracted 0 ");
  });

  it("budget exceeded leaves the rest untouched, no status change", async () => {
    for (const id of ["o1", "o2", "o3"]) addOutdated(id);
    onExtract = () => {
      if (extractRequests().length === 1) {
        db.insert(llm_calls)
          .values({
            id: "big",
            day: "2026-10-14",
            model: "claude-haiku-5-5",
            purpose: "extract",
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cost_usd: "0.999999",
            status: "ok",
            created_at: NOW.toISOString(),
          })
          .run();
      }
    };
    const r = await enrich();
    expect(r.code).toBe(0);
    // newest first: o3 is re-extracted (then its fit hits the budget), o2 and o1 stay outdated.
    for (const id of ["o2", "o1"]) {
      expect(intelOf(id)?.status).toBe("done");
      expect(intelOf(id)?.extraction).toBe(OLD_EXTRACTION);
      expect(intelOf(id)?.extract_prompt_version).toBe(OLD_VERSION);
    }
    expect(r.out).toMatch(/budget_wait 1,/);
    expect(extractRequests()).toHaveLength(1);
  });

  it("--limit counts new and outdated postings together", async () => {
    addOutdated("o1");
    addOutdated("o2");
    addPosting("new1");
    await enrich({ limit: 2 });
    expect(extractRequests()).toHaveLength(2);
    expect(intelOf("new1")?.status).toBe("done");
    // o2 is newer than o1 by insertion order
    expect(intelOf("o2")?.extract_prompt_version).toBe(EXTRACT_PROMPT_VERSION);
    expect(intelOf("o1")?.extract_prompt_version).toBe(OLD_VERSION);
  });

  it("--no-reextract leaves outdated rows alone and prints no re-extract line", async () => {
    addOutdated("old1");
    addPosting("new1");
    const r = await enrich({ noReextract: true });
    expect(extractRequests()).toHaveLength(1);
    expect(intelOf("old1")?.extraction).toBe(OLD_EXTRACTION);
    expect(r.out).not.toContain("re-extracted");
  });

  it("--reextract-only skips new postings", async () => {
    addOutdated("old1");
    addPosting("new1");
    const r = await enrich({ reextractOnly: true });
    expect(extractRequests()).toHaveLength(1);
    expect(intelOf("new1")).toBeUndefined();
    expect(intelOf("old1")?.extract_prompt_version).toBe(EXTRACT_PROMPT_VERSION);
    expect(r.out).toContain("re-extracted 1 ");
  });

  it("rejects --no-reextract together with --reextract-only", async () => {
    const r = await enrich({ noReextract: true, reextractOnly: true });
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot be combined");
  });

  it("without a key nothing happens for outdated rows", async () => {
    addOutdated("old1");
    const before = intelOf("old1");
    const out: string[] = [];
    await runEnrich({
      db,
      env: {},
      salary: SALARY,
      cv: CV,
      now: () => NOW,
      out: (t) => out.push(t),
      err: () => {},
    });
    expect(requests).toHaveLength(0);
    expect(intelOf("old1")).toEqual(before);
  });

  it("selectOutdated returns newest first and respects skip ids", () => {
    addOutdated("a");
    addOutdated("b");
    expect(selectOutdated(db, NOW, undefined).map((o) => o.posting.id)).toEqual(["b", "a"]);
    expect(selectOutdated(db, NOW, undefined, ["b"]).map((o) => o.posting.id)).toEqual(["a"]);
    expect(selectOutdated(db, NOW, 1).map((o) => o.posting.id)).toEqual(["b"]);
  });
});
