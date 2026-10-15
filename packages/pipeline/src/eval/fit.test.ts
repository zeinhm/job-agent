import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { llm_calls, openDb, type Db } from "@job-agent/core";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FIT_MODEL } from "../intel/fit.ts";
import { bandOf, DEFAULT_FIT_SET_URL, FitSetSchema, runEvalFit, summarizeFit } from "./fit.ts";

const here = dirname(fileURLToPath(import.meta.url));
const okMessage = JSON.parse(
  readFileSync(resolve(here, "../../test/fixtures/anthropic/fit-ok.json"), "utf-8"),
) as { content: { text: string }[] };
const okWire = JSON.parse(okMessage.content[0]?.text ?? "") as Record<string, unknown>;

const URL = "https://api.anthropic.com/v1/messages";
const ENV = { ANTHROPIC_API_KEY: "sk-ant-test-key-0000" };
const NOW = new Date("2026-10-09T05:00:00Z");

const set = FitSetSchema.parse(JSON.parse(readFileSync(DEFAULT_FIT_SET_URL, "utf8")));

/** The model's answer for a request body; the default scores every posting 82 (high). */
let answer: (body: {
  system: unknown;
  messages: { content: unknown }[];
}) => Record<string, unknown>;
let requests: { system: unknown; messages: { content: unknown }[] }[] = [];
let failWith: number | null = null;

const server = setupServer(
  http.post(URL, async ({ request }) => {
    const body = (await request.json()) as (typeof requests)[number];
    requests.push(body);
    if (failWith !== null) {
      return HttpResponse.json(
        { type: "error", error: { type: "authentication_error", message: "bad key" } },
        { status: failWith },
      );
    }
    return HttpResponse.json({
      ...okMessage,
      content: [{ type: "text", text: JSON.stringify(answer(body)) }],
    });
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
  requests = [];
  answer = () => okWire;
  failWith = null;
});
afterEach(() => db.$client.close());

async function run(
  args: string[],
  extra: { env?: Record<string, string | undefined>; configDir?: string } = {},
) {
  const env = extra.env ?? ENV;
  let out = "";
  let err = "";
  let opened = 0;
  const code = await runEvalFit({
    args,
    openDb: () => {
      opened += 1;
      return db;
    },
    env,
    now: () => NOW,
    ...(extra.configDir !== undefined ? { configDir: extra.configDir } : {}),
    baseURL: "https://api.anthropic.com",
    out: (t) => (out += t),
    err: (t) => (err += t),
  });
  if (args.includes("--live") && env["ANTHROPIC_API_KEY"] && code !== 1) {
    expect(opened).toBe(1);
  }
  return { code, out, err, opened };
}

const calls = () => db.select().from(llm_calls).all();
const userText = (r: (typeof requests)[number]) => JSON.stringify(r.messages);

describe("committed set", () => {
  it("has 20-30 fake cases with both bands and the full persona-independent shape", () => {
    expect(set.cases.length).toBeGreaterThanOrEqual(20);
    expect(set.cases.length).toBeLessThanOrEqual(30);
    const high = set.cases.filter((c) => c.expectedBand === "high").length;
    expect(high).toBeGreaterThanOrEqual(8);
    expect(set.cases.length - high).toBeGreaterThanOrEqual(8);
  });
});

describe("bands", () => {
  it("high is 60 and above, low is below", () => {
    expect(bandOf(60)).toBe("high");
    expect(bandOf(59)).toBe("low");
    expect(bandOf(100)).toBe("high");
    expect(bandOf(0)).toBe("low");
  });

  it("summarizes accuracy, confusion counts and miss ids, leaving unscored cases out", () => {
    const s = summarizeFit([
      { id: "a", expected: "high", actual: "high" },
      { id: "b", expected: "high", actual: "low" },
      { id: "c", expected: "low", actual: "high" },
      { id: "d", expected: "low", actual: "low" },
      { id: "e", expected: "low", actual: "low" },
      { id: "f", expected: "high", actual: null },
    ]);
    expect(s.scored).toBe(5);
    expect(s.correct).toBe(3);
    expect(s.accuracy).toBeCloseTo(0.6);
    expect(s.confusion).toEqual({
      "high->high": 1,
      "high->low": 1,
      "low->high": 1,
      "low->low": 2,
    });
    expect(s.missIds).toEqual(["b", "c"]);
  });
});

describe("dry run", () => {
  it("prints the case count and model, exits 0 and makes no request without --live", async () => {
    const r = await run([]);
    expect(r).toMatchObject({
      code: 0,
      out: `eval:fit: dry run, ${set.cases.length} cases, would use ${FIT_MODEL}\n`,
      err: "",
      opened: 0,
    });
    expect(requests).toHaveLength(0);
    expect(calls()).toHaveLength(0);
  });

  it("is a dry run with --live but no key, and with a key but no --live", async () => {
    const noKey = await run(["--live"], { env: {} });
    expect(noKey.out).toMatch(/^eval:fit: dry run, \d+ cases, would use /);
    const noLive = await run([]);
    expect(noLive.out).toMatch(/dry run/);
    expect(requests).toHaveLength(0);
    expect(noKey.opened + noLive.opened).toBe(0);
  });

  it("--help documents the owner's command", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("eval:fit --set data/eval/reviews-<date>.json --live");
    expect(r.out).toContain("eval:export-reviews");
    expect(requests).toHaveLength(0);
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
    const missing = await run(["--set", resolve(here, "no-such-file.json")]);
    expect(missing.err).toBe("eval:fit: set cannot be read\n");
    const invalid = await run(["--set", resolve(here, "../../package.json")]);
    expect(invalid.err).toBe("eval:fit: set does not match the eval set schema\n");
    expect(missing.code + invalid.code).toBe(2);
  });
});

describe("--live (msw)", () => {
  it("scores every case with purpose eval_fit, no posting id, and reports band accuracy", async () => {
    const r = await run(["--live"]);
    expect(r.code).toBe(0);
    expect(requests).toHaveLength(set.cases.length);
    const rows = calls();
    expect(new Set(rows.map((c) => c.purpose))).toEqual(new Set(["eval_fit"]));
    expect(rows.every((c) => c.posting_id === null && c.status === "ok")).toBe(true);
    expect(r.out).toContain(`${set.cases.length} of ${set.cases.length} cases run`);
    expect(r.out).toMatch(/band accuracy: \d+\/\d+ \(\d+\.\d%\)/);
    expect(r.out).toMatch(/total cost: \$\d\.\d{4} \(\d+ calls, cap \$0\.50\)/);
  });

  it("uses the fake persona CV for the committed set", async () => {
    await run(["--live", "--max-usd", "0.0001"]);
    expect(JSON.stringify(requests[0]?.system)).toContain("Alex Example");
  });

  it("reports confusion counts and the ids of misses", async () => {
    // Always 82: every `high` case is right, every `low` case is a miss.
    const r = await run(["--live"]);
    const high = set.cases.filter((c) => c.expectedBand === "high").length;
    const low = set.cases.filter((c) => c.expectedBand === "low");
    expect(r.out).toContain(`band accuracy: ${high}/${set.cases.length}`);
    expect(r.out).toContain(`    high->high: ${high}\n`);
    expect(r.out).toContain("    high->low: 0\n");
    expect(r.out).toContain(`    low->high: ${low.length}\n`);
    expect(r.out).toContain(`  misses: ${low.map((c) => c.id).join(", ")}\n`);
  });

  it("scores a score of 59 as low and 60 as high", async () => {
    let n = 0;
    answer = () => ({ ...okWire, score: n++ % 2 === 0 ? 60 : 59 });
    const r = await run(["--live"]);
    expect(r.out).toMatch(/band accuracy: /);
    const summary =
      /high->high: (\d+)\n {4}high->low: (\d+)\n {4}low->high: (\d+)\n {4}low->low: (\d+)/.exec(
        r.out,
      );
    expect(summary).not.toBeNull();
    // 60 -> high, 59 -> low: both bands appear for the same alternating answer.
    expect(Number(summary?.[1]) + Number(summary?.[3])).toBeGreaterThan(0);
    expect(Number(summary?.[2]) + Number(summary?.[4])).toBeGreaterThan(0);
  });

  it("never prints posting text, titles or model output", async () => {
    const secret = "SECRET-POSTING-TEXT";
    answer = () => ({ ...okWire, reasons: ["SECRET-MODEL-OUTPUT"] });
    const [base] = set.cases;
    if (base === undefined) throw new Error("eval set is empty");
    const dir = mkdtempSync(join(tmpdir(), "eval-fit-"));
    const path = join(dir, "set.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        cases: [{ ...base, description: secret, title: "SECRET-TITLE" }],
      }),
    );
    try {
      const r = await run(["--live", "--set", path], { configDir: dir });
      expect(r.code).toBe(1); // no cv.md in the dir: refuses before any request
      expect(requests).toHaveLength(0);
      writeFileSync(join(dir, "cv.md"), "# Owner CV marker\nSecret skills");
      const ok = await run(["--live", "--set", path], { configDir: dir });
      expect(ok.code).toBe(0);
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0]?.system) + JSON.stringify(requests[0]?.messages)).toContain(
        "Owner CV marker",
      );
      expect(userText(requests[0] ?? { system: "", messages: [] })).toContain(secret);
      const all = ok.out + ok.err;
      for (const s of [secret, "SECRET-TITLE", "SECRET-MODEL-OUTPUT", base.company]) {
        expect(all).not.toContain(s);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a custom set without config/cv.md and says why", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-fit-"));
    try {
      const r = await run(["--live", "--set", fixturePath()], { configDir: dir });
      expect(r.code).toBe(1);
      expect(r.err).toBe(
        "eval:fit: config/cv.md is missing or empty; a custom --set is scored against it\n",
      );
      expect(requests).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops once --max-usd is spent and says so", async () => {
    const r = await run(["--live", "--max-usd", "0.0001"]);
    expect(r.code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(r.out).toContain(`1 of ${set.cases.length} cases run`);
    expect(r.out).toContain("stopped early: --max-usd $0.00 reached");
  });

  it("clamps --max-usd above the default and warns", async () => {
    const r = await run(["--live", "--max-usd", "5", "--set", fixturePath()], {
      configDir: dirWithCv(),
    });
    expect(r.err).toBe("eval:fit: --max-usd may only lower the cap, using $0.50\n");
    expect(r.out).toContain("cap $0.50)");
  });

  it("lists invalid model output and leaves it out of the accuracy", async () => {
    answer = () => ({ score: 500 });
    const r = await run(["--live"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^invalid model output: fit-001, /m);
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

function fixturePath(): string {
  return fileURLToPath(DEFAULT_FIT_SET_URL);
}

function dirWithCv(): string {
  const dir = mkdtempSync(join(tmpdir(), "eval-fit-cv-"));
  writeFileSync(join(dir, "cv.md"), "# Test CV");
  return dir;
}
