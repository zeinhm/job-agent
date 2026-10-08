import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { openDb, type Db } from "../db/index.ts";
import { llm_calls } from "../db/schema.ts";
import { createLogger } from "../log.ts";
import { http, HttpResponse, setupServer } from "../test-utils.ts";
import { BudgetExceededError, effectiveCapUsd, jakartaDay, spentOnDay } from "./budget.ts";
import {
  callStructured,
  LlmApiError,
  LlmOutputError,
  MissingApiKeyError,
  type CallStructuredOptions,
} from "./client.ts";
import { MODEL_PRICES, costFromUsage } from "./prices.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(here, "../../test/fixtures/anthropic", name), "utf-8"));

const KEY = "sk-ant-test-key-0000";
const URL = "https://api.anthropic.com/v1/messages";
const Schema = z.object({ remote: z.boolean(), currency: z.string() });

let requests: unknown[] = [];
let respond: () => Response | Promise<Response> = () => HttpResponse.json(fixture("ok-haiku.json"));
const server = setupServer(
  http.post(URL, async ({ request }) => {
    requests.push(await request.json());
    return respond();
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

let db: Db;
let lines: string[];
let nowDate: Date;
const logger = () =>
  createLogger(
    (l) => lines.push(l),
    () => nowDate,
  );
const noSleep = async (): Promise<void> => {};

beforeEach(() => {
  db = openDb(":memory:");
  lines = [];
  requests = [];
  nowDate = new Date("2026-10-09T05:00:00Z"); // 12:00 WIB
  respond = () => HttpResponse.json(fixture("ok-haiku.json"));
});
afterEach(() => server.resetHandlers());

const deps = (env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: KEY }) => ({
  db,
  env,
  now: () => nowDate,
  logger: logger(),
  sleep: noSleep,
});

const opts = (over: Partial<CallStructuredOptions<typeof Schema>> = {}) => ({
  model: "claude-haiku-5-5" as const,
  purpose: "extract" as const,
  system: "Extract facts.",
  input: "Posting text.",
  schema: Schema,
  maxTokens: 1000,
  ...over,
});

function seedSpend(usd: string, createdAt: string, day: string): void {
  db.insert(llm_calls)
    .values({
      id: `seed-${Math.random()}`,
      day,
      model: "claude-haiku-5-5",
      purpose: "extract",
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cost_usd: usd,
      status: "ok",
      created_at: createdAt,
    })
    .run();
}

describe("daily cap", () => {
  it("does not send when spent + reserve exceeds the cap", async () => {
    seedSpend("0.99", nowDate.toISOString(), "2026-10-09");
    // reserve: ~505 prompt tokens * 0.1 + 40_000 * 0.5 per M = ~$0.02
    await expect(callStructured(opts({ maxTokens: 40_000 }), deps())).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(requests).toHaveLength(0);
    expect(db.select().from(llm_calls).all()).toHaveLength(1); // only the seed
  });

  it("sends when the reserve still fits", async () => {
    seedSpend("0.99", nowDate.toISOString(), "2026-10-09");
    await expect(callStructured(opts({ maxTokens: 1000 }), deps())).resolves.toEqual({
      remote: true,
      currency: "USD",
    });
    expect(requests).toHaveLength(1);
  });

  it("uses the Asia/Jakarta day: 23:30 WIB yesterday does not count today", async () => {
    // 2026-10-08 23:30 WIB = 16:30Z; "now" is 2026-10-09 00:10 WIB = 2026-10-08T17:10Z
    const yesterday = new Date("2026-10-08T16:30:00Z");
    nowDate = new Date("2026-10-08T17:10:00Z");
    expect(jakartaDay(yesterday)).toBe("2026-10-08");
    expect(jakartaDay(nowDate)).toBe("2026-10-09");
    seedSpend("0.99", yesterday.toISOString(), jakartaDay(yesterday));
    await expect(callStructured(opts({ maxTokens: 40_000 }), deps())).resolves.toBeDefined();
    expect(requests).toHaveLength(1);
    expect(spentOnDay(db, "2026-10-09")).toBeGreaterThan(0);
    // and the new row is on the new day
    const day = db
      .select()
      .from(llm_calls)
      .all()
      .find((r) => r.id.startsWith("seed") === false)?.day;
    expect(day).toBe("2026-10-09");
  });

  it("the same instant counts as today's spend in the same Jakarta day", async () => {
    seedSpend("0.99", "2026-10-08T17:05:00Z", "2026-10-09");
    nowDate = new Date("2026-10-08T17:10:00Z");
    await expect(callStructured(opts({ maxTokens: 40_000 }), deps())).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });

  describe("env override", () => {
    it("=0.5 lowers the cap", () => {
      const warnings: string[] = [];
      expect(effectiveCapUsd({ JOB_AGENT_LLM_CAP_USD: "0.5" }, (m) => warnings.push(m))).toBe(0.5);
      expect(warnings).toHaveLength(0);
    });

    it("=5 is ignored with a warning", () => {
      const warnings: string[] = [];
      expect(effectiveCapUsd({ JOB_AGENT_LLM_CAP_USD: "5" }, (m) => warnings.push(m))).toBe(1);
      expect(warnings).toHaveLength(1);
    });

    it("garbage is ignored with a warning", () => {
      const warnings: string[] = [];
      expect(effectiveCapUsd({ JOB_AGENT_LLM_CAP_USD: "abc" }, (m) => warnings.push(m))).toBe(1);
      expect(warnings).toHaveLength(1);
    });

    it("unset keeps $1", () => {
      expect(effectiveCapUsd({}, () => {})).toBe(1);
    });

    it("a lowered cap is enforced by callStructured; a raised one is not", async () => {
      seedSpend("0.6", nowDate.toISOString(), "2026-10-09");
      await expect(
        callStructured(opts(), deps({ ANTHROPIC_API_KEY: KEY, JOB_AGENT_LLM_CAP_USD: "0.5" })),
      ).rejects.toBeInstanceOf(BudgetExceededError);
      expect(requests).toHaveLength(0);
      seedSpend("0.5", nowDate.toISOString(), "2026-10-09"); // 1.1 spent
      await expect(
        callStructured(opts(), deps({ ANTHROPIC_API_KEY: KEY, JOB_AGENT_LLM_CAP_USD: "5" })),
      ).rejects.toBeInstanceOf(BudgetExceededError);
      expect(requests).toHaveLength(0);
      expect(lines.some((l) => l.includes('"level":"warn"'))).toBe(true);
    });
  });
});

describe("cost ledger", () => {
  it("writes the real cost from usage with model and purpose", async () => {
    await callStructured(opts(), deps());
    const rows = db.select().from(llm_calls).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      model: "claude-haiku-5-5",
      purpose: "extract",
      day: "2026-10-09",
      input_tokens: 3000,
      output_tokens: 500,
      cache_read_tokens: 0,
      status: "ok",
    });
    // 3000*0.10/1e6 + 500*0.50/1e6 = 0.00055
    expect(Number(rows[0]?.cost_usd)).toBeCloseTo(0.00055, 8);
  });

  it("includes cache read tokens (Sonnet, thinking block skipped)", async () => {
    respond = () => HttpResponse.json(fixture("ok-sonnet-cache.json"));
    const out = await callStructured(
      opts({ model: "claude-sonnet-5-5", purpose: "fit", cacheablePrefix: "CV TEXT" }),
      deps(),
    );
    expect(out.remote).toBe(true);
    const row = db.select().from(llm_calls).all()[0];
    expect(row).toMatchObject({
      model: "claude-sonnet-5-5",
      purpose: "fit",
      cache_read_tokens: 2000,
    });
    // 3000*2 + 2000*0.1 + 600*10 per M = 0.0122
    expect(Number(row?.cost_usd)).toBeCloseTo(0.0122, 8);
    const sent = requests[0] as {
      system: { text: string; cache_control?: unknown }[];
      thinking: { type: string };
    };
    expect(sent.system[1]).toMatchObject({ text: "CV TEXT", cache_control: { type: "ephemeral" } });
    expect(sent.system[0]?.cache_control).toBeUndefined();
    expect(sent.thinking.type).toBe("between_tools");
  });

  it("stores posting and company ids", async () => {
    db.run(`PRAGMA foreign_keys = OFF`);
    await callStructured(opts({ postingId: "p1", companyId: "c1" }), deps());
    expect(db.select().from(llm_calls).all()[0]).toMatchObject({
      posting_id: "p1",
      company_id: "c1",
    });
  });

  it("prices are pinned", () => {
    expect(MODEL_PRICES["claude-haiku-5-5"]).toMatchObject({
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
    });
    expect(MODEL_PRICES["claude-sonnet-5-5"]).toMatchObject({
      input: 2,
      output: 10,
      cacheRead: 0.1,
    });
  });

  it("prices cache writes and long Haiku prompts", () => {
    expect(
      costFromUsage("claude-sonnet-5-5", {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 2000,
      }),
    ).toBeCloseTo(0.005, 8);
    expect(
      costFromUsage("claude-haiku-5-5", { input_tokens: 200_000, output_tokens: 1000 }),
    ).toBeCloseTo(0.1 + 0.0025, 8);
  });
});

describe("invalid output", () => {
  it("retries exactly once, then throws LlmOutputError; both calls recorded", async () => {
    respond = () => HttpResponse.json(fixture("invalid-schema.json"));
    const err = await callStructured(opts(), deps()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmOutputError);
    expect((err as LlmOutputError).issues[0]).toMatch(/^remote/);
    expect(requests).toHaveLength(2);
    expect(db.select().from(llm_calls).all()).toHaveLength(2);
  });

  it("succeeds when the retry is valid", async () => {
    let n = 0;
    respond = () => HttpResponse.json(fixture(++n === 1 ? "invalid-schema.json" : "ok-haiku.json"));
    await expect(callStructured(opts(), deps())).resolves.toEqual({
      remote: true,
      currency: "USD",
    });
    expect(requests).toHaveLength(2);
    expect(db.select().from(llm_calls).all()).toHaveLength(2);
  });

  it("treats max_tokens truncation as invalid output", async () => {
    respond = () => HttpResponse.json({ ...fixture("ok-haiku.json"), stop_reason: "max_tokens" });
    await expect(callStructured(opts(), deps())).rejects.toBeInstanceOf(LlmOutputError);
    expect(requests).toHaveLength(2);
  });

  it("does not retry past the budget", async () => {
    seedSpend("0.9999", nowDate.toISOString(), "2026-10-09");
    respond = () => HttpResponse.json(fixture("invalid-schema.json"));
    await expect(callStructured(opts({ maxTokens: 10 }), deps())).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(requests).toHaveLength(1);
  });
});

describe("errors and retries", () => {
  it("throws MissingApiKeyError and sends nothing", async () => {
    await expect(callStructured(opts(), deps({}))).rejects.toBeInstanceOf(MissingApiKeyError);
    expect(requests).toHaveLength(0);
  });

  it("retries 429 then 529 then succeeds (max 2 retries)", async () => {
    let n = 0;
    respond = () => {
      n++;
      if (n === 1)
        return HttpResponse.json(
          { type: "error", error: { type: "rate_limit_error", message: "x" } },
          { status: 429, headers: { "retry-after": "1" } },
        );
      if (n === 2)
        return HttpResponse.json(
          { type: "error", error: { type: "overloaded_error", message: "x" } },
          { status: 529 },
        );
      return HttpResponse.json(fixture("ok-haiku.json"));
    };
    await expect(callStructured(opts(), deps())).resolves.toBeDefined();
    expect(requests).toHaveLength(3);
    expect(db.select().from(llm_calls).all()).toHaveLength(1);
  });

  it("gives up after 2 retries and records an error row", async () => {
    respond = () =>
      HttpResponse.json(
        { type: "error", error: { type: "overloaded_error", message: "x" } },
        { status: 529 },
      );
    const err = await callStructured(opts(), deps()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmApiError);
    expect((err as LlmApiError).status).toBe(529);
    expect(requests).toHaveLength(3);
    const rows = db.select().from(llm_calls).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "error", cost_usd: "0.00000000" });
  });

  it("does not retry the monthly spend-cap 429 or a 400", async () => {
    respond = () =>
      HttpResponse.json(
        {
          type: "error",
          error: {
            type: "rate_limit_error",
            message: "x",
            details: { error_code: "enforced_spend_limit_reached" },
          },
        },
        { status: 429 },
      );
    await expect(callStructured(opts(), deps())).rejects.toBeInstanceOf(LlmApiError);
    expect(requests).toHaveLength(1);
    requests = [];
    respond = () =>
      HttpResponse.json(
        { type: "error", error: { type: "invalid_request_error", message: "x" } },
        { status: 400 },
      );
    await expect(callStructured(opts(), deps())).rejects.toBeInstanceOf(LlmApiError);
    expect(requests).toHaveLength(1);
  });
});

describe("secrets and content in logs", () => {
  it("never logs the key, prompts or output, and the key is not in errors", async () => {
    const SECRET_INPUT = "SECRET-POSTING-BODY-xyz";
    await callStructured(opts({ input: SECRET_INPUT, cacheablePrefix: "SECRET-CV-abc" }), deps());
    respond = () =>
      HttpResponse.json(
        { type: "error", error: { type: "authentication_error", message: `bad key ${KEY}` } },
        { status: 401 },
      );
    const err = await callStructured(opts({ input: SECRET_INPUT }), deps()).catch(
      (e: unknown) => e,
    );
    respond = () => HttpResponse.json(fixture("invalid-schema.json"));
    const err2 = await callStructured(opts(), deps()).catch((e: unknown) => e);
    seedSpend("1", nowDate.toISOString(), "2026-10-09");
    const err3 = await callStructured(opts(), deps()).catch((e: unknown) => e);
    const all = [
      ...lines,
      ...[err, err2, err3].map((e) => `${(e as Error).message}\n${(e as Error).stack}`),
    ].join("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const needle of [KEY, "sk-ant", SECRET_INPUT, "SECRET-CV-abc", '"remote"']) {
      expect(all).not.toContain(needle);
    }
  });
});

describe("single entry point", () => {
  it("no file other than llm/client.ts imports @anthropic-ai/sdk", () => {
    const root = resolve(here, "../../../..");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", "dist", ".worktrees", ".git", "data"].includes(name)) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (
          /\.(ts|tsx|js|mjs|cjs)$/.test(name) &&
          /@anthropic-ai\/sdk/.test(readFileSync(p, "utf-8"))
        ) {
          offenders.push(p.slice(root.length + 1));
        }
      }
    };
    walk(join(root, "packages"));
    walk(join(root, "scripts"));
    walk(join(root, "bin"));
    // this test file mentions the package name in its own source
    expect(
      offenders.filter(
        (f) => f !== "packages/core/src/llm/client.ts" && f !== "packages/core/src/llm/llm.test.ts",
      ),
    ).toEqual([]);
    expect(offenders).toContain("packages/core/src/llm/client.ts");
  });
});
