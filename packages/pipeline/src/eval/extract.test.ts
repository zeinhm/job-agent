import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { llm_calls, openDb, type Db } from "@job-agent/core";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EXTRACT_MODEL } from "../intel/extract.ts";
import { DEFAULT_SET_URL, runEvalExtract } from "./extract.ts";
import { EvalSetSchema } from "./score.ts";

const here = dirname(fileURLToPath(import.meta.url));
const okMessage = JSON.parse(
  readFileSync(resolve(here, "../../test/fixtures/anthropic/extract-ok.json"), "utf-8"),
) as { content: { text: string }[] };
const okWire = JSON.parse(okMessage.content[0]?.text ?? "") as Record<string, unknown>;

const URL = "https://api.anthropic.com/v1/messages";
const ENV = { ANTHROPIC_API_KEY: "sk-ant-test-key-0000" };
const NOW = new Date("2026-10-09T05:00:00Z");

const set = EvalSetSchema.parse(JSON.parse(readFileSync(DEFAULT_SET_URL, "utf8")));
const SECRET_DESCRIPTION = "SECRET-POSTING-TEXT";
const SECRET_TITLE = "SECRET-MODEL-OUTPUT";

/** The model's answer for a request; the default is the fixture extraction (senior, worldwide, no HQ match). */
let answer: (input: string) => Record<string, unknown> = () => okWire;
let requests: Record<string, unknown>[] = [];
let failWith: number | null = null;

const server = setupServer(
  http.post(URL, async ({ request }) => {
    const body = (await request.json()) as {
      messages: { content: string }[];
    } & Record<string, unknown>;
    requests.push(body);
    if (failWith !== null) {
      return HttpResponse.json(
        { type: "error", error: { type: "authentication_error", message: "bad key" } },
        { status: failWith },
      );
    }
    const wire = answer(body.messages[0]?.content ?? "");
    return HttpResponse.json({
      ...okMessage,
      content: [{ type: "text", text: JSON.stringify(wire) }],
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

interface Run {
  code: number;
  out: string;
  err: string;
}

async function run(args: string[], env: Record<string, string | undefined> = ENV): Promise<Run> {
  let out = "";
  let err = "";
  let opened = 0;
  const code = await runEvalExtract({
    args,
    openDb: () => {
      opened += 1;
      return db;
    },
    env,
    now: () => NOW,
    baseURL: "https://api.anthropic.com",
    out: (t) => (out += t),
    err: (t) => (err += t),
  });
  if (args.includes("--live") && env["ANTHROPIC_API_KEY"]) expect(opened).toBe(1);
  else expect(opened).toBe(0);
  return { code, out, err };
}

const calls = () => db.select().from(llm_calls).all();

describe("dry run", () => {
  it("prints the case count and model, exits 0 and makes no request without --live", async () => {
    const r = await run([]);
    expect(r).toEqual({
      code: 0,
      out: `eval:extract: dry run, ${set.cases.length} cases, would use ${EXTRACT_MODEL}\n`,
      err: "",
    });
    expect(requests).toHaveLength(0);
    expect(calls()).toHaveLength(0);
  });

  it("is a dry run with --live but no key", async () => {
    const r = await run(["--live"], {});
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^eval:extract: dry run, \d+ cases, would use /);
    expect(requests).toHaveLength(0);
  });

  it("is a dry run with a key but no --live", async () => {
    const r = await run([], ENV);
    expect(r.out).toMatch(/dry run/);
    expect(requests).toHaveLength(0);
  });
});

describe("argument errors", () => {
  it.each([["--max-usd", "abc"], ["--max-usd", "0"], ["--max-usd", "-1"], ["--bogus"]])(
    "exits 1 for %s",
    async (...args) => {
      const r = await run(args);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/^eval:extract: /);
      expect(requests).toHaveLength(0);
    },
  );

  it("exits 1 when --set is missing or does not match the schema", async () => {
    const missing = await run(["--set", resolve(here, "no-such-file.json")]);
    expect(missing.code).toBe(1);
    expect(missing.err).toBe("eval:extract: set cannot be read\n");
    const invalid = await run(["--set", resolve(here, "../../package.json")]);
    expect(invalid.code).toBe(1);
    expect(invalid.err).toBe("eval:extract: set does not match the eval set schema\n");
  });
});

describe("--live (msw)", () => {
  it("runs every case through the shared client with purpose eval_extract and reports accuracy", async () => {
    const r = await run(["--live"]);
    expect(r.code).toBe(0);
    expect(requests).toHaveLength(set.cases.length);
    const rows = calls();
    expect(rows).toHaveLength(set.cases.length);
    expect(new Set(rows.map((c) => c.purpose))).toEqual(new Set(["eval_extract"]));
    expect(rows.every((c) => c.posting_id === null && c.status === "ok")).toBe(true);
    expect(r.out).toContain(`${set.cases.length} of ${set.cases.length} cases run`);
    expect(r.out).toMatch(/hiringScope: \d+\/\d+ \(\d+\.\d%\)/);
    expect(r.out).toMatch(/total cost: \$\d\.\d{4} \(\d+ calls, cap \$0\.50\)/);
  });

  it("scores against the expected facts and lists failing case ids", async () => {
    // The model always answers "senior": right exactly where the set expects "senior".
    answer = () => ({ ...okWire, seniority: "senior" });
    const r = await run(["--live"]);
    const expecting = set.cases.filter((c) => c.expected.seniority !== undefined);
    const wrong = expecting.filter((c) => c.expected.seniority !== "senior").map((c) => c.id);
    expect(wrong.length).toBeGreaterThan(0);
    const correct = expecting.length - wrong.length;
    const lines = r.out.split("\n");
    const at = lines.findIndex((l) => l.startsWith("  seniority:"));
    expect(lines[at]).toBe(
      `  seniority: ${correct}/${expecting.length} (${((correct / expecting.length) * 100).toFixed(1)}%)`,
    );
    expect(lines[at + 1]).toBe(`    failing: ${wrong.join(", ")}`);
  });

  it("never prints posting text, titles or model output", async () => {
    answer = () => ({ ...okWire, roleTitle: SECRET_TITLE });
    const [base] = set.cases;
    if (base === undefined) throw new Error("eval set is empty");
    const custom = {
      version: 1,
      cases: [{ ...base, description: SECRET_DESCRIPTION, title: "SECRET-TITLE" }],
    };
    const dir = mkdtempSync(join(tmpdir(), "eval-extract-"));
    const path = join(dir, "set.json");
    writeFileSync(path, JSON.stringify(custom));
    try {
      const r = await run(["--live", "--set", path]);
      expect(r.code).toBe(0);
      expect(requests).toHaveLength(1);
      const all = r.out + r.err;
      expect(all).not.toContain(SECRET_DESCRIPTION);
      expect(all).not.toContain("SECRET-TITLE");
      expect(all).not.toContain(SECRET_TITLE);
      expect(all).not.toContain(base.company);
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
    const r = await run(["--live", "--max-usd", "5"]);
    expect(r.err).toBe("eval:extract: --max-usd may only lower the cap, using $0.50\n");
    expect(r.out).toContain("cap $0.50)");
  });

  it("counts invalid model output as a miss on every expected field", async () => {
    answer = () => ({ seniority: "senior" });
    const r = await run(["--live"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^invalid model output: gs-001, /m);
    expect(r.out).toMatch(/seniority: 0\/\d+ \(0\.0%\)/);
  });

  it("aborts with exit 1 after 3 consecutive API errors, printing status and type only", async () => {
    failWith = 401;
    const r = await run(["--live"]);
    expect(r.code).toBe(1);
    expect(requests).toHaveLength(3);
    expect(r.err).toBe(
      "eval:extract: aborted after 3 consecutive API errors: status 401 authentication_error\n",
    );
    expect(r.err + r.out).not.toContain(ENV.ANTHROPIC_API_KEY);
  });
});
