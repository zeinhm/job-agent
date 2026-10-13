import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import {
  __testInjectTimeAndSleep,
  analysis,
  companies,
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
import { runEnrich } from "./enrich.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(here, "../test/fixtures/anthropic", name), "utf-8"));

// Numbers of config/salary.example.yaml (fake persona), through the real loader.
const configDir = mkdtempSync(join(tmpdir(), "job-agent-enrich-research-"));
const exampleDir = resolve(here, "../../../config");
copyFileSync(join(exampleDir, "salary.example.yaml"), join(configDir, "salary.yaml"));
copyFileSync(join(exampleDir, "companies.example.yaml"), join(configDir, "companies.yaml"));
const SALARY = loadConfig(configDir).salary;
afterAll(() => rmSync(configDir, { recursive: true, force: true }));

const CV = readFileSync(resolve(here, "../../../config/cv.example.md"), "utf-8");
const API = "https://api.anthropic.com/v1/messages";
const NOW = new Date("2026-10-09T05:00:00Z");
const ENV = { ANTHROPIC_API_KEY: "sk-ant-test-key-0000" };
const PAGE =
  "<html><body><h1>Careers</h1><p>We pay the same salary regardless of where you live.</p></body></html>";

type Req = { model: string; messages: { content: string }[] };
const isResearch = (r: Req): boolean => r.messages[0]?.content.startsWith("Page text:") ?? false;

/** Extraction without a listed range or stated policy: the tier depends on the registry policy only. */
function extraction(over: Record<string, unknown> = {}): Record<string, unknown> {
  const msg = fixture("extract-ok.json") as { content: { text?: string }[] };
  const block = msg.content[msg.content.length - 1];
  if (block?.text === undefined) throw new Error("fixture shape");
  block.text = JSON.stringify({
    ...JSON.parse(block.text),
    listedSalary: null,
    listedSalaryScope: "unknown",
    payPolicy: "unknown",
    ...over,
  });
  return msg;
}

let extractBody: Record<string, unknown>;
let researchBody: () => Record<string, unknown>;
let researchRequests = 0;
let extractRequests = 0;
let pageRequests: string[] = [];
let pageHandler: () => Response;
let afterExtract: () => void = () => {};
let db: Db;
let n = 0;

const server = setupServer(
  http.post(API, async ({ request }) => {
    const body = (await request.json()) as Req;
    if (isResearch(body)) {
      researchRequests += 1;
      return HttpResponse.json(researchBody());
    }
    if (body.model === "claude-sonnet-5-5") return HttpResponse.json(fixture("fit-ok.json"));
    extractRequests += 1;
    afterExtract();
    return HttpResponse.json(extractBody);
  }),
  http.get("https://acme.example/*", ({ request }) => {
    pageRequests.push(request.url);
    return pageHandler();
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

function addCompany(over: Partial<typeof companies.$inferInsert> = {}) {
  db.insert(companies)
    .values({
      id: "c1",
      name: "Acme",
      normalized_name: "acme",
      domain: "acme.example",
      pay_policy: "unknown",
      created_at: "2026-10-01T00:00:00Z",
      ...over,
    })
    .run();
}

function addPosting(id: string, over: Partial<NewPosting> = {}) {
  n += 1;
  db.insert(postings)
    .values({
      id,
      source: "test",
      external_id: id,
      url: `https://example.com/${id}`,
      title: "Senior Frontend Engineer",
      company_id: "c1",
      company_name: "Acme",
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

async function enrich(over: Partial<Parameters<typeof runEnrich>[0]> = {}) {
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
    ...over,
  });
  return { code, out: out.join(""), err: err.join("") };
}

const intelOf = (id: string) => db.select().from(intel).where(eq(intel.posting_id, id)).get();
const company = () => db.select().from(companies).where(eq(companies.id, "c1")).get();
const purposes = () =>
  db
    .select()
    .from(llm_calls)
    .all()
    .map((c) => c.purpose)
    .sort();

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
  __testInjectTimeAndSleep(
    () => NOW,
    async () => {},
  );
  n = 0;
  extractBody = extraction();
  researchBody = () => fixture("company-research-flat.json");
  researchRequests = 0;
  extractRequests = 0;
  pageRequests = [];
  pageHandler = () => new HttpResponse(PAGE, { status: 200 });
  afterExtract = () => {};
  addCompany();
});

describe("enrich company pay-policy research", () => {
  it("researches a company once per run, stores the check and logs one company_research call", async () => {
    addPosting("p1");
    addPosting("p2");
    const r = await enrich();
    expect(r.code).toBe(0);
    expect(researchRequests).toBe(1);
    expect(pageRequests).toEqual(["https://acme.example/careers", "https://acme.example/jobs"]);
    expect(extractRequests).toBe(2);
    expect(purposes()).toEqual(["company_research", "extract", "extract", "fit", "fit"]);
    expect(company()).toMatchObject({
      pay_policy: "location_agnostic",
      pay_policy_source: "careers:https://acme.example/careers",
      pay_policy_checked_at: NOW.toISOString(),
    });
    expect(intelOf("p1")?.status).toBe("done");
    expect(intelOf("p2")?.status).toBe("done");
    expect(r.err).toBe("");
  });

  it("prints the research counts in the summary", async () => {
    addCompany({ id: "c2", name: "Globex", normalized_name: "globex", domain: null });
    addCompany({ id: "c3", name: "Initech", normalized_name: "initech", domain: "acme.example" });
    addPosting("p1");
    addPosting("p2", { company_id: "c2", company_name: "Globex" });
    addPosting("p3", { company_id: "c3", company_name: "Initech" });
    let page = 0;
    pageHandler = () => {
      page += 1;
      // c1 (2 pages, found on the first); c3 pages fail
      return page <= 1
        ? new HttpResponse(PAGE, { status: 200 })
        : new HttpResponse("x", { status: 500 });
    };
    const r = await enrich();
    expect(r.out).toContain(
      "research: checked 3, found 1, no domain 1, fetch failed 1, no wording 0\n",
    );
  });

  it("an unknown policy that research cannot resolve is still attempted only once per run", async () => {
    researchBody = () => fixture("company-research-none.json");
    addPosting("p1");
    addPosting("p2");
    await enrich();
    // two pages, one model call each, for the first posting only
    expect(researchRequests).toBe(2);
    expect(company()?.pay_policy_checked_at).toBe(NOW.toISOString());
    expect(company()?.pay_policy).toBe("unknown");
  });

  it("the researched policy decides the tier of the same run's posting", async () => {
    addPosting("p1");
    await enrich();
    const row = intelOf("p1");
    expect(row?.tier).toBe("global_flat");
    expect(row?.ask_usd_year).toBe(SALARY.tiers.global_flat.ask_usd_year);
    expect(row?.ask_reason).toContain("careers:https://acme.example/careers");
    expect(JSON.parse(row?.resolved_reasons ?? "[]")[0]).toContain(
      "location_agnostic from careers:",
    );
  });

  it("without research (policy stays unknown) the same posting gets the regional ask", async () => {
    researchBody = () => fixture("company-research-none.json");
    addPosting("p1");
    await enrich();
    expect(intelOf("p1")?.tier).toBe("regional");
  });

  it("does not research a company checked within 90 days", async () => {
    db.update(companies)
      .set({
        pay_policy_checked_at: new Date(NOW.getTime() - 89 * 86_400_000).toISOString(),
        pay_policy_source: "research:no pay wording",
      })
      .run();
    addPosting("p1");
    await enrich();
    expect(pageRequests).toHaveLength(0);
    expect(researchRequests).toBe(0);
    expect(purposes()).toEqual(["extract", "fit"]);
  });

  it("researches again once 90 days have passed", async () => {
    db.update(companies)
      .set({ pay_policy_checked_at: new Date(NOW.getTime() - 91 * 86_400_000).toISOString() })
      .run();
    addPosting("p1");
    await enrich();
    expect(researchRequests).toBe(1);
  });

  it("does not research a company with a known policy", async () => {
    db.update(companies)
      .set({ pay_policy: "location_adjusted", pay_policy_source: "manual" })
      .run();
    addPosting("p1");
    await enrich();
    expect(pageRequests).toHaveLength(0);
    expect(researchRequests).toBe(0);
  });

  it("never researches for suspicious or rejected postings", async () => {
    addPosting("scam", {
      description_text:
        "Remote assistant. A registration fee is required to secure your position. " +
        "Message us on Telegram to start. Responsibilities and requirements follow. ".repeat(5),
    });
    addPosting("midlevel", { company_id: "c1" });
    db.update(analysis)
      .set({ flags: JSON.stringify(["role_unclear"]) })
      .where(eq(analysis.posting_id, "midlevel"))
      .run();
    extractBody = extraction({ seniority: "mid" });
    await enrich();
    expect(intelOf("scam")?.final_decision).toBe("suspicious");
    expect(intelOf("midlevel")?.final_decision).toBe("reject");
    expect(pageRequests).toHaveLength(0);
    expect(researchRequests).toBe(0);
    expect(company()?.pay_policy_checked_at).toBeNull();
  });

  it("a posting without a company is not researched", async () => {
    addPosting("p1", { company_id: null });
    await enrich();
    expect(researchRequests).toBe(0);
    expect(intelOf("p1")?.status).toBe("done");
  });

  it("budget reached during research: posting waits, later postings make no calls", async () => {
    addPosting("p1");
    addPosting("p2");
    // After the first extraction the day's spend leaves no room for the research call.
    afterExtract = () => {
      db.insert(llm_calls)
        .values({
          id: "spent",
          day: "2026-10-09",
          model: "claude-haiku-5-5",
          purpose: "extract",
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cost_usd: "0.9999",
          status: "ok",
          created_at: NOW.toISOString(),
        })
        .onConflictDoNothing()
        .run();
    };
    const r = await enrich();
    expect(r.out).toContain("budget_wait 2");
    expect(intelOf("p1")?.status).toBe("budget_wait");
    expect(intelOf("p2")?.status).toBe("budget_wait");
    expect(researchRequests).toBe(0);
    expect(extractRequests).toBe(1);
    expect(company()?.pay_policy_checked_at).toBeNull();
  });

  it("a fetch failure leaves the policy unknown, finishes the posting and warns once", async () => {
    pageHandler = () => new HttpResponse("nope", { status: 404 });
    addPosting("p1");
    addPosting("p2");
    const r = await enrich();
    expect(intelOf("p1")?.status).toBe("done");
    expect(intelOf("p1")?.tier).toBe("regional");
    expect(intelOf("p2")?.status).toBe("done");
    expect(researchRequests).toBe(0);
    const lines = r.err.split("\n").filter(Boolean);
    expect(lines).toEqual(["pay-policy research failed for Acme, policy stays unknown"]);
  });

  it("a model API failure does not fail the posting and warns once", async () => {
    server.use(
      http.post(API, async ({ request }) => {
        const body = (await request.json()) as Req;
        if (isResearch(body)) {
          researchRequests += 1;
          return HttpResponse.json(
            { type: "error", error: { type: "api_error", message: "x" } },
            { status: 500 },
          );
        }
        return HttpResponse.json(
          body.model === "claude-sonnet-5-5" ? fixture("fit-ok.json") : extractBody,
        );
      }),
    );
    addPosting("p1");
    addPosting("p2");
    const r = await enrich();
    expect(intelOf("p1")?.status).toBe("done");
    expect(intelOf("p2")?.status).toBe("done");
    expect(r.err.split("\n").filter(Boolean)).toEqual([
      "pay-policy research failed for Acme, policy stays unknown",
    ]);
    // not stored as checked, retried on the next run
    expect(company()?.pay_policy_checked_at).toBeNull();
  });

  it("a redirect to another host is refused and never requested", async () => {
    let otherHit = false;
    server.use(
      http.get("https://acme.example/*", () =>
        HttpResponse.text("", {
          status: 302,
          headers: { location: "https://other.example/careers" },
        }),
      ),
      http.get("https://other.example/*", () => {
        otherHit = true;
        return HttpResponse.text(PAGE);
      }),
    );
    addPosting("p1");
    const r = await enrich();
    expect(otherHit).toBe(false);
    expect(researchRequests).toBe(0);
    expect(intelOf("p1")?.status).toBe("done");
    expect(r.err).toContain("pay-policy research failed for Acme");
  });

  it("a redirect to linkedin is refused and never requested", async () => {
    let linkedinHit = false;
    server.use(
      http.get("https://acme.example/*", () =>
        HttpResponse.text("", {
          status: 302,
          headers: { location: "https://www.linkedin.com/company/acme" },
        }),
      ),
      http.get("https://www.linkedin.com/*", () => {
        linkedinHit = true;
        return HttpResponse.text(PAGE);
      }),
    );
    addPosting("p1");
    await enrich();
    expect(linkedinHit).toBe(false);
    expect(researchRequests).toBe(0);
  });

  it("no API key: skip line, no research call", async () => {
    addPosting("p1");
    const r = await enrich({ env: {} });
    expect(r.out).toContain("ANTHROPIC_API_KEY not set, LLM stages skipped");
    expect(pageRequests).toHaveLength(0);
    expect(researchRequests).toBe(0);
    expect(db.select().from(llm_calls).all()).toHaveLength(0);
  });
});
