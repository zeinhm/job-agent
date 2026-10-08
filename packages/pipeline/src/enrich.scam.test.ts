import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import {
  __testInjectTimeAndSleep,
  analysis,
  intel,
  log,
  openDb,
  postings,
  type Db,
  type NewPosting,
} from "@job-agent/core";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runEnrich, type Stage } from "./enrich.ts";
import { reasonPoints } from "./intel/scam.ts";

const here = dirname(fileURLToPath(import.meta.url));
const extractOk = JSON.parse(
  readFileSync(resolve(here, "../test/fixtures/anthropic/extract-ok.json"), "utf-8"),
) as Record<string, unknown>;

const NOW = new Date("2026-10-09T05:00:00Z");
const ENV = { ANTHROPIC_API_KEY: "sk-ant-test-key-0000" };
const BOOTSTRAP = "https://data.iana.org/rdap/dns.json";
const REGISTRY = "https://rdap.registry.test/com/v1/";

let rdapStatus = 500;
let rdapCalls: string[] = [];
const server = setupServer(
  http.post("https://api.anthropic.com/v1/messages", () => HttpResponse.json(extractOk)),
  http.get(BOOTSTRAP, () =>
    HttpResponse.json({ version: "1.0", services: [[["com"], [REGISTRY]]] }),
  ),
  http.get(`${REGISTRY}domain/:name`, ({ params }) => {
    rdapCalls.push(String(params["name"]));
    if (rdapStatus !== 200) return new HttpResponse(null, { status: rdapStatus });
    return HttpResponse.json({
      events: [{ eventAction: "registration", eventDate: "2026-10-01T05:00:00Z" }],
    });
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

const intelOf = (id: string) => db.select().from(intel).where(eq(intel.posting_id, id)).get();
const reasonsOf = (id: string): string[] =>
  JSON.parse(intelOf(id)?.scam_reasons ?? "[]") as string[];

let laterStageRan: string[] = [];
const later: Stage = {
  name: "later",
  run(p) {
    laterStageRan.push(p.id);
    return Promise.resolve({ kind: "done", patch: { fit_score: 80 } });
  },
};

function enrich() {
  return runEnrich({
    db,
    env: ENV,
    now: () => NOW,
    out: () => {},
    err: () => {},
    extraStages: [later],
  });
}

beforeEach(() => {
  db = openDb(":memory:");
  n = 0;
  rdapStatus = 500;
  rdapCalls = [];
  laterStageRan = [];
  let t = NOW.getTime();
  __testInjectTimeAndSleep(
    () => new Date(t),
    async (ms) => {
      t += ms;
    },
  );
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(log, level).mockImplementation(() => undefined);
  }
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
  __testInjectTimeAndSleep(
    () => new Date(),
    (ms) => new Promise((r) => setTimeout(r, ms)),
  );
});

describe("enrich scam stage", () => {
  it("stores score and reasons; reasons sum to the score; a clean posting is kept and goes on", async () => {
    addPosting("clean");
    await enrich();
    const row = intelOf("clean");
    expect(row?.status).toBe("done");
    expect(row?.scam_score).toBe(0);
    expect(row?.final_decision).toBe("keep");
    expect(laterStageRan).toEqual(["clean"]);
    expect(intelOf("clean")?.fit_score).toBe(80);
  });

  it("a suspicious posting is flagged, never fit-scored and gets no ask", async () => {
    addPosting("scam", {
      description_text:
        "Remote assistant. A registration fee is required to secure your position. " +
        "Message us on Telegram to start. Responsibilities and requirements follow. ".repeat(5),
    });
    addPosting("clean");
    await enrich();
    const row = intelOf("scam");
    expect(row?.status).toBe("done");
    expect(row?.final_decision).toBe("suspicious");
    expect(row?.scam_score).toBeGreaterThanOrEqual(60);
    const lines = reasonsOf("scam");
    expect(lines.reduce((s, l) => s + reasonPoints(l), 0)).toBe(row?.scam_score);
    expect(lines.join("\n")).toContain("upfront_payment +60");
    // Nothing after the scam stage ran for it.
    expect(laterStageRan).toEqual(["clean"]);
    expect(row?.fit_score).toBeNull();
    expect(row?.tier).toBeNull();
    expect(row?.ask_idr_month).toBeNull();
    expect(row?.ask_usd_year).toBeNull();
    expect(row?.ask_text).toBeNull();
  });

  it("an RDAP failure neither raises nor lowers the score and adds `domain age unknown`", async () => {
    // Same posting twice: one with no domain to look up, one whose RDAP call fails.
    const text =
      "Message us on Telegram. " + "Responsibilities, requirements, you will, stack. ".repeat(10);
    addPosting("no-lookup", { description_text: text });
    addPosting("failing", { description_text: text, apply_url: "https://newco-jobs.com/apply" });
    rdapStatus = 500;
    await enrich();
    expect(rdapCalls).toContain("newco-jobs.com");
    const failing = intelOf("failing");
    expect(reasonsOf("failing").join("\n")).toContain("domain_age_unknown +0: domain age unknown");
    expect(failing?.scam_score).toBe(30);
    // Control: no domain to look up at all gives the same score.
    expect(intelOf("no-lookup")?.scam_score).toBe(30);
    expect(reasonsOf("no-lookup").join("\n")).not.toContain("domain age unknown");
  });

  it("a very new domain raises the score through the RDAP lookup", async () => {
    addPosting("new", { apply_url: "https://newco-jobs.com/apply" });
    rdapStatus = 200;
    await enrich();
    expect(intelOf("new")?.scam_score).toBe(30);
    expect(reasonsOf("new").join("\n")).toContain("new_domain +30");
  });

  it("looks a domain up once per run", async () => {
    addPosting("a", { apply_url: "https://newco-jobs.com/apply/1" });
    addPosting("b", { apply_url: "https://newco-jobs.com/apply/2" });
    rdapStatus = 200;
    await enrich();
    expect(rdapCalls).toEqual(["newco-jobs.com"]);
  });
});
