import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  apply_links,
  dry_run_fields,
  dry_runs,
  openDb,
  postings,
  reviews,
  type Db,
} from "@job-agent/core";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedGreenhouseFixture } from "@job-agent/apply";
import { main } from "./cli.ts";
import { ashbyFormUrl, formUrl, leverFormUrl, runDryRun, summaryLine } from "./dry-run.ts";
import { atsLinkOf } from "./apply-links/ats-links.ts";

const T = "2026-10-13T00:00:00.000Z";
let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dry-run-cli-"));
  dbPath = join(dir, "scratch.db");
  db = openDb(dbPath);
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Same flags as cli.ts; `isRealDb` is what the command derives from JOB_AGENT_DB. */
async function cli(args: string[], isRealDb = false) {
  const out: string[] = [];
  const err: string[] = [];
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { headless: { type: "boolean", default: false }, fixture: { type: "string" } },
  });
  const code = await runDryRun({
    positionals,
    fixture: values.fixture,
    headless: values.headless === true,
    db,
    dbPath,
    isRealDb,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  return { code, out: out.join(""), err: err.join("") };
}

describe("summary line", () => {
  const base = {
    runId: "r",
    status: "filled" as const,
    stopReason: null,
    screenshotPath: "dryruns/d/r/screenshot.png",
    aborted: [],
    attempts: [],
    filled: 13,
    total: 13,
  };
  it("says captcha=passive (a label, no value) only when a passive CAPTCHA was present", () => {
    expect(summaryLine({ ...base, captchaPassive: [] }, "/d")).toBe(
      "dry-run: status=filled reason=- fields=13/13 screenshot=/d/dryruns/d/r/screenshot.png\n",
    );
    expect(summaryLine({ ...base, captchaPassive: ["script", "badge"] }, "/d")).toBe(
      "dry-run: status=filled reason=- fields=13/13 captcha=passive screenshot=/d/dryruns/d/r/screenshot.png\n",
    );
  });
});

describe("dry-run --fixture greenhouse", () => {
  it("fills the fixture form, prints one summary line without values, records a private fixture run", async () => {
    const r = await cli(["--fixture", "greenhouse"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out.trimEnd().split("\n")).toHaveLength(1);
    expect(r.out).toMatch(
      /^dry-run: status=filled reason=- fields=13\/13 screenshot=\S+\/dryruns\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\/screenshot\.png\n$/,
    );
    expect(r.out).not.toMatch(/Alex|Example|example\.test|555/);

    const run = db.select().from(dry_runs).get();
    expect(run).toMatchObject({ status: "filled", fixture: true, ats_type: "greenhouse" });
    expect(
      db
        .select()
        .from(dry_run_fields)
        .where(eq(dry_run_fields.dry_run_id, run?.id ?? ""))
        .all(),
    ).toHaveLength(13);
    const shot = join(dir, run?.screenshot_path ?? "missing");
    expect(statSync(shot).mode & 0o777).toBe(0o600);
    expect(statSync(join(shot, "..")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "dryruns")).mode & 0o777).toBe(0o700);
  }, 90_000);

  it("is refused on the real database, with a posting id, and for any other fixture name; nothing is written", async () => {
    const real = await cli(["--fixture", "greenhouse"], true);
    expect(real).toMatchObject({ code: 1, out: "" });
    expect(real.err).toContain("never runs on the real database");
    expect((await cli(["--fixture", "greenhouse", "p1"])).code).toBe(1);
    expect((await cli(["--fixture", "workable"])).code).toBe(1);
    expect(db.select().from(postings).all()).toEqual([]);
    expect(db.select().from(dry_runs).all()).toEqual([]);
  });
});

describe("dry-run through main()", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("an unknown flag prints the usage; --fixture on an in-memory DB is refused (no data dir), no browser", async () => {
    const err: string[] = [];
    const io = { out: () => undefined, err: (t: string) => err.push(t) };
    vi.stubEnv("JOB_AGENT_DB", ":memory:");
    expect(await main(["dry-run", "--nope"], io)).toBe(1);
    expect(err.join("")).toContain("Usage: job-agent dry-run");
    err.length = 0;
    expect(await main(["dry-run", "--fixture", "greenhouse"], io)).toBe(1);
    expect(err.join("")).toContain("a dry run needs a DB file");
    err.length = 0;
    expect(await main(["dry-run", "--fixture", "lever"], io)).toBe(1);
    expect(err.join("")).toContain("a dry run needs a DB file");
    err.length = 0;
    expect(await main(["dry-run", "--fixture", "ashby"], io)).toBe(1);
    expect(err.join("")).toContain("a dry run needs a DB file");
  });
});

describe("dry-run <posting-id> refusals (before any browser opens)", () => {
  function addPosting(id: string, applyUrl: string | null) {
    db.insert(postings)
      .values({
        id,
        source: "greenhouse",
        external_id: id,
        url: "https://fake.example/jobs/1",
        title: "Engineer",
        company_name: "Fake Co",
        first_seen_at: T,
        last_seen_at: T,
      })
      .run();
    if (applyUrl !== null) {
      db.insert(apply_links)
        .values({
          id: `l-${id}`,
          posting_id: id,
          apply_url: applyUrl,
          apply_type: "ats",
          method: "ats_db",
          found_on: "test",
          checked_at: T,
        })
        .run();
    }
  }
  const GH = "https://job-boards.greenhouse.io/acme/jobs/1001";

  it("needs a posting id", async () => {
    const r = await cli([], true);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Usage: job-agent dry-run");
  });

  it("a scratch database never opens a real form", async () => {
    addPosting("p1", GH);
    const r = await cli(["p1"], false);
    expect(r.code).toBe(1);
    expect(r.err).toContain("only opened with the real database");
  });

  it("an unknown posting, an unsupported ATS, a board link and a link without a job id", async () => {
    expect((await cli(["nope"], true)).err).toContain("no posting nope");
    addPosting("workable", "https://apply.workable.com/acme/j/ABC123/");
    expect((await cli(["workable"], true)).err).toContain(
      "not a Greenhouse, Lever or Ashby job link",
    );
    addPosting("board", "https://job-boards.greenhouse.io/acme");
    expect((await cli(["board"], true)).err).toContain("not a Greenhouse, Lever or Ashby job link");
    addPosting("leverboard", "https://jobs.lever.co/acme");
    expect((await cli(["leverboard"], true)).err).toContain(
      "not a Greenhouse, Lever or Ashby job link",
    );
    addPosting("ashbyboard", "https://jobs.ashbyhq.com/acme");
    expect((await cli(["ashbyboard"], true)).err).toContain(
      "not a Greenhouse, Lever or Ashby job link",
    );
    addPosting("embed", "https://boards.greenhouse.io/embed/job_app?for=acme&token=abc");
    expect((await cli(["embed"], true)).err).toContain("not a Greenhouse, Lever or Ashby job link");
    addPosting("leverid", "https://jobs.lever.co/acme/a%2Fb");
    expect((await cli(["leverid"], true)).err).toContain("Lever company or posting id is missing");
    addPosting("ashbyid", "https://jobs.ashbyhq.com/acme/not-a-uuid");
    expect((await cli(["ashbyid"], true)).err).toContain(
      "Ashby organization or posting id is missing",
    );
    addPosting(
      "ashbyjid",
      "https://acme.example/careers?ashby_jid=7458d4e9-da2e-47bd-98cb-adfda43d42b2",
    );
    expect((await cli(["ashbyjid"], true)).err).toContain(
      "Ashby organization or posting id is missing",
    );
    addPosting("noid", "https://acme.example/careers?gh_jid=1001");
    expect((await cli(["noid"], true)).err).toContain("board or job id is missing");
  });

  it("a scam-flagged posting", async () => {
    addPosting("p1", GH);
    seedQuestions("p1");
    db.insert(reviews)
      .values({
        id: "r1",
        posting_id: "p1",
        action: "scam",
        reviewed_at: T,
        review_day: "2026-10-13",
      })
      .run();
    const r = await cli(["p1"], true);
    expect(r.code).toBe(1);
    expect(r.err).toContain("scam-flagged");
  });

  it("a scam-flagged Lever posting is refused before any browser opens", async () => {
    addPosting("lv", "https://jobs.lever.co/acme/2f6e9a54-3c1b-4d7e-8a20-5b9c4e1d7f03");
    db.insert(reviews)
      .values({
        id: "r1",
        posting_id: "lv",
        action: "scam",
        reviewed_at: T,
        review_day: "2026-10-13",
      })
      .run();
    const r = await cli(["lv"], true);
    expect(r.code).toBe(1);
    expect(r.err).toContain("scam-flagged");
    expect(db.select().from(dry_runs).all()).toEqual([]);
  });

  it("a scam-flagged Ashby posting is refused before any browser opens", async () => {
    addPosting("ab", "https://jobs.ashbyhq.com/acme/7c3d2b18-5a4e-4f19-b6c0-9e8d1a2f3b04");
    db.insert(reviews)
      .values({
        id: "r1",
        posting_id: "ab",
        action: "scam",
        reviewed_at: T,
        review_day: "2026-10-13",
      })
      .run();
    const r = await cli(["ab"], true);
    expect(r.code).toBe(1);
    expect(r.err).toContain("scam-flagged");
    expect(db.select().from(dry_runs).all()).toEqual([]);
  });

  it("a posting without stored questions", async () => {
    addPosting("p1", GH);
    const r = await cli(["p1"], true);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no stored Greenhouse questions");
    expect(db.select().from(dry_runs).all()).toEqual([]);
  });

  /** Stored questions for `id`, copied from the fixture posting. */
  function seedQuestions(id: string) {
    seedGreenhouseFixture(db);
    db.$client
      .prepare(
        "insert into posting_questions (id, posting_id, ats_type, question_id, label, required, type, options, normalized_label, matched_key, fetched_at) select id || '-' || ?, ?, ats_type, question_id, label, required, type, options, normalized_label, matched_key, fetched_at from posting_questions where posting_id = 'fixture-greenhouse-1001'",
      )
      .run(id, id);
  }
});

describe("leverFormUrl", () => {
  const url = (raw: string) => {
    const link = atsLinkOf(raw);
    return link === null ? "no link" : leverFormUrl(link);
  };
  it("builds the hosted apply URL from the company and the posting id", () => {
    const id = "2f6e9a54-3c1b-4d7e-8a20-5b9c4e1d7f03";
    expect(url(`https://jobs.lever.co/acme/${id}`)).toBe(`https://jobs.lever.co/acme/${id}/apply`);
    expect(url(`https://jobs.lever.co/acme/${id}/apply?lever-source=x`)).toBe(
      `https://jobs.lever.co/acme/${id}/apply`,
    );
    expect(url(`https://jobs.eu.lever.co/acme/${id}`)).toBe(
      `https://jobs.eu.lever.co/acme/${id}/apply`,
    );
    expect(url("https://jobs.lever.co/acme")).toBeNull();
    expect(url("https://jobs.lever.co/acme/-x")).toBeNull();
  });
});

describe("ashbyFormUrl", () => {
  const url = (raw: string) => {
    const link = atsLinkOf(raw);
    return link === null ? "no link" : ashbyFormUrl(link);
  };
  it("builds the hosted application URL from the organization and the posting id", () => {
    const id = "7c3d2b18-5a4e-4f19-b6c0-9e8d1a2f3b04";
    expect(url(`https://jobs.ashbyhq.com/acme/${id}`)).toBe(
      `https://jobs.ashbyhq.com/acme/${id}/application`,
    );
    expect(url(`https://jobs.ashbyhq.com/acme/${id}/application?utm_source=x`)).toBe(
      `https://jobs.ashbyhq.com/acme/${id}/application`,
    );
    expect(url("https://jobs.ashbyhq.com/acme")).toBeNull();
    expect(url("https://jobs.ashbyhq.com/acme/not-a-uuid")).toBeNull();
    expect(url(`https://acme.example/careers?ashby_jid=${id}`)).toBeNull();
  });
});

describe("formUrl", () => {
  const url = (raw: string, slug: string | null = null) => {
    const link = atsLinkOf(raw);
    return link === null ? "no link" : formUrl(link, slug);
  };
  it("builds the hosted job-boards URL from the board and the job id", () => {
    expect(url("https://boards.greenhouse.io/acme/jobs/1001")).toBe(
      "https://job-boards.greenhouse.io/acme/jobs/1001",
    );
    expect(url("https://job-boards.greenhouse.io/acme/jobs/1001?gh_src=x")).toBe(
      "https://job-boards.greenhouse.io/acme/jobs/1001",
    );
    expect(url("https://job-boards.eu.greenhouse.io/acme/jobs/1001")).toBe(
      "https://job-boards.eu.greenhouse.io/acme/jobs/1001",
    );
    expect(url("https://acme.example/careers?gh_jid=1001", "acme")).toBe(
      "https://job-boards.greenhouse.io/acme/jobs/1001",
    );
    expect(url("https://acme.example/careers?gh_jid=1001")).toBeNull();
    expect(url("https://job-boards.greenhouse.io/acme/jobs/abc")).toBeNull();
  });
});
