import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __testInjectTimeAndSleep,
  analysis,
  fetchAndStoreFx,
  intel,
  llm_calls,
  loadConfig,
  loadCv,
  log,
  openDb,
  postings,
  source_runs,
  type Db,
} from "@job-agent/core";
import { buildAdapters } from "@job-agent/sources";
import { eq } from "drizzle-orm";
import { http, HttpResponse, type HttpHandler } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runDigest } from "../src/digest/index.ts";
import { runDiscover } from "../src/discover.ts";
import { runEnrich } from "../src/enrich.ts";
import { runProcess } from "../src/process.ts";

// Phase 2 chain, offline: fx -> discover (all 13 adapters) -> process -> enrich (Anthropic via msw) -> digest.
// Only fixtures, the example configs and config/cv.example.md (fake persona); no live call.

const repo = new URL("../../../", import.meta.url);
const read = (rel: string, base = repo) => readFileSync(new URL(rel, base), "utf8");
const sourceFixture = (path: string) => read(`packages/sources/test/fixtures/${path}`);
const json = (path: string) => JSON.parse(sourceFixture(path)) as Record<string, unknown>;
const anthropicFixture = (name: string) =>
  JSON.parse(read(`fixtures/anthropic/${name}`, new URL("./", import.meta.url))) as {
    content: { type: string; text?: string }[];
  };

const NOW = new Date("2026-09-02T06:00:00Z");
const DATE = "2026-09-02";
const LATER = new Date("2026-09-03T06:00:00Z");
const ENV = { ANTHROPIC_API_KEY: "sk-ant-e2e-fake-0000" };

const COMPANIES = `companies:
  - { name: "GitLab", ats: greenhouse, slug: "gitlab" }
  - { name: "Lever Demo", ats: lever, slug: "leverdemo" }
  - { name: "Ramp", ats: ashby, slug: "ramp" }
  - { name: "bunq", ats: recruitee, slug: "bunq" }
  - { name: "Hugging Face", ats: workable, slug: "huggingface" }
  - { name: "Alpha Corp", ats: smartrecruiters, slug: "alpha" }
`;

const SOURCES = [
  "greenhouse",
  "lever",
  "ashby",
  "recruitee",
  "workable",
  "smartrecruiters",
  "himalayas",
  "remoteok",
  "remotive",
  "web3career",
  "weworkremotely",
  "hn",
  "arbeitnow",
] as const;

/** Injected Remotive items: one honest posting, one scam. Dates are inside the first run's look-back. */
const GOOD_DESC =
  "<p>Fixture Labs is hiring a senior frontend engineer for a worldwide remote team. " +
  "You will build the product UI with React and TypeScript, own Next.js performance and ship weekly. " +
  "We pay a listed range and apply through our own careers page.</p>";
const remotiveItem = (
  id: number,
  title: string,
  company: string,
  description: string,
  published = "2026-09-01T02:00:00",
) => ({
  id,
  url: `https://remotive.com/remote-jobs/software-dev/e2e-${id}`,
  title,
  company_name: company,
  category: "Software Development",
  tags: ["react", "typescript"],
  job_type: "full_time",
  publication_date: published,
  candidate_required_location: "Worldwide",
  salary: "",
  description,
});
let goodDescription = GOOD_DESC;
/** Remotive only returns items newer than the last run, so an edit is re-published with a newer date. */
let goodPublished = "2026-09-01T02:00:00";
const injectedItems = () => [
  remotiveItem(9900101, "Senior Frontend Engineer", "Fixture Labs", goodDescription, goodPublished),
  remotiveItem(
    9900102,
    "Senior React Engineer",
    "Fee Staffing Ltd",
    "<p>Remote React and TypeScript role. A registration fee is required to secure your position. " +
      "Message us on Telegram to start the interview. Senior engineers only.</p>",
  ),
];

const WWR = "https://weworkremotely.com/categories";
const HN = "https://hn.algolia.com/api/v1";
const rss = (body: string) =>
  new HttpResponse(body, { headers: { "Content-Type": "application/rss+xml" } });
const himalayas1 = json("himalayas/page1.json");
const himalayas2 = json("himalayas/page2.json");
const remotive = json("remotive/jobs.json");
const SR = "https://api.smartrecruiters.com/v1/companies/alpha/postings";

const fxFixture = {
  ...(JSON.parse(read("packages/core/test/fixtures/fx/er-api-usd.json")) as Record<
    string,
    unknown
  >),
  time_last_update_unix: NOW.getTime() / 1000,
};

/** SmartRecruiters fixtures are from months ago; re-stamp them into the first run's look-back window. */
const srJson = (path: string) =>
  JSON.parse(
    sourceFixture(path).replace(/("releasedDate":\s*")[^"]+/g, "$12026-09-01T03:00:00.000Z"),
  ) as Record<string, unknown>;

function sourceHandlers(): HttpHandler[] {
  const get = (url: string, respond: (req: Request) => Response) =>
    http.get(url, ({ request }) => respond(request));
  return [
    http.get("https://open.er-api.com/v6/latest/USD", () => HttpResponse.json(fxFixture)),
    get("https://boards-api.greenhouse.io/v1/boards/gitlab/jobs", () =>
      HttpResponse.json(json("greenhouse/board.json")),
    ),
    get("https://api.lever.co/v0/postings/leverdemo", () =>
      HttpResponse.json(json("lever/leverdemo.json")),
    ),
    get("https://api.ashbyhq.com/posting-api/job-board/ramp", () =>
      HttpResponse.json(json("ashby/ramp-board.json")),
    ),
    get("https://bunq.recruitee.com/api/offers/", () =>
      HttpResponse.json(json("recruitee/bunq-offers.json")),
    ),
    get("https://apply.workable.com/api/v1/widget/accounts/huggingface", () =>
      HttpResponse.json(json("workable/huggingface.json")),
    ),
    get(SR, () => HttpResponse.json(srJson("smartrecruiters/list.json"))),
    http.get(`${SR}/:id`, ({ params }) =>
      HttpResponse.json(srJson(`smartrecruiters/detail-${String(params["id"])}.json`)),
    ),
    get("https://himalayas.app/jobs/api", (req) =>
      new URL(req.url).searchParams.get("cursor") === null
        ? HttpResponse.json(himalayas1)
        : HttpResponse.json({ ...himalayas2, nextCursor: null }),
    ),
    get("https://remoteok.com/api", () => HttpResponse.json(json("remoteok/api.json"))),
    get("https://remotive.com/api/remote-jobs", () =>
      HttpResponse.json({
        ...remotive,
        jobs: [...(remotive["jobs"] as unknown[]), ...injectedItems()],
      }),
    ),
    get("https://web3.career/api/v1", () =>
      HttpResponse.json(json("web3career-live-2026-10-08.json")),
    ),
    ...Object.entries({
      "remote-front-end-programming-jobs": "front-end",
      "remote-full-stack-programming-jobs": "full-stack",
      "remote-programming-jobs": "programming",
    }).map(([feed, file]) =>
      get(`${WWR}/${feed}.rss`, () => rss(sourceFixture(`weworkremotely/${file}.rss`))),
    ),
    get(`${HN}/search_by_date`, () => HttpResponse.json(json("hn/search.json"))),
    get(`${HN}/items/:id`, () => HttpResponse.json(json("hn/items.json"))),
    get("https://www.arbeitnow.com/api/job-board-api", () =>
      HttpResponse.json(json("arbeitnow/page1.json")),
    ),
    // Domain-age lookups for the scam stage: the registry is unreachable, which must not break the run.
    http.get("https://data.iana.org/rdap/dns.json", () => new HttpResponse(null, { status: 503 })),
  ];
}

interface LlmRequest {
  model: string;
  messages: { content: string }[];
}
let llmRequests: LlmRequest[] = [];
/** Called per extraction call (after the response is chosen), so a test can burn the budget mid-run. */
let onExtractCall: ((n: number) => void) | null = null;

const llmHandler = http.post("https://api.anthropic.com/v1/messages", async ({ request }) => {
  const body = (await request.json()) as LlmRequest;
  llmRequests.push(body);
  if (body.model === "claude-sonnet-5-5") return HttpResponse.json(anthropicFixture("fit-ok.json"));
  const n = llmRequests.filter((r) => r.model !== "claude-sonnet-5-5").length;
  onExtractCall?.(n);
  return HttpResponse.json(anthropicFixture("extract-ok.json"));
});

const server = setupServer();
let dir: string;
let db: Db;
let clock: Date;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "e2e2-"));
  copyFileSync(new URL("config/salary.example.yaml", repo), join(dir, "salary.yaml"));
  writeFileSync(join(dir, "companies.yaml"), COMPANIES);
  copyFileSync(new URL("config/cv.example.md", repo), join(dir, "cv.md"));
  vi.stubEnv("JOB_AGENT_CONFIG_DIR", dir);
  vi.stubEnv("WEB3_CAREER_TOKEN", "fake-e2e-token");
  db = openDb(join(dir, "e2e.db"));
  clock = NOW;
  llmRequests = [];
  onExtractCall = null;
  goodDescription = GOOD_DESC;
  goodPublished = "2026-09-01T02:00:00";
  let t = NOW.getTime();
  __testInjectTimeAndSleep(
    () => new Date(Math.max(t, clock.getTime())),
    async (ms) => {
      t += ms;
    },
  );
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(log, level).mockImplementation(() => undefined);
  }
  server.use(...sourceHandlers(), llmHandler);
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
  server.resetHandlers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  __testInjectTimeAndSleep(
    () => new Date(),
    (ms) => new Promise((r) => setTimeout(r, ms)),
  );
});

const now = () => clock;
const io = (out: string[]) => ({
  out: (t: string) => out.push(t),
  err: (t: string) => out.push(t),
});

async function fetchAll(): Promise<number> {
  await fetchAndStoreFx(db, now);
  return runDiscover({
    db,
    adapters: buildAdapters(loadConfig()),
    force: true,
    now,
    out: () => {},
    err: () => {},
  });
}

async function enrich(env: Record<string, string | undefined> = ENV) {
  const out: string[] = [];
  const code = await runEnrich({
    db,
    salary: loadConfig().salary,
    env,
    cv: loadCv(dir),
    now,
    ...io(out),
  });
  return { code, out: out.join("") };
}

function digest(): string {
  const path = runDigest({ db, outDir: join(dir, "digests"), now, out: () => {} });
  return readFileSync(path, "utf8");
}

function section(md: string, heading: string): string {
  const start = md.indexOf(`## ${heading}`);
  if (start < 0) throw new Error(`no section ${heading}`);
  const rest = md.slice(start + 3);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

const titles = (s: string) => [...s.matchAll(/^### (.+)$/gm)].map((m) => m[1] as string);

describe("phase 2 pipeline end to end", () => {
  it("covers every adapter, including the four new ones", async () => {
    expect(await fetchAll()).toBe(0);
    const runs = db.select().from(source_runs).all();
    expect(runs.map((r) => r.source).sort()).toEqual([...SOURCES].sort());
    for (const r of runs) expect(r.status, r.source).toBe("ok");
    for (const r of runs) expect(r.found, r.source).toBeGreaterThan(0);
  });

  it("full run: ranked Top matches, each with a why line; the scam posting only under Suspicious", async () => {
    await fetchAll();
    expect(runProcess({ db, now, ...io([]) })).toBe(0);
    const r = await enrich();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/enriched \d+, budget_wait 0, failed 0/);
    const md = digest();

    const top = section(md, "Top matches");
    const entries = titles(top);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries).toContain("Senior Frontend Engineer — Fixture Labs");
    // Every entry carries a fit line, a tier/ask line and a why line.
    const blocks = top.split(/^### /m).slice(1);
    expect(blocks).toHaveLength(entries.length);
    for (const b of blocks) {
      expect(b).toMatch(/^- Fit: \d+\/100 \(rank -?\d+\)/m);
      expect(b).toMatch(/^- Tier \/ ask: /m);
      expect(b).toMatch(/^- Why: \S.+/m);
      expect(b).toContain("React and TypeScript");
    }
    // Ranked: the "(rank N)" values never increase down the list.
    const ranks = [...top.matchAll(/\(rank (-?\d+)\)/g)].map((m) => Number(m[1]));
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));

    // The suspicious posting appears only in Suspicious.
    const suspicious = section(md, "Suspicious");
    expect(titles(suspicious)).toEqual(["Senior React Engineer — Fee Staffing Ltd"]);
    expect(suspicious).toMatch(/^- Scam score: \d+/m);
    for (const name of ["Top matches", "Waiting for scoring", "Needs a look"]) {
      expect(section(md, name)).not.toContain("Fee Staffing Ltd");
    }
    const scam = db
      .select()
      .from(postings)
      .where(eq(postings.company_name, "Fee Staffing Ltd"))
      .get();
    const row = db
      .select()
      .from(intel)
      .where(eq(intel.posting_id, scam?.id ?? ""))
      .get();
    expect(row?.final_decision).toBe("suspicious");
    expect(row?.fit_score).toBeNull();
    // Fit is only ever requested for kept postings: one fit call per Top match.
    // (Same company + title in several cities is one digest entry, so entries <= kept postings.)
    const fitCalls = llmRequests.filter((q) => q.model === "claude-sonnet-5-5").length;
    expect(fitCalls).toBe(
      db.select().from(intel).where(eq(intel.final_decision, "keep")).all().length,
    );
    expect(fitCalls).toBeGreaterThanOrEqual(entries.length);
    expect(section(md, "Waiting for scoring")).toContain("None.");

    // Spend and source health sections.
    expect(section(md, "LLM spend")).toMatch(/claude-sonnet-5-5: \d+ calls?/);
    for (const s of SOURCES)
      expect(section(md, "Source health")).toMatch(new RegExp(`\\*\\*${s}\\*\\*: ok`));
  });

  it("budget runs out mid-run: the rest waits for scoring and the spend stays within $1", async () => {
    await fetchAll();
    runProcess({ db, now, ...io([]) });
    onExtractCall = (n) => {
      if (n !== 3) return;
      // The third extraction call uses up the day's budget (as the real ledger would).
      db.insert(llm_calls)
        .values({
          id: "burn",
          day: DATE,
          model: "claude-haiku-5-5",
          purpose: "extract",
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cost_usd: "0.9",
          status: "ok",
          created_at: NOW.toISOString(),
        })
        .run();
    };
    const r = await enrich();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/budget_wait [1-9]\d*/);
    const waiting = db.select().from(intel).where(eq(intel.status, "budget_wait")).all();
    expect(waiting.length).toBeGreaterThan(0);

    const md = digest();
    const wait = section(md, "Waiting for scoring");
    expect(titles(wait).length).toBeGreaterThan(0);
    expect(md).toContain(`- Waiting for scoring: ${titles(wait).length}`);
    expect(wait).toContain("waiting for the daily LLM budget");
    const spend = section(md, "LLM spend");
    const m = /\$(\d+\.\d+) of \$1\.00 cap/.exec(spend);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeLessThanOrEqual(1);
    const total = db
      .select()
      .from(llm_calls)
      .all()
      .reduce((s, c) => s + Number(c.cost_usd), 0);
    expect(total).toBeLessThanOrEqual(1);
    expect(md).toMatch(/^- Waiting for scoring: [1-9]/m);
  });

  it("no API key: no LLM call, exit 0, rule-only digest with everything waiting", async () => {
    expect(await fetchAll()).toBe(0);
    expect(runProcess({ db, now, ...io([]) })).toBe(0);
    const r = await enrich({});
    expect(r.code).toBe(0);
    expect(r.out).toContain("ANTHROPIC_API_KEY not set, LLM stages skipped");
    expect(llmRequests).toHaveLength(0);
    expect(db.select().from(llm_calls).all()).toHaveLength(0);
    expect(db.select().from(intel).where(eq(intel.status, "pending")).all().length).toBeGreaterThan(
      0,
    );

    const md = digest();
    expect(section(md, "Top matches")).toContain("None scored yet.");
    expect(titles(section(md, "Waiting for scoring")).length).toBeGreaterThan(0);
    // Without the LLM stages nothing can be called suspicious.
    expect(section(md, "Suspicious")).toContain("None.");
    expect(section(md, "LLM spend")).toContain("No LLM calls.");
  });

  it("a refreshed posting is dropped, re-processed and re-scored on the next day", async () => {
    await fetchAll();
    runProcess({ db, now, ...io([]) });
    await enrich();
    const before = db
      .select()
      .from(postings)
      .where(eq(postings.company_name, "Fixture Labs"))
      .get();
    expect(before?.updated_at).toBeNull();
    const id = before?.id ?? "";
    expect(db.select().from(intel).where(eq(intel.posting_id, id)).get()?.status).toBe("done");
    const callsBefore = llmRequests.length;

    // The employer edits the posting.
    goodDescription = GOOD_DESC.replace("ship weekly", "ship twice a week with a small team");
    goodPublished = "2026-09-03T01:00:00";
    clock = LATER;
    expect(await fetchAll()).toBe(0);
    const edited = db.select().from(postings).where(eq(postings.id, id)).get();
    expect(edited?.updated_at).toBe(LATER.toISOString());
    expect(edited?.description_text).toContain("twice a week");
    expect(db.select().from(intel).where(eq(intel.posting_id, id)).all()).toHaveLength(0);
    expect(db.select().from(analysis).where(eq(analysis.posting_id, id)).all()).toHaveLength(0);

    runProcess({ db, now, ...io([]) });
    const r = await enrich();
    expect(r.out).toMatch(/enriched 1,/);
    expect(llmRequests.length - callsBefore).toBe(2); // one extract + one fit, for this posting only
    const again = db.select().from(intel).where(eq(intel.posting_id, id)).get();
    expect(again?.status).toBe("done");
    expect(again?.fit_score).toBe(82);
    expect(titles(section(digest(), "Top matches"))).toContain(
      "Senior Frontend Engineer — Fixture Labs",
    );
  });
});
