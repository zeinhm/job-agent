import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import {
  fx_rates,
  analysis,
  intel,
  llm_calls,
  loadConfig,
  loadCv,
  openDb,
  postings,
  type Db,
  type NewPosting,
} from "@job-agent/core";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runEnrich } from "./enrich.ts";
import { runDigest } from "./digest/index.ts";
import {
  failedFitRuns,
  FIT_MAX_TOKENS,
  FIT_MODEL,
  FIT_PROMPT_VERSION,
  FitSchema,
  normalizeFit,
  truncateReason,
} from "./intel/fit.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(here, "../test/fixtures/anthropic", name), "utf-8"));

// The fake persona only (config/cv.example.md); never the real config/cv.md.
const CV = readFileSync(resolve(here, "../../../config/cv.example.md"), "utf-8");

// Numbers of config/salary.example.yaml (fake persona), through the real loader.
const configDir = mkdtempSync(join(tmpdir(), "job-agent-enrich-fit-"));
const exampleDir = resolve(here, "../../../config");
copyFileSync(join(exampleDir, "salary.example.yaml"), join(configDir, "salary.yaml"));
copyFileSync(join(exampleDir, "companies.example.yaml"), join(configDir, "companies.yaml"));
const SALARY = loadConfig(configDir).salary;
afterAll(() => rmSync(configDir, { recursive: true, force: true }));

const URL = "https://api.anthropic.com/v1/messages";
const NOW = new Date("2026-10-09T05:00:00Z");
const ENV = { ANTHROPIC_API_KEY: "sk-ant-test-key-0000" };

type Req = Record<string, unknown>;
let requests: Req[] = [];
let fitResponse = "fit-ok.json";
let extractResponse = "extract-ok.json";
const server = setupServer(
  http.post(URL, async ({ request }) => {
    const body = (await request.json()) as Req;
    requests.push(body);
    return HttpResponse.json(fixture(body["model"] === FIT_MODEL ? fitResponse : extractResponse));
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

let db: Db;
let n = 0;

function addPosting(id: string, over: Partial<NewPosting> = {}) {
  n += 1;
  db.insert(postings)
    .values({
      id,
      source: "test",
      external_id: id,
      url: `https://example.com/${id}`,
      title: "Senior Frontend Engineer",
      company_name: "Acme Inc",
      description_text:
        "Responsibilities: build the web app. Requirements: experience with React and TypeScript. " +
        "You will work with a small team on the product stack and ship weekly. ".repeat(4),
      first_seen_at: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
      last_seen_at: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
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

async function enrich(cv: string | null = CV) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runEnrich({
    db,
    env: ENV,
    salary: SALARY,
    cv,
    now: () => NOW,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  return { code, out: out.join(""), err: err.join("") };
}

const intelOf = (id: string) => db.select().from(intel).where(eq(intel.posting_id, id)).get();
const fitRequests = () => requests.filter((r) => r["model"] === FIT_MODEL);
const extractRequests = () => requests.filter((r) => r["model"] !== FIT_MODEL);

/** Everything written to stdout / stderr while `fn` runs (the logger writes JSON lines there). */
async function captureLogs(fn: () => Promise<unknown>): Promise<string> {
  const captured: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  const grab = ((c: string | Uint8Array) => (captured.push(String(c)), true)) as never;
  process.stdout.write = grab;
  process.stderr.write = grab;
  try {
    await fn();
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  return captured.join("");
}

beforeEach(() => {
  db = openDb(":memory:");
  db.insert(fx_rates)
    .values({
      id: "fx-IDR",
      date: "2026-10-08",
      base: "USD",
      quote: "IDR",
      rate: "17900",
      source: "test",
      fetched_at: "2026-10-08T00:00:00Z",
    })
    .run();
  n = 0;
  requests = [];
  fitResponse = "fit-ok.json";
  extractResponse = "extract-ok.json";
});
afterEach(() => server.resetHandlers());

describe("enrich fit stage", () => {
  it("scores a kept posting: score, reasons, model and prompt version are stored", async () => {
    addPosting("p1");
    const r = await enrich();
    expect(r.code).toBe(0);
    expect(fitRequests()).toHaveLength(1);
    const row = intelOf("p1");
    expect(row?.status).toBe("done");
    expect(row?.final_decision).toBe("keep");
    expect(row?.fit_score).toBe(82);
    expect(JSON.parse(row?.fit_reasons ?? "[]")).toEqual([
      "Strong React and TypeScript match for the core stack",
      "No evidence of GraphQL, which the role lists",
    ]);
    expect(row?.fit_model).toBe("claude-sonnet-5-5");
    expect(row?.fit_prompt_version).toBe(FIT_PROMPT_VERSION);
    const calls = db.select().from(llm_calls).all();
    expect(calls.map((c) => c.purpose).sort()).toEqual(["extract", "fit"]);
  });

  it("only keep postings are scored: suspicious and rejected postings make 0 fit requests", async () => {
    addPosting("scam", {
      description_text:
        "Remote assistant. A registration fee is required to secure your position. " +
        "Message us on Telegram to start. Responsibilities and requirements follow. ".repeat(5),
    });
    addPosting("midlevel");
    db.update(analysis)
      .set({ flags: JSON.stringify(["role_unclear"]) })
      .where(eq(analysis.posting_id, "midlevel"))
      .run();
    const mid = fixture("extract-ok.json") as { content: { type: string; text?: string }[] };
    // "midlevel" must be rejected by resolve: use a mid-seniority extraction for every posting, then
    // check that the clean-but-unflagged "scam" posting is the suspicious one and "midlevel" the rejected one.
    const block = mid.content[mid.content.length - 1];
    if (block?.text === undefined) throw new Error("fixture shape");
    block.text = JSON.stringify({ ...JSON.parse(block.text), seniority: "mid" });
    server.use(
      http.post(URL, async ({ request }) => {
        const body = (await request.json()) as Req;
        requests.push(body);
        return HttpResponse.json(body["model"] === FIT_MODEL ? fixture(fitResponse) : mid);
      }),
    );
    await enrich();
    expect(intelOf("scam")?.final_decision).toBe("suspicious");
    expect(intelOf("midlevel")?.final_decision).toBe("reject");
    expect(requests.filter((r) => r["model"] !== FIT_MODEL)).toHaveLength(2);
    expect(fitRequests()).toHaveLength(0);
    for (const id of ["scam", "midlevel"]) {
      expect(intelOf(id)?.fit_score).toBeNull();
      expect(intelOf(id)?.fit_reasons).toBeNull();
      expect(intelOf(id)?.fit_model).toBeNull();
    }
  });

  it("sends the CV as the cacheable prefix, ahead of the posting; posting text stays out of it", async () => {
    addPosting("p1", { description_text: "UNIQUE-POSTING-MARKER React role. ".repeat(8) });
    await enrich();
    const req = fitRequests()[0];
    expect(req?.["model"]).toBe("claude-sonnet-5-5");
    const system = req?.["system"] as { type: string; text: string; cache_control?: unknown }[];
    expect(system).toHaveLength(2);
    // Block 0: static instructions. Block 1: the CV, marked cacheable.
    expect(system[0]?.cache_control).toBeUndefined();
    expect(system[1]?.cache_control).toEqual({ type: "ephemeral" });
    expect(system[1]?.text).toContain(CV.trim());
    expect(system[0]?.text).not.toContain(CV.trim().slice(0, 40));
    // The variable posting part is the user message, after the prefix, and not part of it.
    const messages = req?.["messages"] as { role: string; content: string }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("UNIQUE-POSTING-MARKER");
    expect(messages[0]?.content).toContain("Senior Frontend Engineer");
    expect(messages[0]?.content).toContain('"seniority":"senior"');
    expect(messages[0]?.content).not.toContain(CV.trim().slice(0, 40));
    expect(JSON.stringify(system)).not.toContain("UNIQUE-POSTING-MARKER");
  });

  it("the prompt asks only for fit: no decision, tier or ask", async () => {
    addPosting("p1");
    await enrich();
    const req = fitRequests()[0];
    const schema = JSON.stringify(req?.["output_config"]);
    for (const key of ["decision", "tier", "ask", "keep", "reject"]) {
      expect(schema).not.toContain(`"${key}"`);
    }
    // Constraints cannot be sent (R1): the wire schema carries none, Zod enforces them.
    expect(schema).not.toContain("maximum");
    expect(schema).not.toContain("maxItems");
    expect(schema).not.toContain("maxLength");
  });

  it("score out of range -> retried once in the run, then failed with issue paths and stop reason", async () => {
    addPosting("p1");
    fitResponse = "fit-score-out-of-range.json";
    const r = await enrich();
    expect(fitRequests()).toHaveLength(2);
    const row = intelOf("p1");
    expect(row?.status).toBe("failed");
    expect(row?.fit_score).toBeNull();
    expect(row?.fit_reasons).toBeNull();
    // Extraction is kept; the failure is recorded as Zod issue paths, never content.
    expect(row?.extraction).not.toBeNull();
    const reasons = JSON.parse(row?.resolved_reasons ?? "[]") as string[];
    expect(reasons.some((x) => x.startsWith("fit score"))).toBe(true);
    expect(reasons).toEqual(
      expect.arrayContaining([
        "fit stop_reason:end_turn",
        "fit output_tokens:300",
        "fit max_tokens:1536",
      ]),
    );
    expect(r.out).toContain("enriched 0, budget_wait 0, failed 1");
  });

  it("stop_reason max_tokens: logged and stored with output_tokens and max_tokens, no second call", async () => {
    addPosting("p1");
    fitResponse = "fit-max-tokens.json";
    const captured = await captureLogs(() => enrich());
    expect(fitRequests()).toHaveLength(1);
    expect(fitRequests()[0]?.["max_tokens"]).toBe(FIT_MAX_TOKENS);
    expect(db.select().from(llm_calls).where(eq(llm_calls.purpose, "fit")).all()).toHaveLength(1);
    const reasons = JSON.parse(intelOf("p1")?.resolved_reasons ?? "[]") as string[];
    expect(reasons).toEqual(
      expect.arrayContaining([
        "fit stop_reason:max_tokens",
        "fit output_tokens:1536",
        `fit max_tokens:${FIT_MAX_TOKENS}`,
      ]),
    );
    const lines = captured
      .split("\n")
      .filter((l) => l.includes("llm call") || l.includes("llm output invalid"));
    const fitCall = lines.find(
      (l) => l.includes('"msg":"llm call"') && l.includes('"purpose":"fit"'),
    );
    expect(fitCall).toContain('"stop_reason":"max_tokens"');
    const invalid = lines.find((l) => l.includes("llm output invalid"));
    expect(invalid).toContain('"output_tokens":1536');
    expect(invalid).toContain(`"max_tokens":${FIT_MAX_TOKENS}`);
    expect(invalid).not.toContain("Strong React");
  });

  it("a 180-character reason is stored cut to <= 140 characters on a word boundary, ending with …", async () => {
    addPosting("p1");
    fitResponse = "fit-reason-180-chars.json";
    await enrich();
    expect(fitRequests()).toHaveLength(1);
    const row = intelOf("p1");
    expect(row?.status).toBe("done");
    const [reason] = JSON.parse(row?.fit_reasons ?? "[]") as string[];
    expect(reason?.length).toBeLessThanOrEqual(140);
    expect(reason?.endsWith("…")).toBe(true);
    expect(reason).toMatch(
      /^Strong React and TypeScript match for the core stack, but the posting also asks/,
    );
    // Cut on a word boundary: the text before "…" is a whole-word prefix of the original.
    const original = (
      JSON.parse(
        (fixture("fit-reason-180-chars.json") as { content: { text: string }[] }).content[0]
          ?.text ?? "{}",
      ) as { reasons: string[] }
    ).reasons[0] as string;
    const head = (reason as string).slice(0, -1);
    expect(original.startsWith(head)).toBe(true);
    expect(original[head.length]).toBe(" ");
  });

  it("a 141-character reason without spaces is cut to 140 ending with …; four reasons keep the first three", async () => {
    addPosting("p1");
    fitResponse = "fit-reason-too-long.json";
    await enrich();
    const [reason] = JSON.parse(intelOf("p1")?.fit_reasons ?? "[]") as string[];
    expect(reason).toHaveLength(140);
    expect(reason?.endsWith("…")).toBe(true);

    addPosting("p2");
    fitResponse = "fit-too-many-reasons.json";
    await enrich();
    expect(JSON.parse(intelOf("p2")?.fit_reasons ?? "[]")).toEqual(["a", "b", "c"]);
    expect(intelOf("p2")?.status).toBe("done");
  });

  it("a failed fit is scored in the next run with zero extract calls", async () => {
    addPosting("p1");
    fitResponse = "fit-score-out-of-range.json";
    await enrich();
    expect(intelOf("p1")?.status).toBe("failed");
    const extractBefore = extractRequests().length;
    expect(extractBefore).toBe(1);

    fitResponse = "fit-ok.json";
    const r2 = await enrich();
    expect(extractRequests()).toHaveLength(extractBefore);
    expect(fitRequests()).toHaveLength(3);
    const row = intelOf("p1");
    expect(row?.status).toBe("done");
    expect(row?.fit_score).toBe(82);
    expect(r2.out).toContain("enriched 1");
  });

  it("after 3 failed runs the posting stays failed and run 4 does not select it", async () => {
    addPosting("p1");
    fitResponse = "fit-score-out-of-range.json";
    for (let run = 1; run <= 3; run++) {
      await enrich();
      expect(fitRequests()).toHaveLength(run * 2);
      expect(failedFitRuns(intelOf("p1")?.resolved_reasons ?? null)).toBe(run);
    }
    expect(intelOf("p1")?.status).toBe("failed");
    const r4 = await enrich();
    expect(fitRequests()).toHaveLength(6);
    expect(extractRequests()).toHaveLength(1);
    expect(intelOf("p1")?.status).toBe("failed");
    expect(r4.out).toContain("enriched 0, budget_wait 0, failed 0");
  });

  it("an extract-stage failure is not selected again", async () => {
    addPosting("p1");
    extractResponse = "extract-invalid.json";
    await enrich();
    expect(intelOf("p1")?.status).toBe("failed");
    expect(intelOf("p1")?.extraction).toBeNull();
    const before = requests.length;
    await enrich();
    expect(requests).toHaveLength(before);
  });

  it("the digest shows the retry text, then the 3-times text", async () => {
    addPosting("p1");
    fitResponse = "fit-score-out-of-range.json";
    const digestText = () => {
      const dir = mkdtempSync(join(tmpdir(), "job-agent-digest-fit-"));
      try {
        const path = runDigest({
          db,
          date: "2026-10-09",
          outDir: dir,
          now: () => NOW,
          out: () => {},
        });
        return readFileSync(path, "utf-8");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    await enrich();
    expect(digestText()).toContain("scoring failed (score: custom), retried next run");
    // Second and third failed runs.
    db.update(analysis).set({ digested_at: null }).run();
    await enrich();
    await enrich();
    expect(failedFitRuns(intelOf("p1")?.resolved_reasons ?? null)).toBe(3);
    expect(digestText()).toContain("scoring failed 3 times");
  });

  it("missing cv.md -> fit skipped with a message, extraction still runs", async () => {
    addPosting("p1");
    const r = await enrich(null);
    expect(r.code).toBe(0);
    expect(r.err).toContain("cv.md not found");
    expect(r.err).toContain("fit scoring skipped");
    expect(fitRequests()).toHaveLength(0);
    expect(requests).toHaveLength(1);
    const row = intelOf("p1");
    expect(row?.status).toBe("done");
    expect(row?.extraction).not.toBeNull();
    expect(row?.final_decision).toBe("keep");
    expect(row?.fit_score).toBeNull();
  });

  it("a config dir without cv.md loads as null", () => {
    expect(loadCv(resolve(here, "../../../config/does-not-exist"))).toBeNull();
  });

  it("budget exhausted during the fit call -> posting budget_wait, exit 0", async () => {
    addPosting("p1");
    server.use(
      http.post(URL, async ({ request }) => {
        const body = (await request.json()) as Req;
        requests.push(body);
        if (body["model"] !== FIT_MODEL) {
          // The extraction call used up the day's budget.
          db.insert(llm_calls)
            .values({
              id: "big",
              day: "2026-10-09",
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
        return HttpResponse.json(fixture("extract-ok.json"));
      }),
    );
    const r = await enrich();
    expect(r.code).toBe(0);
    expect(fitRequests()).toHaveLength(0);
    expect(intelOf("p1")?.status).toBe("budget_wait");
  });

  it("never logs the CV or the model output", async () => {
    addPosting("p1");
    const captured: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    const grab = ((c: string | Uint8Array) => (captured.push(String(c)), true)) as never;
    process.stdout.write = grab;
    process.stderr.write = grab;
    let result: Awaited<ReturnType<typeof enrich>>;
    try {
      result = await enrich();
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }
    const everything = [...captured, result.out, result.err].join("\n");
    expect(captured.join("")).toContain("llm call"); // the logger did run
    const cvLines = CV.split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length >= 12);
    expect(cvLines.length).toBeGreaterThan(0);
    for (const line of cvLines) expect(everything).not.toContain(line);
    for (const text of [
      "Strong React and TypeScript match",
      "No evidence of GraphQL",
      "Responsibilities: build the web app",
    ]) {
      expect(everything).not.toContain(text);
    }
  });
});

describe("FitSchema", () => {
  const base = { score: 70, reasons: ["ok"], matchedSkills: [], missingSkills: [] };
  it.each([
    ["negative score", { ...base, score: -1 }],
    ["fractional score", { ...base, score: 70.5 }],
    ["score above 100", { ...base, score: 101 }],
    ["no reasons", { ...base, reasons: [] }],
    ["empty reason", { ...base, reasons: [" "] }],
  ])("rejects %s", (_name, value) => {
    expect(FitSchema.safeParse(value).success).toBe(false);
  });

  it("accepts the boundaries; length and count are normalized in code, not rejected", () => {
    expect(FitSchema.safeParse({ ...base, score: 0 }).success).toBe(true);
    expect(FitSchema.safeParse({ ...base, score: 100 }).success).toBe(true);
    const wide = { ...base, reasons: ["x".repeat(300), "b", "c", "d"] };
    expect(FitSchema.safeParse(wide).success).toBe(true);
    const fit = normalizeFit(wide);
    expect(fit.reasons).toHaveLength(3);
    expect(fit.reasons[0]).toHaveLength(140);
  });

  it("truncateReason keeps short text and cuts on a word boundary", () => {
    expect(truncateReason("x".repeat(140))).toBe("x".repeat(140));
    const cut = truncateReason("word ".repeat(40));
    expect(cut.length).toBeLessThanOrEqual(140);
    expect(cut.endsWith("word…")).toBe(true);
  });
});
