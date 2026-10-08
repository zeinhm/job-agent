import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import {
  analysis,
  companies,
  intel,
  llm_calls,
  openDb,
  postings,
  type Db,
  type NewPosting,
} from "@job-agent/core";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { main } from "./cli.ts";
import { runEnrich } from "./enrich.ts";
import { ExtractionSchema } from "./intel/extract.ts";
import { PROMPT_VERSION } from "./intel/prompts/extract.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(here, "../test/fixtures/anthropic", name), "utf-8"));

const URL = "https://api.anthropic.com/v1/messages";
const NOW = new Date("2026-10-09T05:00:00Z"); // 12:00 WIB
const ENV = { ANTHROPIC_API_KEY: "sk-ant-test-key-0000" };

let requests: Record<string, unknown>[] = [];
let respond: () => Response | Promise<Response> = () =>
  HttpResponse.json(fixture("extract-ok.json"));
const server = setupServer(
  http.post(URL, async ({ request }) => {
    requests.push((await request.json()) as Record<string, unknown>);
    return respond();
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

let db: Db;
let n = 0;

function addPosting(
  id: string,
  decision: "keep" | "reject" = "keep",
  over: Partial<NewPosting> = {},
) {
  n += 1;
  db.insert(postings)
    .values({
      id,
      source: "test",
      external_id: id,
      url: `https://example.com/${id}`,
      title: "Senior Frontend Engineer",
      company_name: "Acme Inc",
      description_text: "Build things with React. Pay is the same worldwide.",
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
      decision,
      analyzed_at: NOW.toISOString(),
    })
    .run();
}

async function enrich(over: { env?: Record<string, string | undefined>; limit?: number } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runEnrich({
    db,
    env: over.env ?? ENV,
    limit: over.limit,
    now: () => NOW,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  return { code, out: out.join(""), err: err.join("") };
}

const intelOf = (id: string) => db.select().from(intel).where(eq(intel.posting_id, id)).get();

beforeEach(() => {
  db = openDb(":memory:");
  n = 0;
  requests = [];
  respond = () => HttpResponse.json(fixture("extract-ok.json"));
});
afterEach(() => server.resetHandlers());

describe("enrich", () => {
  it("sends only kept canonical postings (rejected posting -> 0 requests)", async () => {
    addPosting("rejected", "reject");
    addPosting("other", "reject");
    addPosting("dup", "keep", { canonical_posting_id: "other" });
    const r = await enrich();
    expect(requests).toHaveLength(0);
    expect(r.out).toBe("enriched 0, budget_wait 0, failed 0, spent $0.00 today\n");
    expect(intelOf("rejected")).toBeUndefined();
    expect(intelOf("dup")).toBeUndefined();
  });

  it("stores a validated extraction with model and prompt version", async () => {
    addPosting("p1");
    const r = await enrich();
    expect(r.code).toBe(0);
    expect(requests).toHaveLength(1);
    const row = intelOf("p1");
    expect(row?.status).toBe("done");
    expect(row?.extract_model).toBe("claude-haiku-5-5");
    expect(row?.extract_prompt_version).toBe(PROMPT_VERSION);
    const parsed = ExtractionSchema.parse(JSON.parse(row?.extraction ?? "null"));
    expect(parsed.payPolicy).toBe("location_agnostic");
    expect(parsed.listedSalary?.max).toBe(130000);
    expect(r.out).toMatch(/^enriched 1, budget_wait 0, failed 0, spent \$0\.\d\d today\n$/);
    expect(db.select().from(llm_calls).all()).toHaveLength(1);
  });

  it("resolve stage settles rule flags from the extraction and explains each change", async () => {
    addPosting("p1");
    db.update(analysis)
      .set({ flags: JSON.stringify(["location_unclear", "indonesia_unclear", "role_unclear"]) })
      .where(eq(analysis.posting_id, "p1"))
      .run();
    await enrich();
    const row = intelOf("p1");
    expect(row?.status).toBe("done");
    expect(row?.final_decision).toBe("keep");
    const reasons: string[] = JSON.parse(row?.resolved_reasons ?? "[]");
    expect(reasons).toHaveLength(3);
    expect(reasons[0]).toContain("worldwide");
    expect(reasons[1]).toContain("DE");
    expect(reasons[2]).toContain("senior");
  });

  it("resolve stage keeps unflagged postings untouched (empty reasons)", async () => {
    addPosting("p1");
    await enrich();
    const row = intelOf("p1");
    expect(row?.final_decision).toBe("keep");
    expect(row?.resolved_reasons).toBe("[]");
  });

  it("resolve stage can reject from facts (mid level with role_unclear)", async () => {
    const mid = fixture("extract-ok.json") as { content: { type: string; text?: string }[] };
    const block = mid.content[mid.content.length - 1];
    if (block?.text === undefined) throw new Error("fixture shape");
    block.text = JSON.stringify({ ...JSON.parse(block.text), seniority: "mid" });
    respond = () => HttpResponse.json(mid);
    addPosting("p1");
    db.update(analysis)
      .set({ flags: JSON.stringify(["role_unclear"]) })
      .where(eq(analysis.posting_id, "p1"))
      .run();
    await enrich();
    const row = intelOf("p1");
    expect(row?.final_decision).toBe("reject");
    expect(JSON.parse(row?.resolved_reasons ?? "[]")).toHaveLength(1);
  });

  it("asks only for facts: no keep/reject, tier or ask question in the prompt", async () => {
    addPosting("p1");
    await enrich();
    const system = JSON.stringify(requests[0]?.["system"]).toLowerCase();
    expect(system).toContain("you do not judge it");
    for (const word of [
      "tier",
      "keep or reject",
      "should we apply",
      "recommend the",
      "salary ask",
    ]) {
      expect(system).not.toContain(word);
    }
    const schema = JSON.stringify(requests[0]?.["output_config"]);
    for (const key of ["decision", "tier", "ask", "fit", "keep", "reject"]) {
      expect(schema).not.toContain(`"${key}"`);
    }
  });

  it("budget exceeded on posting 3 of 5 -> 2 done, 3 budget_wait, exit 0", async () => {
    for (const i of [1, 2, 3, 4, 5]) addPosting(`p${i}`);
    respond = () => {
      if (requests.length === 2) {
        // The second call used up the day's budget.
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
    };
    const r = await enrich();
    expect(r.code).toBe(0);
    expect(requests).toHaveLength(2);
    // newest first: p5, p4 are done
    expect(intelOf("p5")?.status).toBe("done");
    expect(intelOf("p4")?.status).toBe("done");
    for (const id of ["p3", "p2", "p1"]) expect(intelOf(id)?.status).toBe("budget_wait");
    expect(r.out).toBe("enriched 2, budget_wait 3, failed 0, spent $1.00 today\n");
  });

  it("missing key -> skip line, no requests, exit 0, postings stay pending", async () => {
    addPosting("p1");
    addPosting("p2");
    const r = await enrich({ env: {} });
    expect(r.code).toBe(0);
    expect(r.out).toBe("ANTHROPIC_API_KEY not set, LLM stages skipped\n");
    expect(requests).toHaveLength(0);
    expect(intelOf("p1")?.status).toBe("pending");
    expect(intelOf("p2")?.status).toBe("pending");
  });

  it("does not re-extract done postings, picks up budget_wait on the next run", async () => {
    addPosting("p1");
    addPosting("p2");
    db.insert(intel)
      .values({ id: "i2", posting_id: "p2", status: "budget_wait", updated_at: NOW.toISOString() })
      .run();
    await enrich();
    expect(requests).toHaveLength(2);
    await enrich();
    expect(requests).toHaveLength(2);
    expect(intelOf("p2")?.status).toBe("done");
  });

  it("invalid output -> retried once, then failed with Zod issue paths; not retried next run", async () => {
    addPosting("p1");
    respond = () => HttpResponse.json(fixture("extract-invalid.json"));
    const r = await enrich();
    expect(requests).toHaveLength(2);
    const row = intelOf("p1");
    expect(row?.status).toBe("failed");
    expect(row?.extraction).toBeNull();
    expect(JSON.parse(row?.resolved_reasons ?? "[]")).toContain("hiringScope: invalid_value");
    expect(r.out).toContain("enriched 0, budget_wait 0, failed 1");
    await enrich();
    expect(requests).toHaveLength(2);
  });

  it("processes newest first and honours --limit", async () => {
    addPosting("old", "keep", { posted_at: "2026-09-01T00:00:00Z" });
    addPosting("new", "keep", { posted_at: "2026-10-05T00:00:00Z" });
    await enrich({ limit: 1 });
    expect(requests).toHaveLength(1);
    expect(intelOf("new")?.status).toBe("done");
    expect(intelOf("old")).toBeUndefined();
  });

  it("rejects an invalid --limit", async () => {
    const r = await enrich({ limit: 0 });
    expect(r.code).toBe(1);
    expect(r.err).toContain("--limit");
  });

  it("never logs posting text", async () => {
    addPosting("p1", "keep", { description_text: "SECRET-POSTING-TEXT" });
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string) => (
      lines.push(String(c)),
      true
    )) as typeof process.stdout.write;
    try {
      await enrich();
    } finally {
      process.stdout.write = orig;
    }
    expect(lines.join("")).not.toContain("SECRET-POSTING-TEXT");
  });
});

describe("cli enrich", () => {
  it("is a registered command and rejects a bad --limit", async () => {
    const err: string[] = [];
    const code = await main(["enrich", "--limit", "abc"], {
      out: () => {},
      err: (t) => err.push(t),
    });
    expect(code).toBe(1);
    expect(err.join("")).not.toContain("Unknown command");
  });
});

describe("enrich pay-policy registry", () => {
  it("stores the stated policy on the company and records a conflict on the posting", async () => {
    db.insert(companies)
      .values({
        id: "c1",
        name: "Acme Inc",
        normalized_name: "acme",
        created_at: NOW.toISOString(),
      })
      .run();
    addPosting("p1", "keep", { company_id: "c1" });
    await enrich();
    const c = db.select().from(companies).get();
    expect(c?.pay_policy).toBe("location_agnostic");
    expect(c?.pay_policy_source).toBe("posting:p1");

    db.update(companies)
      .set({ pay_policy: "location_adjusted", pay_policy_source: "manual" })
      .run();
    addPosting("p2", "keep", { company_id: "c1" });
    await enrich();
    expect(db.select().from(companies).get()?.pay_policy).toBe("location_adjusted");
    expect(JSON.parse(intelOf("p2")?.resolved_reasons ?? "[]")).toEqual([
      "pay policy conflict: posting says location_agnostic, registry keeps location_adjusted (source manual)",
    ]);
  });
});
