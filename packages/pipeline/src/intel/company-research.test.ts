import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import {
  __testInjectTimeAndSleep,
  companies,
  llm_calls,
  MissingApiKeyError,
  openDb,
  type Db,
} from "@job-agent/core";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  candidateUrls,
  defaultFetchPage,
  htmlToText,
  isDueForResearch,
  isLinkedInHost,
  researchCompanyPayPolicy,
} from "./company-research.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(here, "../../test/fixtures/anthropic", name), "utf-8"));

const API = "https://api.anthropic.com/v1/messages";
const NOW = new Date("2026-10-09T05:00:00Z");
const ENV = { ANTHROPIC_API_KEY: "sk-ant-test-key-0000" };
const PAGE =
  "<html><head><style>p{}</style><script>var x=1</script></head><body><h1>Careers</h1>" +
  "<p>We pay the same salary regardless of   where you live.</p></body></html>";

let apiCalls = 0;
let respond: () => Response = () => HttpResponse.json(fixture("company-research-flat.json"));
let pageRequests: string[] = [];
let pageHandler: (url: string) => Response = () => new HttpResponse(PAGE, { status: 200 });
const server = setupServer(
  http.post(API, () => {
    apiCalls += 1;
    return respond();
  }),
  http.get("https://acme.example/*", ({ request }) => {
    pageRequests.push(request.url);
    return pageHandler(request.url);
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
  apiCalls = 0;
  pageRequests = [];
  respond = () => HttpResponse.json(fixture("company-research-flat.json"));
  pageHandler = () => new HttpResponse(PAGE, { status: 200 });
  __testInjectTimeAndSleep(
    () => NOW,
    async () => {},
  );
  addCompany();
});

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
const row = () => db.select().from(companies).where(eq(companies.id, "c1")).get();
const deps = (over: Record<string, unknown> = {}) => ({ db, env: ENV, now: () => NOW, ...over });
const calls = () => db.select().from(llm_calls).all();

describe("company pay-policy research", () => {
  it("stores policy, careers:<url> source and the quoted sentence in the reason", async () => {
    const out = await researchCompanyPayPolicy("c1", deps());
    expect(out).toEqual({
      kind: "found",
      policy: "location_agnostic",
      source: "careers:https://acme.example/careers",
      reasons: [
        'pay policy location_agnostic from careers:https://acme.example/careers: "We pay the same salary regardless of where you live."',
      ],
    });
    expect(row()).toMatchObject({
      pay_policy: "location_agnostic",
      pay_policy_source: "careers:https://acme.example/careers",
      pay_policy_checked_at: NOW.toISOString(),
    });
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatchObject({ purpose: "company_research", company_id: "c1" });
  });

  it("researches a company at most once per 90 days", async () => {
    pageHandler = () => new HttpResponse("<p>Join us</p>", { status: 200 });
    respond = () => HttpResponse.json(fixture("company-research-none.json"));
    expect((await researchCompanyPayPolicy("c1", deps())).kind).toBe("unknown");
    const requestsAfterFirst = pageRequests.length;
    const callsAfterFirst = apiCalls;

    const later = new Date(NOW.getTime() + 89 * 86_400_000);
    const again = await researchCompanyPayPolicy("c1", deps({ now: () => later }));
    expect(again.kind).toBe("skipped");
    expect(pageRequests).toHaveLength(requestsAfterFirst);
    expect(apiCalls).toBe(callsAfterFirst);

    const due = new Date(NOW.getTime() + 91 * 86_400_000);
    expect((await researchCompanyPayPolicy("c1", deps({ now: () => due }))).kind).toBe("unknown");
    expect(apiCalls).toBeGreaterThan(callsAfterFirst);
  });

  it("does not research a company whose policy is already known or manual", async () => {
    db.update(companies).set({ pay_policy: "location_adjusted" }).run();
    expect((await researchCompanyPayPolicy("c1", deps())).kind).toBe("skipped");
    db.update(companies).set({ pay_policy: "unknown", pay_policy_source: "manual" }).run();
    expect((await researchCompanyPayPolicy("c1", deps())).kind).toBe("skipped");
    expect(pageRequests).toHaveLength(0);
    expect(apiCalls).toBe(0);
  });

  it("fetch failure keeps the policy unknown, sets checked_at, logs the reason, makes no LLM call", async () => {
    pageHandler = () => new HttpResponse("nope", { status: 404 });
    const out = await researchCompanyPayPolicy("c1", deps());
    expect(out.kind).toBe("unknown");
    if (out.kind === "unknown") expect(out.reasons[0]).toMatch(/no page fetched.*404/);
    expect(row()).toMatchObject({
      pay_policy: "unknown",
      pay_policy_source: null,
      pay_policy_checked_at: NOW.toISOString(),
    });
    expect(apiCalls).toBe(0);
  });

  it("no pay wording keeps the policy unknown and sets checked_at", async () => {
    respond = () => HttpResponse.json(fixture("company-research-none.json"));
    const out = await researchCompanyPayPolicy("c1", deps());
    expect(out.kind).toBe("unknown");
    expect(row()).toMatchObject({
      pay_policy: "unknown",
      pay_policy_source: null,
      pay_policy_checked_at: NOW.toISOString(),
    });
  });

  it("rejects a quote that is not on the page", async () => {
    respond = () => HttpResponse.json(fixture("company-research-madeup.json"));
    const out = await researchCompanyPayPolicy("c1", deps());
    expect(out.kind).toBe("unknown");
    expect(row()?.pay_policy).toBe("unknown");
    expect(row()?.pay_policy_checked_at).toBe(NOW.toISOString());
  });

  it("fetches at most 2 pages", async () => {
    respond = () => HttpResponse.json(fixture("company-research-none.json"));
    await researchCompanyPayPolicy("c1", deps());
    expect(pageRequests).toEqual(["https://acme.example/careers", "https://acme.example/jobs"]);
  });

  it("budget exceeded stores nothing so the company is retried", async () => {
    const out = await researchCompanyPayPolicy(
      "c1",
      deps({ env: { ...ENV, JOB_AGENT_LLM_CAP_USD: "0" } }),
    );
    expect(out.kind).toBe("retry");
    expect(row()?.pay_policy_checked_at).toBeNull();
    expect(apiCalls).toBe(0);
  });

  it("missing API key throws before any request", async () => {
    await expect(researchCompanyPayPolicy("c1", deps({ env: {} }))).rejects.toBeInstanceOf(
      MissingApiKeyError,
    );
    expect(pageRequests).toHaveLength(0);
    expect(row()?.pay_policy_checked_at).toBeNull();
  });

  it("invalid model output twice -> unknown with checked_at set", async () => {
    respond = () =>
      HttpResponse.json({
        ...fixture("company-research-none.json"),
        content: [{ type: "text", text: "{}" }],
      });
    const out = await researchCompanyPayPolicy("c1", deps());
    expect(out.kind).toBe("unknown");
    expect(apiCalls).toBe(4); // 2 pages x (call + one retry)
    expect(row()?.pay_policy_checked_at).toBe(NOW.toISOString());
  });
});

describe("domain guard", () => {
  it.each([
    "https://www.linkedin.com/company/acme",
    "https://linkedin.com/jobs",
    "http://uk.linkedin.com/x",
    "not a url",
  ])("%s is blocked", (u) => {
    expect(isLinkedInHost(u)).toBe(true);
  });

  it("never builds a linkedin candidate url", () => {
    for (const d of ["linkedin.com", "www.linkedin.com", "https://de.linkedin.com/company/x"]) {
      expect(candidateUrls(d)).toEqual([]);
    }
    expect(candidateUrls("https://acme.example/some/path")).toEqual([
      "https://acme.example/careers",
      "https://acme.example/jobs",
    ]);
    expect(candidateUrls(null)).toEqual([]);
    expect(candidateUrls("bad host!")).toEqual([]);
  });

  it("makes no request for a linkedin company domain, even with a key", async () => {
    db.update(companies).set({ domain: "www.linkedin.com" }).run();
    const fetched: string[] = [];
    const out = await researchCompanyPayPolicy("c1", {
      ...deps(),
      fetchPage: (url) => {
        fetched.push(url);
        return Promise.resolve({ finalUrl: url, body: PAGE });
      },
    });
    expect(fetched).toEqual([]);
    expect(out.kind).toBe("unknown");
    expect(row()?.pay_policy_checked_at).toBe(NOW.toISOString());
  });

  it("discards a page that redirected to linkedin", async () => {
    const out = await researchCompanyPayPolicy("c1", {
      ...deps(),
      fetchPage: (url) =>
        Promise.resolve({ finalUrl: "https://www.linkedin.com/login", body: PAGE + url }),
    });
    expect(out.kind).toBe("unknown");
    expect(apiCalls).toBe(0);
  });
});

describe("helpers", () => {
  it("htmlToText drops scripts, styles and tags", () => {
    expect(htmlToText(PAGE)).toBe("Careers We pay the same salary regardless of where you live.");
  });

  it("isDueForResearch boundaries", () => {
    const base = { pay_policy: "unknown", pay_policy_source: null, pay_policy_checked_at: null };
    expect(isDueForResearch(base, NOW)).toBe(true);
    expect(isDueForResearch({ ...base, pay_policy: null }, NOW)).toBe(true);
    expect(isDueForResearch({ ...base, pay_policy: "location_adjusted" }, NOW)).toBe(false);
    expect(
      isDueForResearch(
        { ...base, pay_policy_checked_at: new Date(NOW.getTime() - 90 * 86_400_000).toISOString() },
        NOW,
      ),
    ).toBe(true);
    expect(
      isDueForResearch(
        { ...base, pay_policy_checked_at: new Date(NOW.getTime() - 89 * 86_400_000).toISOString() },
        NOW,
      ),
    ).toBe(false);
  });
});

describe("defaultFetchPage redirect guard", () => {
  it("makes no request to linkedin after a redirect to it", async () => {
    let linkedinHit = false;
    const s = setupServer(
      http.get("https://acme.example/careers", () =>
        HttpResponse.text("", {
          status: 302,
          headers: { location: "https://www.linkedin.com/company/acme" },
        }),
      ),
      http.get("https://www.linkedin.com/company/acme", () => {
        linkedinHit = true;
        return HttpResponse.text("login");
      }),
    );
    s.listen({ onUnhandledRequest: "error" });
    try {
      await expect(defaultFetchPage("https://acme.example/careers")).rejects.toThrow();
      expect(linkedinHit).toBe(false);
    } finally {
      s.close();
    }
  });
});
