import { eq } from "drizzle-orm";
import {
  __testInjectTimeAndSleep,
  description_runs,
  fx_rates,
  openDb,
  postings,
  SourceBlockedError,
  type Db,
  type NewPosting,
} from "@job-agent/core";
import type { DetailFetcher } from "@job-agent/sources";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { boardJobRef, jobTitleKey } from "./ats-match.ts";
import { runFetchDescriptions, selectForDescription } from "./fetch-descriptions.ts";
import { runProcess } from "./process.ts";

const START = Date.parse("2026-10-16T03:00:00Z");
const HOUR = 3_600_000;
const BOARD_TEXT =
  "Board text for the role. Fully remote worldwide, React and TypeScript, English only.";

let db: Db;
let clock: number;
let n: number;
const now = () => new Date(clock);
const iso = (ms: number) => new Date(ms).toISOString();

// A Greenhouse job link whose board cannot be verified is fetched by the ATS-link route: the recorded API answers 404.
const server = setupServer(
  http.get("https://boards-api.greenhouse.io/*", () => new HttpResponse(null, { status: 404 })),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

beforeEach(() => {
  db = openDb(":memory:");
  clock = START;
  n = 0;
  __testInjectTimeAndSleep(
    () => new Date(clock),
    async (ms) => {
      clock += ms;
    },
  );
  db.insert(fx_rates)
    .values({
      id: "fx1",
      date: "2026-10-15",
      base: "USD",
      quote: "IDR",
      rate: "16000",
      source: "test",
      fetched_at: iso(START),
    })
    .run();
});

/** A LinkedIn row as the JobSpy worker's output is stored: no description, `apply_url` = job_url_direct when it has one. */
function li(id: string, over: Partial<NewPosting> = {}) {
  n += 1;
  db.insert(postings)
    .values({
      id,
      source: "linkedin",
      external_id: `5000000${String(n).padStart(2, "0")}`,
      url: `https://www.linkedin.com/jobs/view/5000000${String(n).padStart(2, "0")}`,
      title: "Senior Frontend Engineer",
      company_name: "Fake Co",
      location_text: "Worldwide",
      remote: true,
      posted_at: iso(START - 2 * HOUR + n * 60_000),
      first_seen_at: iso(START - 2 * HOUR + n * 60_000),
      last_seen_at: iso(START - 2 * HOUR + n * 60_000),
      ...over,
    })
    .run();
}

/** A board row as the Greenhouse / Lever / Ashby adapters store it. */
function board(
  id: string,
  source: "greenhouse" | "lever" | "ashby",
  over: Partial<NewPosting> = {},
) {
  const urls = {
    greenhouse: `https://boards.greenhouse.io/fakeco/jobs/${id}`,
    lever: `https://jobs.lever.co/fakeco/${id}`,
    ashby: `https://jobs.ashbyhq.com/fakeco/${id}`,
  };
  db.insert(postings)
    .values({
      id: `b-${id}`,
      source,
      external_id: id,
      url: urls[source],
      apply_url: urls[source],
      title: "Senior Frontend Engineer",
      company_name: "Fake Co",
      description_text: BOARD_TEXT,
      location_text: "Worldwide",
      remote: true,
      first_seen_at: iso(START - 5 * HOUR),
      last_seen_at: iso(START - HOUR),
      ...over,
    })
    .run();
}

function process() {
  const code = runProcess({
    db,
    floorIdrMonth: 10_000_000,
    now,
    out: () => {},
    err: () => {},
  });
  expect(code).toBe(0);
}

const row = (id: string) => {
  const r = db.select().from(postings).where(eq(postings.id, id)).get();
  if (r === undefined) throw new Error(`no row ${id}`);
  return r;
};

async function step(fetchDescription: DetailFetcher) {
  const out: string[] = [];
  const code = await runFetchDescriptions({
    db,
    fetchDescription,
    sleep: async (ms) => {
      clock += ms;
    },
    now,
    floorIdrMonth: 10_000_000,
    out: (t) => out.push(t),
    err: () => {},
  });
  return { code, out: out.join("") };
}

/** A worker that must not be called. */
const noRequest: DetailFetcher = async () => {
  throw new Error("a LinkedIn request was sent");
};

describe("why the free route found 0 on every run (root cause)", () => {
  it("check 3: dedupe_hash is set on the LinkedIn rows when the step runs (process hashes before it)", () => {
    li("p1");
    process();
    expect(row("p1").dedupe_hash).not.toBeNull();
  });

  it("check 1 and 2: a board twin with the same company and title is merged by dedupe, so it never reaches the route", async () => {
    board("7001", "greenhouse", { title: "Senior Frontend Engineer (Remote)" });
    li("p-twin", { company_name: "Fake Co, Inc." });
    process();
    // the twin is a duplicate of the board posting: not pending, nothing to match, nothing counted
    expect(row("p-twin").canonical_posting_id).toBe("b-7001");
    expect(selectForDescription(db).map((p) => p.id)).toEqual([]);
    const r = await step(noRequest);
    expect(r.out).toContain("nothing to fetch");
  });

  it("check 2: a LinkedIn title with a ' - US' / '(Remote, US)' tag is not merged by dedupe; the route now matches it by company", async () => {
    board("7002", "greenhouse");
    li("p-dash", { title: "Senior Frontend Engineer - US" });
    li("p-paren", { title: "Senior Frontend Engineer (Remote, US)", company_name: "Fake Co Inc" });
    process();
    expect(row("p-dash").canonical_posting_id).toBeNull(); // different hash: stays a pending candidate
    expect(
      selectForDescription(db)
        .map((p) => p.id)
        .sort(),
    ).toEqual(["p-dash", "p-paren"]);
    const r = await step(noRequest);
    expect(row("p-dash").description_text).toBe(BOARD_TEXT);
    expect(row("p-paren").description_text).toBe(BOARD_TEXT);
    expect(r.out).toContain("from the ATS board 2");
  });

  it("check 4: a company-domain apply link with ?gh_jid= matches the board posting with that id, although the names differ", async () => {
    board("8275403", "greenhouse", {
      company_name: "Maple Basket",
      url: "https://boards.greenhouse.io/maplebasket/jobs/8275403",
      apply_url: "https://boards.greenhouse.io/maplebasket/jobs/8275403",
    });
    li("p-gh", {
      company_name: "Maple Basket Marketplace",
      title: "Senior Frontend Engineer - US",
      apply_url: "https://maplebasket.example.test/job/?gh_jid=8275403&utm_x=1",
    });
    process();
    const r = await step(noRequest);
    expect(row("p-gh").description_text).toBe(BOARD_TEXT);
    expect(r.out).toContain("from the ATS board 1");
  });

  it("check 4: hosted Lever and Ashby links carrying a query string match by job id", async () => {
    const leverId = "11111111-2222-3333-4444-555555555555";
    const ashbyId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    board(leverId, "lever", { company_name: "Lever Fake", title: "Senior React Engineer" });
    board(ashbyId, "ashby", { company_name: "Ashby Fake", title: "Senior React Engineer" });
    li("p-lever", {
      company_name: "Other Name One",
      title: "Senior React Engineer",
      apply_url: `https://jobs.lever.co/fakeco/${leverId}/apply?lever-origin=applied&x=1`,
    });
    li("p-ashby", {
      company_name: "Other Name Two",
      title: "Senior React Engineer",
      apply_url: `https://jobs.ashbyhq.com/fakeco/${ashbyId.toUpperCase()}?src=li`,
    });
    process();
    const r = await step(noRequest);
    expect(row("p-lever").description_text).toBe(BOARD_TEXT);
    expect(row("p-ashby").description_text).toBe(BOARD_TEXT);
    expect(r.out).toContain("from the ATS board 2");
  });

  it("negatives: another job, another company, another id or a board row without text never match", async () => {
    board("9001", "greenhouse", { title: "Frontend Engineer" }); // same company, shorter title
    board("9002", "greenhouse", { title: "Senior Frontend Engineer - Platform" }); // team suffix is not a location
    board("9003", "greenhouse", { company_name: "Other Corp" });
    board("9004", "greenhouse", { company_name: "Empty Co", description_text: null });
    li("p-neg", { title: "Senior Frontend Engineer", company_name: "Fake Co" });
    li("p-gh-other", {
      company_name: "Nobody Ltd",
      apply_url: "https://nobody.example.test/job/?gh_jid=9003123",
    });
    li("p-gh-title", {
      company_name: "Nobody Two",
      title: "Staff Frontend Engineer",
      apply_url: "https://nobody.example.test/job/?gh_jid=9003",
    });
    process();
    const calls: string[] = [];
    const r = await step(async (id) => {
      calls.push(id);
      return { kind: "failed", reason: "no description" };
    });
    // The two company-page links are Greenhouse job links without a verifiable board (the recorded API answers 404): the
    // ATS-link route handles them (a counted failure each), so only the posting with no ATS link costs a LinkedIn request.
    expect(calls).toEqual([row("p-neg").external_id]);
    for (const id of ["p-neg", "p-gh-other", "p-gh-title"])
      expect(row(id).description_text).toBeNull();
    expect(row("p-gh-other").description_attempts).toBe(1);
    expect(row("p-gh-title").description_attempts).toBe(1);
    expect(r.out).toContain("from the ATS board 0");
    expect(r.out).toContain("from the ATS link 0 (failed 2)");
  });

  it("the summary says why the others missed, as counts", async () => {
    board("9101", "greenhouse", { title: "Frontend Engineer" });
    board("9102", "greenhouse", { company_name: "Empty Text Co", description_text: null });
    li("p-title", { title: "Senior Frontend Engineer", company_name: "Fake Co" });
    li("p-empty", { title: "Senior Frontend Engineer - US", company_name: "Empty Text Co" });
    li("p-none", { company_name: "Not Polled Co" });
    li("p-hit", { title: "Frontend Engineer - US", company_name: "Fake Co" });
    process();
    const r = await step(async () => ({ kind: "failed", reason: "no description" }));
    expect(r.out).toContain(
      "from the ATS board 1 (missed: no board posting 1, title differs 1, board text empty 1)",
    );
  });

  it("the summary of a skipped run (details backoff) carries the counts too", async () => {
    board("9201", "greenhouse");
    li("p-hit", { title: "Senior Frontend Engineer - US" });
    li("p-miss", { company_name: "Not Polled Co" });
    process();
    db.insert(description_runs)
      .values({
        id: "d1",
        source: "linkedin",
        started_at: iso(START - HOUR),
        finished_at: iso(START - HOUR + 60_000),
        requested: 1,
        failed: 0,
        blocked: true,
      })
      .run();
    const r = await step(noRequest);
    expect(r.out).toContain(
      "from the ATS board 1 (missed: no board posting 1, title differs 0, board text empty 0)",
    );
  });
});

describe("jobTitleKey (golden rows)", () => {
  const same: [string, string][] = [
    ["Senior Frontend Engineer (Remote)", "Senior Frontend Engineer"],
    ["Senior Frontend Engineer - US", "Senior Frontend Engineer"],
    ["Senior Frontend Engineer – Remote, US", "Senior Frontend Engineer"],
    ["Senior Frontend Engineer, EMEA", "Senior Frontend Engineer"],
    ["Senior Frontend Engineer | United States", "Senior Frontend Engineer"],
    ["Senior Frontend Engineer (Remote - US) ", "senior frontend engineer"],
    ["Back-end Engineer [Worldwide]", "Back-end Engineer"],
  ];
  it.each(same)("%s == %s", (a, b) => {
    expect(jobTitleKey(a)).toBe(jobTitleKey(b));
  });

  const different: [string, string][] = [
    ["Senior Frontend", "Frontend"],
    ["Senior Frontend Engineer", "Frontend Engineer"],
    ["Engineer - Platform", "Engineer"],
    ["Engineer, EU Compliance", "Engineer"],
    ["Engineer (Payments)", "Engineer"],
    ["Staff Engineer - US", "Senior Engineer"],
  ];
  it.each(different)("%s != %s", (a, b) => {
    expect(jobTitleKey(a)).not.toBe(jobTitleKey(b));
  });

  it("never reduces a title to nothing", () => {
    expect(jobTitleKey("Remote")).toBe("");
    expect(jobTitleKey("(Remote)")).toBe("");
    expect(jobTitleKey("Global - Remote")).not.toBe(jobTitleKey("Remote - Global x"));
  });
});

describe("boardJobRef (golden rows)", () => {
  it.each([
    ["https://instacart.careers/job/?gh_jid=8275403", { source: "greenhouse", id: "8275403" }],
    ["https://boards.greenhouse.io/acme/jobs/123?gh_src=x", { source: "greenhouse", id: "123" }],
    ["https://job-boards.eu.greenhouse.io/acme/jobs/456", { source: "greenhouse", id: "456" }],
    ["https://jobs.lever.co/acme/aaaa-bbbb/apply?x=1", { source: "lever", id: "aaaa-bbbb" }],
    ["https://jobs.ashbyhq.com/acme/aaaa-bbbb", { source: "ashby", id: "aaaa-bbbb" }],
    [
      "https://acme.example.test/careers?ashby_jid=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      { source: "ashby", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    ],
  ])("%s", (url, ref) => {
    expect(boardJobRef(url)).toEqual(ref);
  });

  it.each([
    "https://boards.greenhouse.io/acme",
    "https://jobs.lever.co/acme",
    "https://jobs.ashbyhq.com/acme/embed",
    "https://acme.example.test/careers?gh_jid=abc",
    "not a url",
  ])("no id in %s", (url) => {
    expect(boardJobRef(url)).toBeNull();
  });
});

describe("429 marks (audit #14 MINOR 4 and the L1 note)", () => {
  const is429 = () => new SourceBlockedError("linkedin", "response status code 429");
  const marks = (...ids: string[]) =>
    Object.fromEntries(
      ids.map((id) => [id, [row(id).description_attempts, row(id).description_blocked_at]]),
    );

  it("a block gives an attempt back only to the 429s of that block; a stale mark is cleared without one", async () => {
    li("stale");
    li("fresh-1");
    li("fresh-2");
    process();
    db.update(postings)
      .set({ description_attempts: 1, description_blocked_at: iso(START - 8 * HOUR) })
      .where(eq(postings.id, "stale"))
      .run();
    const asked: string[] = [];
    const r = await step(async (id) => {
      asked.push(id);
      throw is429();
    });
    expect(asked).toHaveLength(2); // the two fresh ones, then the block stops the step
    expect(r.code).toBe(1);
    expect(marks("stale", "fresh-1", "fresh-2")).toEqual({
      stale: [1, null], // mark cleared, attempt kept
      "fresh-1": [0, null], // 429 of the block: attempt given back
      "fresh-2": [0, null],
    });
  });

  it("a given-up job loses its 429 mark in the same update, so one 429 of another job starts no backoff", async () => {
    li("other");
    li("poison"); // newer: asked first among equals
    process();
    for (const id of ["other", "poison"])
      db.update(postings).set({ description_attempts: 2 }).where(eq(postings.id, id)).run();
    // run 1: only the poison job is asked (maxRequests 1 keeps `other` for later) and ends with its 3rd failure, a 429
    await runFetchDescriptions({
      db,
      fetchDescription: async () => {
        throw is429();
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now,
      floorIdrMonth: 10_000_000,
      maxRequests: 1,
      out: () => {},
      err: () => {},
    });
    expect(row("poison").description_unavailable_at).not.toBeNull();
    expect(row("poison").description_blocked_at).toBeNull();

    clock += HOUR;
    const r = await step(async () => {
      throw is429();
    });
    expect(r.code).toBe(0); // one 429 from another job: no backoff
    expect(row("other").description_attempts).toBe(3); // its own 3rd failure, not a block
    expect(
      db
        .select()
        .from(description_runs)
        .all()
        .some((x) => x.blocked),
    ).toBe(false);
  });

  it("a given-up row stored with a mark is cleaned on the next run, even when nothing is pending", async () => {
    li("old");
    process();
    db.update(postings)
      .set({
        description_attempts: 3,
        description_unavailable_at: iso(START - HOUR),
        description_blocked_at: iso(START - HOUR),
      })
      .where(eq(postings.id, "old"))
      .run();
    const r = await step(noRequest);
    expect(r.out).toContain("nothing to fetch");
    expect(row("old").description_blocked_at).toBeNull();
    expect(row("old").description_attempts).toBe(3);
  });
});
