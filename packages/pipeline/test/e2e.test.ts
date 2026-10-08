import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __testInjectTimeAndSleep,
  analysis,
  fetchAndStoreFx,
  loadConfig,
  log,
  openDb,
  postings,
  source_runs,
  type Db,
} from "@job-agent/core";
import { buildAdapters } from "@job-agent/sources";
import { eq, inArray } from "drizzle-orm";
import { http, HttpResponse, type HttpHandler } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runDigest } from "../src/digest/index.ts";
import { runDiscover } from "../src/discover.ts";
import { runProcess } from "../src/process.ts";

// Phase 1 chain, offline: fx -> discover (all nine adapters, forced) -> process -> digest.

const repo = new URL("../../../", import.meta.url);
const sourceFixture = (path: string) =>
  readFileSync(new URL(`packages/sources/test/fixtures/${path}`, repo), "utf8");
const json = (path: string) => JSON.parse(sourceFixture(path)) as Record<string, unknown>;

/**
 * Test clock. A first run looks back 7 days, and the oldest fixture boards (Lever, Ashby) have their
 * newest postings around 2026-09-01, so the run happens then. Newer fixture postings are kept as well.
 */
const NOW = new Date("2026-09-02T06:00:00Z");
const DATE = "2026-09-02";

const SOURCES = [
  "greenhouse",
  "lever",
  "ashby",
  "himalayas",
  "remoteok",
  "remotive",
  "web3career",
  "weworkremotely",
  "hn",
] as const;
type Source = (typeof SOURCES)[number];

/** Inline companies list: one company per ATS, each served by that adapter's recorded fixture. */
const COMPANIES = `companies:
  - { name: "GitLab", ats: greenhouse, slug: "gitlab" }
  - { name: "Lever Demo", ats: lever, slug: "leverdemo" }
  - { name: "Ramp", ats: ashby, slug: "ramp" }
`;

// The injected duplicate: a Remotive item with the same company + title as Greenhouse job 8857611002.
const injected = JSON.parse(
  readFileSync(new URL("fixtures/e2e/injected-duplicate-remotive.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

const remotive = json("remotive/jobs.json");
const himalayas1 = json("himalayas/page1.json");
const himalayas2 = json("himalayas/page2.json");
const HN = "https://hn.algolia.com/api/v1";
const WWR = "https://weworkremotely.com/categories";
const WWR_FEEDS = {
  "remote-front-end-programming-jobs": "front-end",
  "remote-full-stack-programming-jobs": "full-stack",
  "remote-programming-jobs": "programming",
};

const rss = (body: string) =>
  new HttpResponse(body, { headers: { "Content-Type": "application/rss+xml" } });

/** URL patterns and recorded responses per source. */
const routes: Record<Source, [url: string, respond: (req: Request) => Response][]> = {
  greenhouse: [
    [
      "https://boards-api.greenhouse.io/v1/boards/gitlab/jobs",
      () => HttpResponse.json(json("greenhouse/board.json")),
    ],
  ],
  lever: [
    [
      "https://api.lever.co/v0/postings/leverdemo",
      () => HttpResponse.json(json("lever/leverdemo.json")),
    ],
  ],
  ashby: [
    [
      "https://api.ashbyhq.com/posting-api/job-board/ramp",
      () => HttpResponse.json(json("ashby/ramp-board.json")),
    ],
  ],
  himalayas: [
    [
      "https://himalayas.app/jobs/api",
      (req) =>
        new URL(req.url).searchParams.get("cursor") === null
          ? HttpResponse.json(himalayas1)
          : HttpResponse.json({ ...himalayas2, nextCursor: null }),
    ],
  ],
  remoteok: [["https://remoteok.com/api", () => HttpResponse.json(json("remoteok/api.json"))]],
  remotive: [
    [
      "https://remotive.com/api/remote-jobs",
      () =>
        HttpResponse.json({ ...remotive, jobs: [...(remotive["jobs"] as unknown[]), injected] }),
    ],
  ],
  web3career: [
    [
      "https://web3.career/api/v1",
      () => HttpResponse.json(json("web3career-live-2026-10-08.json")),
    ],
  ],
  weworkremotely: Object.entries(WWR_FEEDS).map(([feed, file]) => [
    `${WWR}/${feed}.rss`,
    () => rss(sourceFixture(`weworkremotely/${file}.rss`)),
  ]),
  hn: [
    [`${HN}/search_by_date`, () => HttpResponse.json(json("hn/search.json"))],
    [`${HN}/items/:id`, () => HttpResponse.json(json("hn/items.json"))],
  ],
};

// Recorded FX rates, re-stamped to the test clock so they apply on the analysis date.
const fxFixture = {
  ...(JSON.parse(
    readFileSync(new URL("packages/core/test/fixtures/fx/er-api-usd.json", repo), "utf8"),
  ) as Record<string, unknown>),
  time_last_update_unix: NOW.getTime() / 1000,
};

function handlers(failing?: Source): HttpHandler[] {
  const list = [
    http.get("https://open.er-api.com/v6/latest/USD", () => HttpResponse.json(fxFixture)),
  ];
  for (const source of SOURCES) {
    for (const [url, respond] of routes[source]) {
      list.push(
        http.get(url, ({ request }) =>
          source === failing ? new HttpResponse(null, { status: 500 }) : respond(request),
        ),
      );
    }
  }
  return list;
}

const server = setupServer();
let dir: string;
let db: Db;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  // Temp config dir: the example salary config plus the inline companies list.
  dir = mkdtempSync(join(tmpdir(), "e2e-"));
  copyFileSync(new URL("config/salary.example.yaml", repo), join(dir, "salary.yaml"));
  writeFileSync(join(dir, "companies.yaml"), COMPANIES);
  vi.stubEnv("JOB_AGENT_CONFIG_DIR", dir);
  vi.stubEnv("WEB3_CAREER_TOKEN", "fake-e2e-token");
  db = openDb(join(dir, "e2e.db"));
  // No real waiting for per-host intervals and retry backoff: time only moves when a sleep is requested.
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

/** The same calls the CLI commands make: fx, discover --force, process, digest. */
async function runPipeline(failing?: Source) {
  server.use(...handlers(failing));
  const out: string[] = [];
  const io = { out: (t: string) => out.push(t), err: (t: string) => out.push(t) };
  const now = () => NOW;

  await fetchAndStoreFx(db, now);
  const discoverCode = await runDiscover({
    db,
    adapters: buildAdapters(loadConfig()),
    force: true,
    now,
    ...io,
  });
  const processCode = runProcess({ db, now, ...io });
  const digestDir = join(dir, "digests");
  const path = runDigest({ db, outDir: digestDir, now, out: io.out });
  return { discoverCode, processCode, path, digest: readFileSync(path, "utf8"), out: out.join("") };
}

function sourceHealth(digest: string): string {
  return digest.slice(digest.indexOf("## Source health"));
}

describe("phase 1 pipeline end to end", () => {
  it("runs fx -> discover -> process -> digest across all nine adapters", async () => {
    const { discoverCode, processCode, path, digest } = await runPipeline();
    expect(discoverCode).toBe(0);
    expect(processCode).toBe(0);

    // One ok run per adapter.
    const runs = db.select().from(source_runs).all();
    expect(runs).toHaveLength(SOURCES.length);
    expect(runs.map((r) => r.source).sort()).toEqual([...SOURCES].sort());
    for (const r of runs) expect(r.status, r.source).toBe("ok");
    for (const r of runs) expect(r.new, r.source).toBeGreaterThan(0);

    // Kept postings never come from a restricted location or a domestic Indonesian employer.
    const kept = db.select().from(analysis).where(eq(analysis.decision, "keep")).all();
    expect(kept.length).toBeGreaterThan(0);
    for (const a of kept) {
      expect(a.location_class).not.toBe("restricted");
      expect(a.indonesia_rule).not.toBe("domestic");
    }

    // The injected duplicate shares company and title across two sources. Its location is
    // "Remote, India", a country restriction, so it is classified restricted and stays out of the digest.
    const dupRows = db
      .select()
      .from(postings)
      .where(eq(postings.title, "Associate Renewals Manager, India"))
      .all();
    expect(dupRows.map((p) => p.source).sort()).toEqual(["greenhouse", "remotive"]);
    const dupAnalysis = db
      .select()
      .from(analysis)
      .where(
        inArray(
          analysis.posting_id,
          dupRows.map((p) => p.id),
        ),
      )
      .all();
    expect(dupAnalysis.length).toBeGreaterThan(0);
    for (const a of dupAnalysis) expect(a.location_class).toBe("restricted");
    expect(digest).not.toContain("### Associate Renewals Manager, India");

    // Digest file layout.
    expect(path).toBe(join(dir, "digests", `${DATE}.md`));
    expect(digest).toMatch(/^## (Matches|Needs a look)$/m);
    const health = sourceHealth(digest);
    for (const s of SOURCES) expect(health).toMatch(new RegExp(`^- \\*\\*${s}\\*\\*: ok,`, "m"));
    expect(health).not.toContain("NO SUCCESSFUL RUN");
  });

  it.each(SOURCES)("isolates an HTTP 500 from %s", async (failing) => {
    const { discoverCode, digest } = await runPipeline(failing);
    expect(discoverCode).toBe(1);

    const runs = db.select().from(source_runs).all();
    expect(runs).toHaveLength(SOURCES.length);
    for (const r of runs) expect(r.status, r.source).toBe(r.source === failing ? "error" : "ok");

    const bySource = new Map<string, number>();
    for (const p of db.select().from(postings).all()) {
      bySource.set(p.source, (bySource.get(p.source) ?? 0) + 1);
    }
    expect(bySource.get(failing)).toBeUndefined();
    for (const s of SOURCES.filter((x) => x !== failing)) {
      expect(bySource.get(s), s).toBeGreaterThan(0);
    }

    const health = sourceHealth(digest);
    expect(health).toMatch(
      new RegExp(`^- \\*\\*${failing}\\*\\*: error, .*NO SUCCESSFUL RUN$`, "m"),
    );
    for (const s of SOURCES.filter((x) => x !== failing)) {
      expect(health).toMatch(new RegExp(`^- \\*\\*${s}\\*\\*: ok,`, "m"));
    }
  });
});
