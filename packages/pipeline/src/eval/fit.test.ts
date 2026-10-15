import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { llm_calls, openDb, type Db } from "@job-agent/core";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TOP_MATCH_MIN_FIT } from "../digest/rank.ts";
import { EXTRACT_MODEL } from "../intel/extract.ts";
import { FIT_MODEL } from "../intel/fit.ts";
import {
  bandOf,
  DEFAULT_FIT_SET_URL,
  EXAMPLE_CV_URL,
  FitSetSchema,
  runEvalFit,
  summarizeFit,
} from "./fit.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(here, "../../test/fixtures/anthropic", name), "utf-8")) as {
    content: { text: string }[];
  };
const extractMsg = fixture("extract-ok.json");
const fitMsg = fixture("fit-ok.json");
const extractWire = JSON.parse(extractMsg.content[0]?.text ?? "") as Record<string, unknown>;
const fitWire = JSON.parse(fitMsg.content[0]?.text ?? "") as Record<string, unknown>;

const URL = "https://api.anthropic.com/v1/messages";
const ENV = { ANTHROPIC_API_KEY: "sk-ant-test-key-0000" };
const NOW = new Date("2026-10-09T05:00:00Z");

const set = FitSetSchema.parse(JSON.parse(readFileSync(DEFAULT_FIT_SET_URL, "utf8")));
const SECRET_DESCRIPTION = "SECRET-POSTING-TEXT";
const OWNER_CV_MARKER = "OWNER-CV-MARKER";

/** Fit score for a request, given the posting's title line. */
let scoreFor: (input: string) => number = () => 82;
let requests: { model: string; text: string }[] = [];
let failWith: number | null = null;
let invalidFit = false;

const server = setupServer(
  http.post(URL, async ({ request }) => {
    const body = (await request.json()) as {
      model: string;
      system: unknown;
      messages: { content: unknown }[];
    };
    const text = JSON.stringify(body); // the CV prefix may sit in `system` or in a message block
    requests.push({ model: body.model, text });
    if (failWith !== null) {
      return HttpResponse.json(
        { type: "error", error: { type: "authentication_error", message: "bad key" } },
        { status: failWith },
      );
    }
    if (body.model === FIT_MODEL) {
      const wire = invalidFit ? { score: 500 } : { ...fitWire, score: scoreFor(text) };
      return HttpResponse.json({
        ...fitMsg,
        content: [{ type: "text", text: JSON.stringify(wire) }],
      });
    }
    return HttpResponse.json({
      ...extractMsg,
      content: [{ type: "text", text: JSON.stringify(extractWire) }],
    });
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

let db: Db;
let tmp: string;
beforeEach(() => {
  db = openDb(":memory:");
  tmp = mkdtempSync(join(tmpdir(), "eval-fit-"));
  requests = [];
  scoreFor = () => 82;
  failWith = null;
  invalidFit = false;
});
afterEach(() => {
  db.$client.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function run(args: string[], env: Record<string, string | undefined> = ENV, cwd = tmp) {
  let out = "";
  let err = "";
  let opened = 0;
  const code = await runEvalFit({
    args,
    openDb: () => {
      opened += 1;
      return db;
    },
    configDir: join(tmp, "config"),
    cwd,
    env,
    now: () => NOW,
    baseURL: "https://api.anthropic.com",
    out: (t) => (out += t),
    err: (t) => (err += t),
  });
  if (args.includes("--live") && env["ANTHROPIC_API_KEY"] && code !== 1) expect(opened).toBe(1);
  return { code, out, err, opened };
}

const calls = () => db.select().from(llm_calls).all();

describe("committed set", () => {
  it("has 20-30 cases in both bands with a unique id each, scored against the fake persona CV", () => {
    expect(set.cases.length).toBeGreaterThanOrEqual(20);
    expect(set.cases.length).toBeLessThanOrEqual(30);
    expect(set.persona).toBe("example");
    expect(set.cases.filter((c) => c.expected === "high").length).toBeGreaterThanOrEqual(8);
    expect(set.cases.filter((c) => c.expected === "low").length).toBeGreaterThanOrEqual(8);
    expect(readFileSync(EXAMPLE_CV_URL, "utf8")).toContain("Fake persona");
  });
});

describe("bands", () => {
  it("high starts at TOP_MATCH_MIN_FIT", () => {
    expect(bandOf(TOP_MATCH_MIN_FIT)).toBe("high");
    expect(bandOf(TOP_MATCH_MIN_FIT - 1)).toBe("low");
    expect(bandOf(100)).toBe("high");
    expect(bandOf(0)).toBe("low");
  });

  it("summarizeFit counts the confusion matrix, lists misses and leaves unscored cases out", () => {
    const s = summarizeFit([
      { id: "a", expected: "high", actual: "high" },
      { id: "b", expected: "high", actual: "low" },
      { id: "c", expected: "low", actual: "high" },
      { id: "d", expected: "low", actual: "low" },
      { id: "e", expected: "low", actual: null },
    ]);
    expect(s).toEqual({
      scored: 4,
      correct: 2,
      accuracy: 0.5,
      confusion: { high: { high: 1, low: 1 }, low: { high: 1, low: 1 } },
      missIds: ["b", "c"],
    });
  });
});

describe("dry run", () => {
  it("prints the case count and models, exits 0 and makes no request without --live", async () => {
    const r = await run([]);
    expect(r).toEqual({
      code: 0,
      out: `eval:fit: dry run, ${set.cases.length} cases, persona example, would use ${EXTRACT_MODEL} + ${FIT_MODEL}\n`,
      err: "",
      opened: 0,
    });
    expect(requests).toHaveLength(0);
    expect(calls()).toHaveLength(0);
  });

  it("is a dry run with --live but no key, and with a key but no --live", async () => {
    const noKey = await run(["--live"], {});
    expect(noKey.out).toMatch(/^eval:fit: dry run, \d+ cases/);
    expect(noKey.opened).toBe(0);
    const noLive = await run([], ENV);
    expect(noLive.out).toMatch(/dry run/);
    expect(noLive.opened).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it("--help documents the owner's command", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("eval:fit --set data/eval/reviews-<date>.json --live");
    expect(r.out).toContain("eval:export-reviews");
  });
});

describe("argument errors", () => {
  it.each([["--max-usd", "abc"], ["--max-usd", "0"], ["--max-usd", "-1"], ["--bogus"]])(
    "exits 1 for %s",
    async (...args) => {
      const r = await run(args);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/^eval:fit: /);
      expect(requests).toHaveLength(0);
    },
  );

  it("exits 1 when --set is missing or does not match the schema", async () => {
    const missing = await run(["--set", join(tmp, "no-such-file.json")]);
    expect(missing.err).toBe("eval:fit: set cannot be read\n");
    expect(missing.code).toBe(1);
    const invalid = await run(["--set", resolve(here, "../../package.json")]);
    expect(invalid.err).toBe("eval:fit: set does not match the eval set schema\n");
    expect(invalid.code).toBe(1);
  });
});

describe("--live (msw)", () => {
  it("runs extract + fit per case with purpose eval_fit and reports accuracy, confusion, misses and cost", async () => {
    // Everything scores 82: right for every `high` case, wrong for every `low` one.
    const highs = set.cases.filter((c) => c.expected === "high");
    const lows = set.cases.filter((c) => c.expected === "low");
    const r = await run(["--live"]);
    expect(r.code).toBe(0);
    expect(requests).toHaveLength(set.cases.length * 2);
    const rows = calls();
    expect(rows).toHaveLength(set.cases.length * 2);
    expect(new Set(rows.map((c) => c.purpose))).toEqual(new Set(["eval_fit"]));
    expect(rows.every((c) => c.posting_id === null && c.status === "ok")).toBe(true);

    const pct = ((highs.length / set.cases.length) * 100).toFixed(1);
    expect(r.out).toContain(
      `${set.cases.length} of ${set.cases.length} cases run, persona example`,
    );
    expect(r.out).toContain(`  band accuracy: ${highs.length}/${set.cases.length} (${pct}%)`);
    expect(r.out).toContain(`    high -> high: ${highs.length}\n    high -> low: 0\n`);
    expect(r.out).toContain(`    low -> high: ${lows.length}\n    low -> low: 0\n`);
    expect(r.out).toContain(`  misses: ${lows.map((c) => c.id).join(", ")}\n`);
    expect(r.out).toMatch(/total cost: \$\d\.\d{4} \(\d+ calls, cap \$0\.50\)/);
  });

  it("scores the band at the threshold from the model's score", async () => {
    // Score exactly TOP_MATCH_MIN_FIT for senior-frontend titles, below it for the rest.
    // The CV prefix also says "Senior Frontend Engineer", so look at the posting's own title line.
    scoreFor = (text) =>
      /Title: [^\\]*Frontend Engineer/.test(text) ? TOP_MATCH_MIN_FIT : TOP_MATCH_MIN_FIT - 1;
    const r = await run(["--live"]);
    const frontendHigh = set.cases.filter(
      (c) => c.expected === "high" && c.title.includes("Frontend Engineer"),
    ).length;
    const frontendLow = set.cases.filter(
      (c) => c.expected === "low" && c.title.includes("Frontend Engineer"),
    ).length;
    expect(r.out).toContain(`    high -> high: ${frontendHigh}\n`);
    expect(r.out).toContain(`    low -> high: ${frontendLow}\n`);
  });

  it("never prints posting text, titles or companies", async () => {
    const [base] = set.cases;
    if (base === undefined) throw new Error("eval set is empty");
    const path = join(tmp, "set.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        cases: [{ ...base, description: SECRET_DESCRIPTION, title: "SECRET-TITLE" }],
      }),
    );
    const r = await run(["--live", "--set", path]);
    expect(r.code).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests.every((q) => q.text.includes(SECRET_DESCRIPTION))).toBe(true);
    const all = r.out + r.err;
    expect(all).not.toContain(SECRET_DESCRIPTION);
    expect(all).not.toContain("SECRET-TITLE");
    expect(all).not.toContain(base.company);
  });

  it("resolves a relative --set against cwd", async () => {
    mkdirSync(join(tmp, "data", "eval"), { recursive: true });
    const [base] = set.cases;
    if (base === undefined) throw new Error("eval set is empty");
    writeFileSync(
      join(tmp, "data", "eval", "s.json"),
      JSON.stringify({ version: 1, cases: [base] }),
    );
    const r = await run(["--live", "--set", "data/eval/s.json"]);
    expect(r.out).toContain("1 of 1 cases run");
  });

  it("scores an owner-persona set against cv.md in the config dir", async () => {
    mkdirSync(join(tmp, "config"));
    writeFileSync(join(tmp, "config", "cv.md"), `# Owner\n${OWNER_CV_MARKER}\n`);
    const [base] = set.cases;
    if (base === undefined) throw new Error("eval set is empty");
    writeFileSync(
      join(tmp, "s.json"),
      JSON.stringify({ version: 1, persona: "owner", cases: [{ ...base, expected: "high" }] }),
    );
    const r = await run(["--live", "--set", join(tmp, "s.json")]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("persona owner");
    const fitRequest = requests.find((q) => q.text.includes("Candidate CV"));
    expect(fitRequest?.text).toContain(OWNER_CV_MARKER);
  });

  it("scores the committed set against the fake persona CV", async () => {
    await run(["--live", "--max-usd", "0.0001"]);
    const fitRequest = requests.find((q) => q.text.includes("Candidate CV"));
    expect(fitRequest?.text).toContain("Alex Example");
    expect(fitRequest?.text).not.toContain(OWNER_CV_MARKER);
  });

  it("exits 1 when the owner CV is missing, before any request", async () => {
    const [base] = set.cases;
    if (base === undefined) throw new Error("eval set is empty");
    writeFileSync(
      join(tmp, "s.json"),
      JSON.stringify({ version: 1, persona: "owner", cases: [base] }),
    );
    const r = await run(["--live", "--set", join(tmp, "s.json")]);
    expect(r.code).toBe(1);
    expect(r.err).toBe("eval:fit: cannot read the CV for persona owner\n");
    expect(requests).toHaveLength(0);
    expect(r.opened).toBe(0);
  });

  it("stops once --max-usd is spent and says so", async () => {
    const r = await run(["--live", "--max-usd", "0.0001"]);
    expect(r.code).toBe(0);
    expect(requests).toHaveLength(2);
    expect(r.out).toContain(`1 of ${set.cases.length} cases run`);
    expect(r.out).toContain("stopped early: --max-usd $0.00 reached");
  });

  it("clamps --max-usd above the default and warns", async () => {
    const r = await run(["--live", "--max-usd", "5"]);
    expect(r.err).toBe("eval:fit: --max-usd may only lower the cap, using $0.50\n");
    expect(r.out).toContain("cap $0.50)");
  });

  it("leaves invalid model output out of the accuracy and lists the ids", async () => {
    invalidFit = true;
    const r = await run(["--live"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^invalid model output: fit-h01, /m);
    expect(r.out).toContain("band accuracy: 0/0 (0.0%)");
  });

  it("aborts with exit 1 after 3 consecutive API errors, printing status and type only", async () => {
    failWith = 401;
    const r = await run(["--live"]);
    expect(r.code).toBe(1);
    expect(requests).toHaveLength(3);
    expect(r.err).toBe(
      "eval:fit: aborted after 3 consecutive API errors: status 401 authentication_error\n",
    );
    expect(r.err + r.out).not.toContain(ENV.ANTHROPIC_API_KEY);
  });
});
