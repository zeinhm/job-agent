import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fx_rates, openDb, reviews, source_runs } from "@job-agent/core";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "./cli.ts";
import { getQueue } from "./review/queue.ts";
import { seedDemo } from "./seed-demo.ts";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) } };
}

describe("main", () => {
  it("prints usage and returns 1 for an unknown command", async () => {
    const c = capture();
    expect(await main(["foo"], c.io)).toBe(1);
    expect(c.err.join("")).toContain("Unknown command: foo");
    expect(c.err.join("")).toContain("Usage: job-agent");
  });

  it("prints usage and returns 1 when no command is given", async () => {
    const c = capture();
    expect(await main([], c.io)).toBe(1);
    expect(c.err.join("")).toContain("Usage: job-agent");
  });
});

describe("discover command", () => {
  const exampleDir = join(dirname(fileURLToPath(import.meta.url)), "../../../config");

  function withEnv(): string {
    const dir = mkdtempSync(join(tmpdir(), "job-agent-cli-"));
    copyFileSync(join(exampleDir, "salary.example.yaml"), join(dir, "salary.yaml"));
    copyFileSync(join(exampleDir, "companies.example.yaml"), join(dir, "companies.yaml"));
    vi.stubEnv("JOB_AGENT_CONFIG_DIR", dir);
    vi.stubEnv("JOB_AGENT_DB", ":memory:");
    return dir;
  }

  it("exits 1 with the valid names for an unknown --source", async () => {
    const dir = withEnv();
    try {
      const c = capture();
      expect(await main(["discover", "--source", "nope"], c.io)).toBe(1);
      expect(c.err.join("")).toContain("Unknown source: nope");
      expect(c.err.join("")).toContain("Valid sources:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 0 when every registered adapter returns no postings", async () => {
    server.use(
      http.get("https://api.ashbyhq.com/posting-api/job-board/example", () =>
        HttpResponse.json({ jobs: [] }),
      ),
      http.get("https://himalayas.app/jobs/api", () =>
        HttpResponse.json({ jobs: [], nextCursor: null }),
      ),
      http.get("https://hn.algolia.com/api/v1/search_by_date", () =>
        HttpResponse.json({
          hits: [{ objectID: "1", title: "Ask HN: Who is hiring? (May 2026)" }],
        }),
      ),
      http.get("https://hn.algolia.com/api/v1/items/1", () => HttpResponse.json({ children: [] })),
      http.get("https://remoteok.com/api", () => HttpResponse.json([{ legal: "terms" }])),
      http.get("https://remotive.com/api/remote-jobs", () => HttpResponse.json({ jobs: [] })),
      http.get("https://www.arbeitnow.com/api/job-board-api", () =>
        HttpResponse.json({ data: [], links: { next: null } }),
      ),
      http.get(/^https:\/\/weworkremotely\.com\/categories\/.*\.rss$/, () =>
        HttpResponse.xml(
          '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title></channel></rss>',
        ),
      ),
      http.get("https://web3.career/api/v1", () => HttpResponse.json(["title", "notes", []])),
    );
    const dir = withEnv();
    vi.stubEnv("WEB3_CAREER_TOKEN", "test-token");
    try {
      const c = capture();
      expect(await main(["discover", "--force"], c.io)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // The http client enforces a 2s gap per host (weworkremotely: 3 feeds, hn: 2 calls).
  }, 20_000);
});

describe("fx command", () => {
  const fixture = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../core/test/fixtures/fx/er-api-usd.json"),
    "utf-8",
  );

  function withDb(): { dir: string; db: string } {
    const dir = mkdtempSync(join(tmpdir(), "job-agent-fx-"));
    const db = join(dir, "t.db");
    vi.stubEnv("JOB_AGENT_DB", db);
    return { dir, db };
  }

  function countRows(path: string): number {
    const db = openDb(path);
    try {
      return db.select().from(fx_rates).all().length;
    } finally {
      db.$client.close();
    }
  }

  it("stores the fixture rates, prints them, and is idempotent", async () => {
    const { dir, db } = withDb();
    try {
      vi.stubGlobal("fetch", async () => new Response(fixture, { status: 200 }));
      const c = capture();
      expect(await main(["fx"], c.io)).toBe(0);
      expect(c.out.join("")).toContain("2026-10-06 USD/IDR 17892.583535");
      expect(countRows(db)).toBe(7);
      expect(await main(["fx"], capture().io)).toBe(0);
      expect(countRows(db)).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 with the error and writes no rows on HTTP failure", async () => {
    const { dir, db } = withDb();
    try {
      vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
      const c = capture();
      expect(await main(["fx"], c.io)).toBe(1);
      expect(c.err.join("")).toContain("fx failed");
      expect(countRows(db)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("review-stats command", () => {
  const DATE = "2026-03-10";

  it("prints counts, times and the done-when line for --date", async () => {
    const dir = mkdtempSync(join(tmpdir(), "job-agent-stats-"));
    vi.stubEnv("JOB_AGENT_DB", join(dir, "t.db"));
    try {
      const db = openDb(join(dir, "t.db"));
      seedDemo(db, DATE);
      const q = getQueue(db, DATE);
      const ids = [...q.sections.top, ...q.sections.suspicious].map((i) => i.postingId);
      ids.forEach((id, i) =>
        db
          .insert(reviews)
          .values({
            id: `r${i}`,
            posting_id: id,
            action: "interested",
            reviewed_at: `2026-03-10T03:${String(i * 4).padStart(2, "0")}:00.000Z`,
            review_day: DATE,
          })
          .run(),
      );
      db.$client.close();

      const c = capture();
      expect(await main(["review-stats", "--date", DATE], c.io)).toBe(0);
      const text = c.out.join("");
      expect(text).toContain("matches: 5, processed: 5, open: 0");
      expect(text).toContain("elapsed: 16 min, median per processed posting: 240 s");
      expect(text.trimEnd().split("\n").at(-1)).toBe("done-when: 16 min for 5 matches (met)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an invalid --date with exit 1", async () => {
    const c = capture();
    expect(await main(["review-stats", "--date", "2026-02-30"], c.io)).toBe(1);
    expect(c.err.join("")).toContain("review-stats: invalid --date");
  });
});

describe("status and digest --out-dir", () => {
  it("digest --out-dir writes there; status prints row counts and the latest run per source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "job-agent-status-"));
    vi.stubEnv("JOB_AGENT_DB", join(dir, "t.db"));
    try {
      const db = openDb(join(dir, "t.db"));
      db.insert(source_runs)
        .values([
          {
            id: "1",
            source: "remotive",
            started_at: "2026-01-01T00:00:00Z",
            finished_at: "2026-01-01T00:00:01Z",
            status: "ok",
            found: 3,
            new: 3,
          },
          {
            id: "2",
            source: "remotive",
            started_at: "2026-01-02T00:00:00Z",
            finished_at: "2026-01-02T00:00:01Z",
            status: "error",
            found: 0,
            new: 0,
            error_message: "boom",
          },
        ])
        .run();
      db.$client.close();

      const s = capture();
      expect(await main(["status"], s.io)).toBe(0);
      const text = s.out.join("");
      expect(text).toContain("source_runs: 2");
      expect(text).toContain("remotive: error, found 0, new 0, boom");
      expect(text).not.toContain("remotive: ok");

      const d = capture();
      expect(
        await main(["digest", "--date", "2026-01-03", "--out-dir", join(dir, "dg")], d.io),
      ).toBe(0);
      expect(d.out.join("").trim()).toBe(join(dir, "dg", "2026-01-03.md"));
      expect(readFileSync(join(dir, "dg", "2026-01-03.md"), "utf-8")).toContain("2026-01-03");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
