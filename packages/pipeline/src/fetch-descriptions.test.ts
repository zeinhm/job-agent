import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import {
  analysis,
  description_runs,
  fx_rates,
  intel,
  loadConfig,
  openDb,
  postings,
  source_runs,
  SourceBlockedError,
  SourceError,
  SourceSkippedError,
  type Db,
  type NewPosting,
} from "@job-agent/core";
import { SEARCH_GAP_MS, type DetailFetcher, type DetailResult } from "@job-agent/sources";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli.ts";
import { descriptionState } from "./description-state.ts";
import { runDigest } from "./digest/index.ts";
import { selectDay } from "./digest/selection.ts";
import { BLOCK_BACKOFF_HOURS, blockBackoffUntil, contentHash, runDiscover } from "./discover.ts";
import { runEnrich } from "./enrich.ts";
import {
  MAX_DESCRIPTION_ATTEMPTS,
  MAX_DETAIL_REQUESTS_PER_RUN,
  runFetchDescriptions,
  selectForDescription,
} from "./fetch-descriptions.ts";
import { runProcess } from "./process.ts";
import { getQueue } from "./review/queue.ts";

const here = dirname(fileURLToPath(import.meta.url));
const START = Date.parse("2026-10-16T03:00:00Z"); // 10:00 WIB
const DATE = "2026-10-16";
const ENV = { ANTHROPIC_API_KEY: "sk-ant-test-key-0000" };

// Numbers of config/salary.example.yaml (fake persona), through the real loader.
const configDir = mkdtempSync(join(tmpdir(), "job-agent-fetchdesc-"));
copyFileSync(
  join(resolve(here, "../../../config"), "salary.example.yaml"),
  join(configDir, "salary.yaml"),
);
copyFileSync(
  join(resolve(here, "../../../config"), "companies.example.yaml"),
  join(configDir, "companies.yaml"),
);
const SALARY = loadConfig(configDir).salary;
afterAll(() => rmSync(configDir, { recursive: true, force: true }));

let requests: Record<string, unknown>[] = [];
const server = setupServer(
  http.post("https://api.anthropic.com/v1/messages", async ({ request }) => {
    requests.push((await request.json()) as Record<string, unknown>);
    return HttpResponse.json(
      JSON.parse(
        readFileSync(resolve(here, "../test/fixtures/anthropic/extract-ok.json"), "utf-8"),
      ),
    );
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllEnvs();
});

let db: Db;
let clock: number;
let sleeps: number[];
let n: number;

const now = () => new Date(clock);
const sleep = async (ms: number) => {
  sleeps.push(ms);
  clock += ms;
};

beforeEach(() => {
  db = openDb(":memory:");
  clock = START;
  sleeps = [];
  n = 0;
  requests = [];
  db.insert(fx_rates)
    .values({
      id: "fx1",
      date: "2026-10-15",
      base: "USD",
      quote: "IDR",
      rate: "16000",
      source: "test",
      fetched_at: new Date(START).toISOString(),
    })
    .run();
});

/** A LinkedIn posting as the search stores it: no description. Newer ids are newer postings. */
function li(id: string, over: Partial<NewPosting> = {}) {
  n += 1;
  db.insert(postings)
    .values({
      id,
      source: "linkedin",
      external_id: `4000000${String(n).padStart(2, "0")}`,
      url: `https://www.linkedin.com/jobs/view/4000000${String(n).padStart(2, "0")}`,
      title: "Senior Frontend Engineer",
      company_name: "Fake Co",
      location_text: "Worldwide",
      remote: true,
      posted_at: new Date(Date.UTC(2026, 9, 15, 0, n)).toISOString(),
      first_seen_at: new Date(Date.UTC(2026, 9, 15, 0, n)).toISOString(),
      last_seen_at: new Date(Date.UTC(2026, 9, 15, 0, n)).toISOString(),
      ...over,
    })
    .run();
}

function process() {
  const out: string[] = [];
  const code = runProcess({
    db,
    floorIdrMonth: 10_000_000,
    now,
    out: (t) => out.push(t),
    err: (t) => out.push(t),
  });
  expect(code).toBe(0);
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

const row = (id: string) => must(db.select().from(postings).where(eq(postings.id, id)).get());
const analysisOf = (id: string) =>
  must(db.select().from(analysis).where(eq(analysis.posting_id, id)).get());
const flagsOf = (id: string) => JSON.parse(analysisOf(id).flags ?? "[]") as string[];

interface Call {
  id: string;
  at: number;
}

/** A fake worker: records when each request is sent, takes 2 s, answers from `script`. */
function fakeFetcher(
  script: (externalId: string, callNo: number) => DetailResult | Error = (id) => ({
    kind: "ok",
    description: `Fake description for ${id}. Build a React and TypeScript product, fully remote, worldwide.`,
  }),
) {
  const calls: Call[] = [];
  const fetchDescription: DetailFetcher = async (externalId) => {
    calls.push({ id: externalId, at: clock });
    clock += 2_000;
    const r = script(externalId, calls.length);
    if (r instanceof Error) throw r;
    return r;
  };
  return { calls, fetchDescription };
}

async function fetchStep(fetchDescription: DetailFetcher, maxRequests?: number) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runFetchDescriptions({
    db,
    fetchDescription,
    sleep,
    now,
    floorIdrMonth: 10_000_000,
    ...(maxRequests !== undefined ? { maxRequests } : {}),
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  return { code, out: out.join(""), err: err.join("") };
}

async function enrich() {
  const out: string[] = [];
  const code = await runEnrich({
    db,
    salary: SALARY,
    env: ENV,
    cv: null,
    now,
    out: (t) => out.push(t),
    err: (t) => out.push(t),
  });
  return { code, out: out.join("") };
}

describe("which postings are fetched", () => {
  it("fetches only LinkedIn postings without a description that pass the role and source-location rules", () => {
    li("p-ok-old", { title: "Senior React Engineer" });
    li("p-ok-new", { title: "Senior Frontend Engineer" });
    li("p-other-source", { source: "remotive" });
    li("p-has-text", { description_text: "Fake text already here." });
    li("p-role-reject", { title: "Junior Frontend Engineer" });
    li("p-location-restricted", { location_text: "New York, NY (On-site)", remote: false });
    li("p-unavailable", { description_unavailable_at: new Date(START).toISOString() });
    li("p-duplicate", { canonical_posting_id: "p-ok-new" });
    process();
    expect(selectForDescription(db).map((p) => p.id)).toEqual(["p-ok-new", "p-ok-old"]);
  });

  it("does not fetch for a non-LinkedIn posting or one that has its text, and says so", async () => {
    li("p-other-source", { source: "remotive" });
    li("p-has-text", { description_text: "Fake text already here." });
    process();
    const f = fakeFetcher();
    const r = await fetchStep(f.fetchDescription);
    expect(f.calls).toEqual([]);
    expect(r.out).toContain("nothing to fetch");
    expect(db.select().from(description_runs).all()).toEqual([]);
  });

  it("picks up an existing posting stored before this feature (no attempt columns set, no migration step)", () => {
    li("p-old");
    process();
    expect(row("p-old").description_attempts).toBe(0);
    expect(selectForDescription(db).map((p) => p.id)).toEqual(["p-old"]);
  });
});

describe("spacing, cap and order", () => {
  it("waits 10 s after the last search request and between requests, stops at the cap, newest first", async () => {
    for (let i = 0; i < 25; i++) li(`p${String(i).padStart(2, "0")}`);
    process();
    // The search of this run ended 3 s ago.
    db.insert(source_runs)
      .values({
        id: "run1",
        source: "linkedin",
        started_at: new Date(START - 60_000).toISOString(),
        finished_at: new Date(START - 3_000).toISOString(),
        status: "ok",
        found: 25,
        new: 25,
        saturated: 0,
      })
      .run();
    const f = fakeFetcher();
    const r = await fetchStep(f.fetchDescription);
    expect(MAX_DETAIL_REQUESTS_PER_RUN).toBe(20);
    expect(f.calls).toHaveLength(20);
    // first request: 10 s after the search finished
    const starts = f.calls.map((c) => c.at);
    expect(must(starts[0]) - (START - 3_000)).toBeGreaterThanOrEqual(SEARCH_GAP_MS);
    for (let i = 1; i < starts.length; i++) {
      // each request starts at least 10 s after the previous one ENDED (a request takes 2 s here)
      expect(must(starts[i]) - (must(starts[i - 1]) + 2_000)).toBeGreaterThanOrEqual(SEARCH_GAP_MS);
    }
    expect(sleeps.every((ms) => ms > 0)).toBe(true);
    // newest first: p24 is the newest posting; the 5 oldest wait
    const ids = f.calls.map((c) => c.id);
    const byId = (e: string) =>
      must(db.select().from(postings).where(eq(postings.external_id, e)).get());
    expect(ids.map((e) => byId(e).id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `p${String(24 - i).padStart(2, "0")}`),
    );
    expect(r.out).toContain("requested 20, fetched 20");
    expect(r.out).toContain("left for the next run 5");
    expect(selectForDescription(db)).toHaveLength(5);
  });

  it("makes no wait when no LinkedIn request happened before", async () => {
    li("p1");
    process();
    const f = fakeFetcher();
    await fetchStep(f.fetchDescription);
    expect(sleeps).toEqual([]);
    expect(f.calls.map((c) => c.at)).toEqual([START]);
  });

  it("uses the search's own 10 s gap", () => {
    expect(SEARCH_GAP_MS).toBe(10_000);
  });
});

describe("a block", () => {
  it("stops the step, keeps what was fetched, starts the shared 6 h backoff, and a later run sends nothing", async () => {
    for (let i = 0; i < 5; i++) li(`p${i}`);
    process();
    const f = fakeFetcher((_id, no) =>
      no <= 2
        ? { kind: "ok", description: "Fake description, remote worldwide, React." }
        : new SourceBlockedError("linkedin", "response status code 429"),
    );
    const r = await fetchStep(f.fetchDescription);
    expect(r.code).toBe(1);
    expect(f.calls).toHaveLength(3); // the third was blocked, the 4th and 5th are never sent
    const done = db
      .select()
      .from(postings)
      .all()
      .filter((p) => p.description_text !== null);
    expect(done).toHaveLength(2);
    // the blocked posting got no attempt
    expect(
      db
        .select()
        .from(postings)
        .all()
        .every((p) => p.description_attempts === 0),
    ).toBe(true);
    const run = must(db.select().from(source_runs).all().at(-1));
    expect(run.status).toBe("error");
    expect(run.error_message).toMatch(/^blocked: /);
    const until = must(blockBackoffUntil(db, "linkedin", now()));
    expect(until.getTime() - Date.parse(run.started_at)).toBe(BLOCK_BACKOFF_HOURS * 3_600_000);
    expect(db.select().from(description_runs).get()).toMatchObject({
      requested: 3,
      failed: 0,
      blocked: true,
    });

    // The backoff holds for the next run: no request.
    const again = fakeFetcher();
    const r2 = await fetchStep(again.fetchDescription);
    expect(again.calls).toEqual([]);
    expect(r2.out).toContain("skipped (backoff after block until");
    expect(r2.code).toBe(0);
  });

  it("holds with --force on the command too, and the search is in backoff as well", async () => {
    const dir = mkdtempSync(join(tmpdir(), "job-agent-fetchdesc-cli-"));
    try {
      const file = join(dir, "t.db");
      const fileDb = openDb(file);
      fileDb
        .insert(postings)
        .values({
          id: "p1",
          source: "linkedin",
          external_id: "400000001",
          url: "https://www.linkedin.com/jobs/view/400000001",
          title: "Senior Frontend Engineer",
          company_name: "Fake Co",
          location_text: "Worldwide",
          normalized_at: new Date().toISOString(),
          first_seen_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
        })
        .run();
      fileDb
        .insert(source_runs)
        .values({
          id: "blocked",
          source: "linkedin",
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          status: "error",
          found: 0,
          new: 0,
          error_message: "blocked: [linkedin] response status code 429",
        })
        .run();
      fileDb.$client.close();
      vi.stubEnv("JOB_AGENT_DB", file);
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(["fetch-descriptions", "--force"], {
        out: (t) => out.push(t),
        err: (t) => err.push(t),
      });
      expect(code).toBe(0);
      expect(out.join("")).toContain("skipped (backoff after block until");
      // no worker was even asked for (the test runner would have answered "disabled under the test runner")
      expect(out.join("") + err.join("")).not.toContain("disabled under the test runner");
      const check = openDb(file);
      expect(check.select().from(description_runs).all()).toEqual([]);
      check.$client.close();
      // and the search adapter sees the same backoff
      const check2 = openDb(file);
      let polled = 0;
      await runDiscover({
        db: check2,
        adapters: [
          {
            name: "linkedin",
            minIntervalMinutes: 0,
            fetch: async () => {
              polled += 1;
              return [];
            },
          },
        ],
        force: true,
        out: () => {},
      });
      expect(polled).toBe(0);
      check2.$client.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a worker that is not installed sends nothing and counts nothing", async () => {
    li("p1");
    process();
    const f = fakeFetcher(() => new SourceSkippedError("linkedin", "jobspy worker not installed"));
    const r = await fetchStep(f.fetchDescription);
    expect(r.out).toContain("skipped (jobspy worker not installed)");
    expect(row("p1").description_attempts).toBe(0);
    expect(db.select().from(description_runs).all()).toEqual([]);
    expect(r.code).toBe(0);
  });

  it("a failing worker (JobSpy changed) stops the step with exit 1 and counts no attempt", async () => {
    li("p1");
    process();
    const f = fakeFetcher(
      () => new SourceError("linkedin", "jobspy worker failed: no detail call"),
    );
    const r = await fetchStep(f.fetchDescription);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no detail call");
    expect(row("p1").description_attempts).toBe(0);
    expect(blockBackoffUntil(db, "linkedin", now())).toBeUndefined();
  });
});

describe("attempts", () => {
  it("gives up after 3 counted failures; a blocked run does not count", async () => {
    li("p1");
    process();
    const failing = () => ({ kind: "failed", reason: "no description" }) as const;

    await fetchStep(fakeFetcher(failing).fetchDescription);
    expect(row("p1").description_attempts).toBe(1);

    // a blocked run: no attempt counted, then the backoff runs out
    await fetchStep(
      fakeFetcher(() => new SourceBlockedError("linkedin", "response status code 429"))
        .fetchDescription,
    );
    expect(row("p1").description_attempts).toBe(1);
    clock += (BLOCK_BACKOFF_HOURS + 1) * 3_600_000;

    await fetchStep(fakeFetcher(failing).fetchDescription);
    expect(row("p1").description_attempts).toBe(2);
    expect(row("p1").description_unavailable_at).toBeNull();
    expect(descriptionState(row("p1"))).toBe("pending");

    const third = await fetchStep(fakeFetcher(failing).fetchDescription);
    expect(MAX_DESCRIPTION_ATTEMPTS).toBe(3);
    expect(row("p1").description_attempts).toBe(3);
    expect(row("p1").description_unavailable_at).not.toBeNull();
    expect(descriptionState(row("p1"))).toBe("unavailable");
    expect(third.out).toContain("(unavailable 1)");

    // not asked for again
    const again = fakeFetcher();
    await fetchStep(again.fetchDescription);
    expect(again.calls).toEqual([]);
  });
});

describe("a posting without its description", () => {
  /** The posting of the owner's review day: a title-only fit that is high. Fake company, fake place. */
  function titleOnlyTopLooking(id: string) {
    li(id, { title: "Tech Lead Full-Stack", location_text: "Tunis, Tunisia", remote: null });
    process();
    db.update(analysis).set({ digested_at: DATE }).where(eq(analysis.posting_id, id)).run();
    db.insert(intel)
      .values({
        id: `i-${id}`,
        posting_id: id,
        status: "done",
        final_decision: "keep",
        fit_score: 91,
        fit_reasons: JSON.stringify(["Strong match on the title"]),
        scam_score: 0,
        tier: "global_flat",
        ask_usd_year: 90_000,
        updated_at: new Date(START).toISOString(),
      })
      .run();
  }

  it("is never in Top matches (digest and dashboard queue), and is in Needs a look with description_missing", () => {
    titleOnlyTopLooking("p-tunis");
    const day = selectDay(db, DATE, { stamp: false });
    expect(day.top).toEqual([]);
    expect(day.notAFit).toEqual([]);
    expect(day.waiting.map((e) => e.title)).toEqual(["Tech Lead Full-Stack"]);
    expect(day.needsALook.map((e) => e.title)).toEqual(["Tech Lead Full-Stack"]);
    expect(must(day.needsALook[0]).unclear).toContain("description_missing");
    expect(must(day.waiting[0]).view.flags).toContain("description_missing");
    expect(must(day.waiting[0]).line.join("\n")).toContain("waiting for its LinkedIn description");

    const queue = getQueue(db, DATE);
    expect(queue.sections.top).toEqual([]);
    expect(queue.sections.needs_a_look.map((q) => q.flags)).toEqual([
      expect.arrayContaining(["description_missing"]),
    ]);

    const path = runDigest({
      db,
      date: DATE,
      outDir: configDir,
      now,
      capUsd: 1,
      out: () => {},
    });
    const text = readFileSync(path, "utf8");
    expect(text).toContain("- Top matches: 0");
    const needs = text.slice(text.indexOf("## Needs a look"), text.indexOf("## Suspicious"));
    expect(needs).toMatch(/Tech Lead Full-Stack — Fake Co: .*description_missing/);
  });

  it("stays out of Top matches when the analysis row predates the flag (old database)", () => {
    titleOnlyTopLooking("p-old");
    db.update(analysis).set({ flags: "[]" }).where(eq(analysis.posting_id, "p-old")).run();
    expect(selectDay(db, DATE, { stamp: false }).top).toEqual([]);
    expect(selectDay(db, DATE, { stamp: false }).needsALook).toHaveLength(1);
  });

  it("a pending posting is still listed on a later day, one that is unavailable too", () => {
    li("p-pending", { title: "Senior Frontend Engineer" });
    process();
    db.update(analysis).set({ digested_at: "2026-10-10" }).run();
    const day = selectDay(db, DATE, { stamp: false });
    expect(day.waiting.map((e) => e.view.postingId)).toEqual(["p-pending"]);
    expect(day.needsALook).toHaveLength(1);
  });

  it("an unavailable posting is described as title only, flagged, and never Top even when scored", () => {
    titleOnlyTopLooking("p-gone");
    db.update(postings)
      .set({ description_attempts: 3, description_unavailable_at: new Date(START).toISOString() })
      .where(eq(postings.id, "p-gone"))
      .run();
    const day = selectDay(db, DATE, { stamp: false });
    expect(day.top).toEqual([]);
    expect(must(day.waiting[0]).line.join("\n")).toContain("unavailable after 3 attempts");
    expect(day.needsALook).toHaveLength(1);
  });

  it("is not extracted while pending, and is extracted once unavailable (no title-only spend before)", async () => {
    li("p-pending");
    li("p-gone", {
      description_attempts: 3,
      description_unavailable_at: new Date(START).toISOString(),
    });
    process();
    await enrich();
    // only the unavailable posting reached the LLM
    expect(requests).toHaveLength(1);
    expect(db.select().from(intel).where(eq(intel.posting_id, "p-pending")).get()).toBeUndefined();
    expect(db.select().from(intel).where(eq(intel.posting_id, "p-gone")).get()?.status).toBe(
      "done",
    );
    expect(flagsOf("p-pending")).toContain("description_missing");
    expect(flagsOf("p-gone")).toContain("description_missing");
  });
});

describe("after the description arrives", () => {
  const FRENCH = [
    "Nous recherchons un Tech Lead Full-Stack pour rejoindre notre équipe à Tunis.",
    "Poste hybride: sur site à Tunis trois jours par semaine.",
    "Fluent French is required, the whole team works in French.",
  ].join("\n");
  const ENGLISH =
    "We are a fully remote team hiring worldwide. Senior React and TypeScript engineer, any timezone, English only.";

  it("rejects the French hybrid posting by the language and/or location rule and removes it from Needs a look", async () => {
    li("p-tunis", { title: "Tech Lead Full-Stack", location_text: "Tunis, Tunisia", remote: null });
    process();
    expect(analysisOf("p-tunis").decision).toBe("keep");
    expect(flagsOf("p-tunis")).toContain("description_missing");
    expect(selectDay(db, DATE, { stamp: true }).needsALook).toHaveLength(1);

    const f = fakeFetcher(() => ({ kind: "ok", description: FRENCH }));
    const r = await fetchStep(f.fetchDescription);
    expect(r.out).toContain("fetched 1 (rejected by the rules 1)");

    const a = analysisOf("p-tunis");
    expect(a.decision).toBe("reject");
    expect(flagsOf("p-tunis")).not.toContain("description_missing");
    const reasons = JSON.parse(a.reasons ?? "[]") as string[];
    const rejectedBy = (a.location_class === "restricted" ? ["location"] : []).concat(
      reasons.some((x) => x.startsWith("language: description requires")) ? ["language"] : [],
    );
    expect(rejectedBy.length).toBeGreaterThan(0);
    expect(row("p-tunis").description_text).toBe(FRENCH);
    const day = selectDay(db, DATE, { stamp: false });
    expect(day.needsALook).toEqual([]);
    expect(day.waiting).toEqual([]);
    expect(day.top).toEqual([]);
    await enrich();
    expect(requests).toHaveLength(0);
  });

  it("makes the English worldwide-remote posting a normal candidate that enrich extracts, with the title-only extraction redone", async () => {
    li("p-remote", { title: "Senior Frontend Engineer", location_text: "Worldwide" });
    process();
    // an extraction made on the title alone, before this feature
    db.insert(intel)
      .values({
        id: "i-old",
        posting_id: "p-remote",
        status: "done",
        extraction: JSON.stringify({ stale: "title only" }),
        final_decision: "keep",
        fit_score: 88,
        updated_at: new Date(START - 86_400_000).toISOString(),
      })
      .run();
    db.update(analysis)
      .set({ digested_at: "2026-10-15" })
      .where(eq(analysis.posting_id, "p-remote"))
      .run();

    const f = fakeFetcher(() => ({ kind: "ok", description: ENGLISH }));
    const r = await fetchStep(f.fetchDescription);
    expect(r.out).toContain("fetched 1 (rejected by the rules 0)");
    const a = analysisOf("p-remote");
    expect(a.decision).toBe("keep");
    expect(a.digested_at).toBe("2026-10-15"); // not sent twice
    expect(flagsOf("p-remote")).not.toContain("description_missing");
    expect(descriptionState(row("p-remote"))).toBe("present");
    expect(db.select().from(intel).where(eq(intel.posting_id, "p-remote")).get()).toBeUndefined();

    await enrich();
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain("English only");
    const i = must(db.select().from(intel).where(eq(intel.posting_id, "p-remote")).get());
    expect(i.status).toBe("done");
    expect(JSON.parse(i.extraction ?? "{}")).toMatchObject({ roleFamily: "fullstack" });
  });

  it("the next search of the same posting does not wipe the fetched description", async () => {
    li("p-keep", { content_hash: "hash-of-the-search-result" });
    process();
    const f = fakeFetcher(() => ({ kind: "ok", description: ENGLISH }));
    await fetchStep(f.fetchDescription);
    expect(row("p-keep").description_text).toBe(ENGLISH);
    const stored = row("p-keep");

    // The adapter returns the same search result again: no description, same content as when it was stored.
    const raw = {
      source: "linkedin",
      externalId: stored.external_id,
      url: stored.url,
      title: stored.title,
      company: stored.company_name,
      locationText: stored.location_text ?? "",
    };
    db.update(postings)
      .set({ content_hash: contentHash(raw) })
      .where(eq(postings.id, "p-keep"))
      .run();
    await runDiscover({
      db,
      adapters: [{ name: "linkedin", minIntervalMinutes: 0, fetch: async () => [raw] }],
      force: true,
      now,
      out: () => {},
    });
    expect(row("p-keep").description_text).toBe(ENGLISH);
    expect(row("p-keep").description_attempts).toBe(0);
  });

  it("an edited posting (new title) is fetched again from scratch", async () => {
    li("p-edit", { description_attempts: 2, description_text: "Old fetched text." });
    process();
    const stored = row("p-edit");
    db.update(postings).set({ content_hash: "old-hash" }).where(eq(postings.id, "p-edit")).run();
    await runDiscover({
      db,
      adapters: [
        {
          name: "linkedin",
          minIntervalMinutes: 0,
          fetch: async () => [
            {
              source: "linkedin",
              externalId: stored.external_id,
              url: stored.url,
              title: "Staff Frontend Engineer",
              company: stored.company_name,
            },
          ],
        },
      ],
      force: true,
      now,
      out: () => {},
    });
    const after = row("p-edit");
    expect(after.description_text).toBeNull();
    expect(after.description_attempts).toBe(0);
    expect(after.description_unavailable_at).toBeNull();
    expect(selectForDescription(db).map((p) => p.id)).toEqual([]); // normalized_at was cleared: next process, then fetch
    process();
    expect(selectForDescription(db).map((p) => p.id)).toEqual(["p-edit"]);
  });
});

describe("Source health", () => {
  it("shows the detail requests of the run and keeps freshness and the saturation count", async () => {
    for (let i = 0; i < 7; i++) li(`p${i}`);
    process();
    db.insert(source_runs)
      .values({
        id: "ok-run",
        source: "linkedin",
        started_at: new Date(START - 40 * 60_000).toISOString(),
        finished_at: new Date(START - 39 * 60_000).toISOString(),
        status: "ok",
        found: 25,
        new: 7,
        saturated: 2,
      })
      .run();
    const f = fakeFetcher((_id, no) =>
      no === 3
        ? { kind: "failed", reason: "no description" }
        : { kind: "ok", description: "Fake description, remote worldwide, React and TypeScript." },
    );
    const r = await fetchStep(f.fetchDescription);
    expect(r.code).toBe(0);
    expect(db.select().from(description_runs).get()).toMatchObject({
      source: "linkedin",
      requested: 7,
      failed: 1,
      blocked: false,
    });
    // the step added no source_runs row: freshness (gaps between ok runs) sees only the search
    expect(db.select().from(source_runs).all()).toHaveLength(1);

    const path = runDigest({ db, date: DATE, outDir: configDir, now, capUsd: 1, out: () => {} });
    const line = must(
      readFileSync(path, "utf8")
        .split("\n")
        .find((l) => l.startsWith("- **linkedin**")),
    );
    expect(line).toContain("ok, found 25, new 7, saturated 2, details 7 (1 failed)");
    expect(line).toContain("last ok");
    expect(line).not.toContain("LATE");
  });

  it("after a block in the detail step the line shows the block, the detail count and the search's saturation", async () => {
    for (let i = 0; i < 3; i++) li(`p${i}`);
    process();
    db.insert(source_runs)
      .values({
        id: "ok-run",
        source: "linkedin",
        started_at: new Date(START - 40 * 60_000).toISOString(),
        finished_at: new Date(START - 39 * 60_000).toISOString(),
        status: "ok",
        found: 25,
        new: 3,
        saturated: 1,
      })
      .run();
    const f = fakeFetcher((_id, no) =>
      no === 2
        ? new SourceBlockedError("linkedin", "response status code 429")
        : { kind: "ok", description: "Fake description, remote worldwide, React." },
    );
    await fetchStep(f.fetchDescription);
    const path = runDigest({ db, date: DATE, outDir: configDir, now, capUsd: 1, out: () => {} });
    const line = must(
      readFileSync(path, "utf8")
        .split("\n")
        .find((l) => l.startsWith("- **linkedin**")),
    );
    expect(line).toContain("error, found 0, new 0, saturated 1, details 2 (blocked)");
    expect(line).toContain("blocked: [linkedin] response status code 429");
    expect(line).toContain("in backoff until");
  });
});
