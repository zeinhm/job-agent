import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { http, HttpResponse, type JsonBodyType } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testInjectTimeAndSleep,
  analysis,
  apply_links,
  description_runs,
  fx_rates,
  log,
  openDb,
  postings,
  type Db,
  type NewPosting,
} from "@job-agent/core";
import type { DetailFetcher } from "@job-agent/sources";
import { atsJobOf } from "./ats-description.ts";
import { descriptionState } from "./description-state.ts";
import {
  ATS_RETRY_GAP_MS,
  MAX_DESCRIPTION_ATTEMPTS,
  runFetchDescriptions,
} from "./fetch-descriptions.ts";
import { runProcess } from "./process.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/ats-link");
const fixture = (name: string): JsonBodyType =>
  JSON.parse(readFileSync(join(fixtureDir, name), "utf-8")) as JsonBodyType;

const START = Date.parse("2026-10-16T03:00:00Z");
const HOUR = 3_600_000;
const LEVER_ID = "11111111-2222-3333-4444-555555555555";
const ASHBY_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const GH_API = "https://boards-api.greenhouse.io/v1/boards/fakeco/jobs/4100001";
const LEVER_API = `https://api.lever.co/v0/postings/fakeco/${LEVER_ID}`;
const ASHBY_API = "https://api.ashbyhq.com/posting-api/job-board/fakeco";
const WORKABLE_API = "https://apply.workable.com/api/v1/widget/accounts/fakeco";
const RECRUITEE_API = "https://fakeco.recruitee.com/api/offers/";

const server = setupServer();
const requested: string[] = [];
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

let db: Db;
let clock: number;
const now = () => new Date(clock);
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  db = openDb(":memory:");
  clock = START;
  requested.length = 0;
  // The shared HTTP client's per-host rate limit runs on the test clock, not on real time.
  __testInjectTimeAndSleep(
    () => new Date(clock),
    async (ms) => {
      clock += ms;
    },
  );
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  server.events.on("request:start", ({ request }) => {
    requested.push(`${request.method} ${request.url}`);
  });
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
afterEach(() => {
  server.resetHandlers();
  server.events.removeAllListeners();
  vi.restoreAllMocks();
  db.$client.close();
});

let n = 0;
/** A LinkedIn row as the search stores it: no description. `apply_url` is JobSpy's `job_url_direct` when there is one. */
function li(id: string, over: Partial<NewPosting> = {}) {
  n += 1;
  db.insert(postings)
    .values({
      id,
      source: "linkedin",
      external_id: `6000000${String(n).padStart(2, "0")}`,
      url: `https://www.linkedin.com/jobs/view/6000000${String(n).padStart(2, "0")}`,
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

/** The owner's correction / the resolved link, as `apply_links` stores it. */
function resolved(postingId: string, url: string, over: { ats?: string; slug?: string } = {}) {
  db.insert(apply_links)
    .values({
      id: `l-${postingId}`,
      posting_id: postingId,
      apply_url: url,
      apply_type: "ats",
      method: "owner",
      ats_type: over.ats ?? null,
      ats_slug: over.slug ?? null,
      found_on: "linkedin",
      checked_at: iso(START),
    })
    .run();
}

const row = (id: string) => {
  const r = db.select().from(postings).where(eq(postings.id, id)).get();
  if (r === undefined) throw new Error(`no row ${id}`);
  return r;
};
const flagsOf = (id: string) =>
  JSON.parse(
    db.select().from(analysis).where(eq(analysis.posting_id, id)).get()?.flags ?? "[]",
  ) as string[];

function process() {
  expect(runProcess({ db, floorIdrMonth: 10_000_000, now, out: () => {}, err: () => {} })).toBe(0);
}

/** A LinkedIn worker that must not be called. */
const noRequest: DetailFetcher = async () => {
  throw new Error("a LinkedIn request was sent");
};

async function step(fetchDescription: DetailFetcher = noRequest) {
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

const VENDORS = [
  {
    vendor: "greenhouse",
    link: "https://boards.greenhouse.io/fakeco/jobs/4100001?gh_src=li",
    api: GH_API,
    file: "greenhouse-job.json",
    text: "&lt;p&gt;Greenhouse sample for Fake Co. Build the web app with React and TypeScript. Fully remote worldwide, English only.&lt;/p&gt;",
  },
  {
    vendor: "lever",
    link: `https://jobs.lever.co/fakeco/${LEVER_ID}/apply?lever-origin=applied`,
    api: LEVER_API,
    file: "lever-job.json",
    text: "Lever sample for Fake Co. Build the web app with React and TypeScript. Fully remote worldwide, English only.",
  },
  {
    vendor: "ashby",
    link: `https://jobs.ashbyhq.com/fakeco/${ASHBY_ID.toUpperCase()}?src=li`,
    api: `${ASHBY_API}?includeCompensation=true`,
    file: "ashby-board.json",
    text: "Ashby sample for Fake Co. Build the web app with React and TypeScript. Fully remote worldwide, English only.",
  },
  {
    vendor: "workable",
    link: "https://apply.workable.com/fakeco/j/FAKE123456/",
    api: `${WORKABLE_API}?details=true`,
    file: "workable-board.json",
    text: "<p>Workable sample for Fake Co. Build the web app with React and TypeScript. Fully remote worldwide, English only.</p>",
  },
  {
    vendor: "recruitee",
    link: "https://fakeco.recruitee.com/o/senior-frontend-engineer",
    api: RECRUITEE_API,
    file: "recruitee-offers.json",
    text: "<p>Recruitee sample for Fake Co. Build the web app with React and TypeScript.</p>\n<p>Fully remote worldwide, English only.</p>",
  },
] as const;

describe("description from the ATS job the apply link names", () => {
  it.each(VENDORS)(
    "$vendor: one GET to the public API, the text is stored, the rules re-run, no LinkedIn request",
    async ({ link, api, file, text }) => {
      server.use(http.get(api.split("?")[0] ?? api, () => HttpResponse.json(fixture(file))));
      li("p1", { apply_url: link });
      process();
      expect(flagsOf("p1")).toContain("description_missing");

      const r = await step();

      expect(requested).toEqual([`GET ${api}`]);
      expect(row("p1").description_text).toBe(text);
      expect(descriptionState(row("p1"))).toBe("present");
      expect(flagsOf("p1")).not.toContain("description_missing");
      expect(r.out).toContain("from the ATS link 1 (failed 0)");
      expect(r.out).toContain("no posting from the last 24 h to request"); // nothing is left for LinkedIn
      // the step writes no description_runs row for it: the details backoff reads only LinkedIn requests
      expect(db.select().from(description_runs).all()).toEqual([]);
      for (const url of requested) expect(url).not.toContain("linkedin");
    },
  );

  it("the owner's correction in apply_links wins over the posting's own link, also for a posting older than 24 h", async () => {
    server.use(http.get(LEVER_API, () => HttpResponse.json(fixture("lever-job.json"))));
    li("p-old", {
      apply_url: "https://maplebasket.example.test/careers",
      first_seen_at: iso(START - 5 * 24 * HOUR),
    });
    resolved("p-old", `https://jobs.lever.co/fakeco/${LEVER_ID}`);
    process();
    const r = await step();
    expect(row("p-old").description_text).toContain("Lever sample");
    expect(r.out).toContain("from the ATS link 1 (failed 0)");
    expect(r.out).toContain("older than 24 h and never requested 0");
  });

  it("also during a details backoff: the ATS fetch runs, the LinkedIn requests stay held", async () => {
    server.use(http.get(GH_API, () => HttpResponse.json(fixture("greenhouse-job.json"))));
    db.insert(description_runs)
      .values({
        id: "r1",
        source: "linkedin",
        started_at: iso(START - HOUR),
        finished_at: iso(START - HOUR + 60_000),
        requested: 2,
        failed: 2,
        fetched: 0,
        skipped: 0,
        blocked: true,
      })
      .run();
    li("p-ats", { apply_url: "https://boards.greenhouse.io/fakeco/jobs/4100001" });
    li("p-plain");
    process();
    const r = await step();
    expect(row("p-ats").description_text).not.toBeNull();
    expect(row("p-plain").description_text).toBeNull();
    expect(r.out).toContain("skipped (details backoff after block until");
    expect(r.out).toContain("from the ATS link 1 (failed 0)");
  });

  it("order: the free route first, then the ATS link, then LinkedIn only for a posting with no ATS job link", async () => {
    server.use(http.get(GH_API, () => HttpResponse.json(fixture("greenhouse-job.json"))));
    li("p-link", { apply_url: "https://boards.greenhouse.io/fakeco/jobs/4100001" });
    li("p-board", { title: "Senior React Engineer - US", company_name: "Board Co" });
    li("p-plain", { title: "Staff React Engineer", company_name: "Plain Co" });
    db.insert(postings)
      .values({
        id: "b1",
        source: "greenhouse",
        external_id: "1",
        url: "https://boards.greenhouse.io/boardco/jobs/1",
        title: "Senior React Engineer",
        company_name: "Board Co",
        description_text: "Board text. Fully remote worldwide, React, English only.",
        location_text: "Worldwide",
        remote: true,
        first_seen_at: iso(START - 5 * HOUR),
        last_seen_at: iso(START - HOUR),
      })
      .run();
    process();
    const calls: string[] = [];
    const r = await step(async (id) => {
      calls.push(id);
      return { kind: "ok", description: "Plain text from LinkedIn. Remote worldwide, English." };
    });
    expect(row("p-board").description_text).toContain("Board text");
    expect(row("p-link").description_text).toContain("Greenhouse sample");
    expect(calls).toEqual([row("p-plain").external_id]); // only the posting with no ATS link costs a LinkedIn request
    expect(r.out).toContain("requested 1, fetched 1");
    expect(r.out).toContain("from the ATS board 1");
    expect(r.out).toContain("from the ATS link 1 (failed 0)");
  });

  it("a posting with an ATS job link never costs a LinkedIn request, even when its fetch fails", async () => {
    server.use(http.get(GH_API, () => new HttpResponse(null, { status: 404 })));
    li("p-gone", { apply_url: "https://boards.greenhouse.io/fakeco/jobs/4100001" });
    process();
    const r = await step(); // noRequest throws if LinkedIn were asked
    expect(r.code).toBe(0);
    expect(r.out).toContain("requested 0");
    expect(r.out).toContain("from the ATS link 0 (failed 1)");
  });

  it("the rules re-run: a text the rules reject is counted and the posting leaves Needs a look", async () => {
    server.use(
      http.get(LEVER_API, () =>
        HttpResponse.json({
          ...(fixture("lever-job.json") as Record<string, unknown>),
          descriptionPlain: [
            "Nous recherchons un Tech Lead Full-Stack pour rejoindre notre équipe à Tunis.",
            "Poste hybride: sur site à Tunis trois jours par semaine.",
            "Fluent French is required, the whole team works in French.",
          ].join("\n"),
        }),
      ),
    );
    li("p-fr", {
      title: "Tech Lead Full-Stack",
      location_text: "Tunis, Tunisia",
      remote: null,
      apply_url: `https://jobs.lever.co/fakeco/${LEVER_ID}`,
    });
    process();
    const r = await step();
    expect(r.out).toContain("(rejected by the rules 1)");
    expect(flagsOf("p-fr")).not.toContain("description_missing");
  });
});

describe("failures", () => {
  const link = "https://boards.greenhouse.io/fakeco/jobs/4100001";

  it("404 (closed): one counted attempt, not asked again for the retry gap, unavailable after the third", async () => {
    server.use(http.get(GH_API, () => new HttpResponse(null, { status: 404 })));
    li("p1", { apply_url: link });
    process();

    await step();
    expect(row("p1").description_attempts).toBe(1);
    expect(row("p1").description_unavailable_at).toBeNull();
    expect(requested).toHaveLength(1);

    // the next hourly runs do not ask again
    clock += HOUR;
    let r = await step();
    expect(requested).toHaveLength(1);
    expect(r.out).toContain("from the ATS link 0 (failed 0)");

    clock += ATS_RETRY_GAP_MS;
    await step();
    expect(row("p1").description_attempts).toBe(2);
    clock += ATS_RETRY_GAP_MS;
    r = await step();
    expect(row("p1").description_attempts).toBe(MAX_DESCRIPTION_ATTEMPTS);
    expect(descriptionState(row("p1"))).toBe("unavailable"); // the way a gone description is marked today
    expect(row("p1").description_text).toBeNull();
    expect(flagsOf("p1")).toContain("description_missing");
    expect(requested).toHaveLength(3);

    // given up: never asked again
    clock += 24 * HOUR;
    r = await step();
    expect(requested).toHaveLength(3);
    expect(r.out).toContain("nothing to fetch");
  });

  it("a job whose id differs from the link's is never stored", async () => {
    server.use(
      http.get(GH_API, () =>
        HttpResponse.json({ ...(fixture("greenhouse-job.json") as object), id: 4100002 }),
      ),
      http.get(LEVER_API, () =>
        HttpResponse.json({
          ...(fixture("lever-job.json") as object),
          id: "99999999-2222-3333-4444-555555555555",
        }),
      ),
    );
    li("p-gh", { apply_url: link });
    li("p-lever", { apply_url: `https://jobs.lever.co/fakeco/${LEVER_ID}` });
    process();
    const r = await step();
    expect(row("p-gh").description_text).toBeNull();
    expect(row("p-lever").description_text).toBeNull();
    expect(row("p-gh").description_attempts).toBe(1);
    expect(r.out).toContain("from the ATS link 0 (failed 2)");
  });

  it("a job missing from a board list (Ashby, Workable, Recruitee) counts as closed", async () => {
    server.use(
      http.get(`${ASHBY_API}`, () => HttpResponse.json({ jobs: [] })),
      http.get(WORKABLE_API, () => HttpResponse.json({ jobs: [] })),
      http.get(RECRUITEE_API, () => HttpResponse.json({ offers: [] })),
    );
    li("p-a", { apply_url: `https://jobs.ashbyhq.com/fakeco/${ASHBY_ID}` });
    li("p-w", { apply_url: "https://apply.workable.com/fakeco/j/FAKE123456/" });
    li("p-r", { apply_url: "https://fakeco.recruitee.com/o/senior-frontend-engineer" });
    process();
    const r = await step();
    for (const id of ["p-a", "p-w", "p-r"]) {
      expect(row(id).description_text).toBeNull();
      expect(row(id).description_attempts).toBe(1);
    }
    expect(r.out).toContain("from the ATS link 0 (failed 3)");
  });

  it("an answer that is not JSON is a counted failure and stores nothing", async () => {
    server.use(http.get(GH_API, () => HttpResponse.text("<html>maintenance</html>")));
    li("p1", { apply_url: link });
    process();
    const r = await step();
    expect(row("p1").description_text).toBeNull();
    expect(row("p1").description_attempts).toBe(1);
    expect(r.out).toContain("from the ATS link 0 (failed 1)");
  });

  it("a job with no text is a counted failure", async () => {
    server.use(
      http.get(GH_API, () =>
        HttpResponse.json({ ...(fixture("greenhouse-job.json") as object), content: "" }),
      ),
    );
    li("p1", { apply_url: link });
    process();
    await step();
    expect(row("p1").description_text).toBeNull();
    expect(row("p1").description_attempts).toBe(1);
  });

  it("a redirect to another host is not followed: counted failure, only the ATS host was asked", async () => {
    server.use(
      http.get(
        GH_API,
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { location: "https://elsewhere.example.test/x" },
          }),
      ),
    );
    li("p1", { apply_url: link });
    process();
    await step();
    expect(requested).toEqual([`GET ${GH_API}`]);
    expect(row("p1").description_attempts).toBe(1);
  });

  it("a host that refuses (429) gets no more requests this run and no attempt is counted", async () => {
    server.use(
      http.get("https://api.ashbyhq.com/*", () => new HttpResponse(null, { status: 429 })),
    );
    li("p-a1", { apply_url: `https://jobs.ashbyhq.com/fakeco/${ASHBY_ID}` });
    li("p-a2", { apply_url: `https://jobs.ashbyhq.com/otherco/${ASHBY_ID}` });
    process();
    const r = await step();
    expect(row("p-a1").description_attempts).toBe(0);
    expect(row("p-a2").description_attempts).toBe(0);
    expect(row("p-a1").description_text).toBeNull();
    expect(r.out).toContain("from the ATS link 0 (failed 0)");
    // never to LinkedIn either
    expect(r.out).toContain("requested 0");
  });
});

describe("Greenhouse company page (?gh_jid=) through the shared board resolver", () => {
  it("verifies the board slug, then fetches the job", async () => {
    server.use(
      // the company-name guess ("fake") has no such job; the page's host label ("fakeco") has
      http.get(
        "https://boards-api.greenhouse.io/v1/boards/fake/jobs/4100001",
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get(GH_API, () => HttpResponse.json(fixture("greenhouse-job.json"))),
    );
    li("p1", { apply_url: "https://fakeco.example.test/job/?gh_jid=4100001&utm_x=1" });
    process();
    const r = await step();
    expect(row("p1").description_text).toContain("Greenhouse sample");
    // the failed guess, the verifying lookup, then the job itself
    expect(requested).toEqual([
      "GET https://boards-api.greenhouse.io/v1/boards/fake/jobs/4100001",
      `GET ${GH_API}`,
      `GET ${GH_API}`,
    ]);
    expect(r.out).toContain("from the ATS link 1 (failed 0)");
  });

  it("no verified board: one counted failure and no LinkedIn request", async () => {
    server.use(
      http.get(
        /^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/[^/]+\/jobs\/4100001$/,
        () => new HttpResponse(null, { status: 404 }),
      ),
    );
    li("p1", { apply_url: "https://fakeco.example.test/job/?gh_jid=4100001" });
    process();
    const r = await step();
    expect(row("p1").description_attempts).toBe(1);
    expect(r.out).toContain("from the ATS link 0 (failed 1)");
  });
});

describe("what counts as an ATS job link (atsJobOf)", () => {
  it("takes the board name from the stored link or company when the link carries none", () => {
    const stored = [{ ats: "workable", slug: "fakeco" }];
    expect(atsJobOf("https://apply.workable.com/j/FAKE123456", "Fake Co", stored)).toEqual({
      vendor: "workable",
      jobId: "FAKE123456",
      slug: "fakeco",
    });
    expect(atsJobOf("https://apply.workable.com/j/FAKE123456", "Fake Co", [])).toBeNull();
    expect(
      atsJobOf(`https://x.example.test/p?ashby_jid=${ASHBY_ID}`, "Fake Co", [
        { ats: "ashby", slug: "fakeco" },
      ]),
    ).toEqual({ vendor: "ashby", jobId: ASHBY_ID, slug: "fakeco" });
  });

  it("is null for a board link, another ATS, a LinkedIn link and an unsafe slug", () => {
    for (const url of [
      "https://boards.greenhouse.io/fakeco",
      "https://jobs.lever.co/fakeco",
      "https://jobs.smartrecruiters.com/fakeco/123",
      "https://www.linkedin.com/jobs/view/123",
      "https://fakeco.recruitee.com/",
      "https://jobs.lever.co/fa%2Fke/abc-123",
    ]) {
      expect(atsJobOf(url, "Fake Co", [])).toBeNull();
    }
  });

  it("uses the EU Lever API for an EU Lever link", () => {
    expect(atsJobOf(`https://jobs.eu.lever.co/fakeco/${LEVER_ID}`, null, [])).toEqual({
      vendor: "lever",
      jobId: LEVER_ID,
      slug: "fakeco",
      eu: true,
    });
  });

  it("a stored board of another ATS is not used for the link's vendor", () => {
    expect(
      atsJobOf("https://apply.workable.com/j/FAKE123456", "Fake Co", [
        { ats: "lever", slug: "fakeco" },
      ]),
    ).toBeNull();
  });
});
