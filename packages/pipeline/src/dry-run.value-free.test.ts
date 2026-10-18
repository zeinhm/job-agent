import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apply_links,
  DRY_RUN_STOP_REASONS,
  dry_runs,
  openDb,
  postings,
  reviews,
  type Db,
} from "@job-agent/core";
import { seedGreenhouseFixture, type GreenhouseRunSummary } from "@job-agent/apply";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z, ZodError } from "zod";
import { main } from "./cli.ts";
import { runDryRun, summaryLine } from "./dry-run.ts";

// The Greenhouse runner is replaced per test: a summary to return or an error to throw. Everything else is real.
const hook = vi.hoisted(() => ({
  run: null as null | ((o: { db: Db; postingId: string }) => Promise<unknown>),
}));
vi.mock("@job-agent/apply", async (importOriginal) => {
  const real = await importOriginal<typeof import("@job-agent/apply")>();
  return {
    ...real,
    runGreenhouseDryRun: (o: Parameters<typeof real.runGreenhouseDryRun>[0]) =>
      hook.run === null ? real.runGreenhouseDryRun(o) : hook.run(o),
  };
});

/** Every fake value below carries this marker; it must appear in neither stdout nor stderr. */
const M = "QZ7MARKER";
const T = "2026-10-13T00:00:00.000Z";
const GH = "https://job-boards.greenhouse.io/acme/jobs/1001";

let dir: string;
let dbPath: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dry-run-vf-"));
  dbPath = join(dir, "scratch.db");
  db = openDb(dbPath);
  hook.run = null;
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** The assertion every test uses: a marker anywhere in stdout or stderr fails. */
function expectValueFree(r: { out: string; err: string }) {
  expect(r.out).not.toContain(M);
  expect(r.err).not.toContain(M);
}

async function cli(positionals: string[], isRealDb: boolean, fixture?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runDryRun({
    positionals,
    fixture,
    headless: true,
    db,
    dbPath,
    isRealDb,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  return { code, out: out.join(""), err: err.join("") };
}

/** A posting whose every free-text column carries the marker, with an ATS link and (optionally) stored questions. */
function addPosting(id: string, applyUrl: string | null, questions = true) {
  db.insert(postings)
    .values({
      id,
      source: "greenhouse",
      external_id: id,
      url: "https://fake.example/jobs/1",
      title: `${M} title`,
      company_name: `${M} Co`,
      description_text: `${M} description`,
      first_seen_at: T,
      last_seen_at: T,
    })
    .run();
  if (applyUrl !== null)
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
  if (questions) {
    seedGreenhouseFixture(db);
    db.$client
      .prepare(
        "insert into posting_questions (id, posting_id, ats_type, question_id, label, required, type, options, normalized_label, matched_key, fetched_at) select id || '-' || ?, ?, ats_type, question_id, label, required, type, options, normalized_label, matched_key, fetched_at from posting_questions where posting_id = 'fixture-greenhouse-1001'",
      )
      .run(id, id);
  }
}

function summary(over: Partial<GreenhouseRunSummary> = {}): GreenhouseRunSummary {
  return {
    runId: "run-1",
    status: "filled",
    stopReason: null,
    screenshotPath: `dryruns/2026-10-13/run-1/screenshot.png`,
    aborted: [],
    attempts: [],
    captchaPassive: [],
    filled: 13,
    total: 13,
    ...over,
  };
}

/** What the real filler may leave in the database for the run: free text that is not for the terminal. */
function recordRun(postingId: string, over: Partial<typeof dry_runs.$inferInsert> = {}) {
  db.insert(dry_runs)
    .values({
      id: "run-1",
      posting_id: postingId,
      ats_type: "greenhouse",
      started_at: T,
      finished_at: T,
      reviewed_at: T,
      status: "needs_input",
      stop_reason: "uncovered_question",
      stop_detail: `1 field(s) need input ${M}`,
      review: "wrong",
      review_reason: "wrong_value",
      review_note: `${M} review note`,
      fixture: false,
      ...over,
    })
    .run();
}

describe("dry-run prints no value on any path", () => {
  it("success: filled (a real fixture run) and needs_input", async () => {
    const filled = await cli([], false, "greenhouse");
    expect(filled.code).toBe(0);
    expect(filled.out).toMatch(/^dry-run: status=filled reason=- fields=13\/13 screenshot=/);
    expectValueFree(filled);

    addPosting("p1", GH);
    hook.run = async () => {
      recordRun("p1");
      return summary({ status: "needs_input", stopReason: "uncovered_question", filled: 12 });
    };
    const open = await cli(["p1"], true);
    expect(open.err).toBe("");
    expect(open.code).toBe(0);
    expect(open.out).toMatch(
      /^dry-run: status=needs_input reason=uncovered_question fields=12\/13/,
    );
    expectValueFree(open);
  }, 90_000);

  it.each(DRY_RUN_STOP_REASONS)("every stop reason: %s", async (reason) => {
    addPosting("p1", GH);
    hook.run = async () => {
      recordRun("p1", { status: "stopped", stop_reason: reason });
      return summary({
        status: reason === "page_error" ? "error" : "stopped",
        stopReason: reason,
        filled: 0,
        total: 0,
        captchaPassive: reason === "captcha" ? [] : ["script"],
      });
    };
    const r = await cli(["p1"], true);
    expect(r.out).toContain(`reason=${reason}`);
    expect(r.code).toBe(reason === "page_error" ? 1 : 0);
    expectValueFree(r);
  });

  it("operator-facing callers get no screenshot path; the owner's line keeps it", () => {
    expect(summaryLine(summary(), null)).toBe("dry-run: status=filled reason=- fields=13/13\n");
    expect(summaryLine(summary(), "/d")).toContain(" screenshot=/d/dryruns/2026-10-13/run-1/");
  });

  it("refusals: scratch DB, fixture on the real DB, usage, unknown posting, scam-flagged, no questions, no ATS link", async () => {
    addPosting("p1", GH);
    const scratch = await cli(["p1"], false);
    expect(scratch).toMatchObject({ code: 1, out: "" });
    expect(scratch.err).toContain("refused");

    const fixtureReal = await cli([], true, "greenhouse");
    expect(fixtureReal).toMatchObject({ code: 1, out: "" });

    expect((await cli([], true)).code).toBe(1); // usage
    expect((await cli(["a", "b"], true)).code).toBe(1);

    const unknown = await cli(["nope"], true);
    expect(unknown.err).toBe("dry-run: refused: no posting nope\n");

    db.insert(reviews)
      .values({
        id: "r1",
        posting_id: "p1",
        action: "scam",
        reviewed_at: T,
        review_day: "2026-10-13",
        note: `${M} review note`,
      })
      .run();
    const scam = await cli(["p1"], true);
    expect(scam.err).toContain("scam-flagged");

    addPosting("noq", GH, false);
    const noQ = await cli(["noq"], true);
    expect(noQ.err).toContain("no stored Greenhouse questions");

    addPosting("nolink", "https://apply.workable.com/acme/j/ABC123/", false);
    const noLink = await cli(["nolink"], true);
    expect(noLink.err).toContain("not a Greenhouse, Lever or Ashby job link");

    for (const r of [scratch, fixtureReal, unknown, scam, noQ, noLink]) {
      expectValueFree(r);
      expect(r.err.trimEnd().split("\n")).toHaveLength(1);
    }
  });

  it("a thrown Error whose message holds a marker prints its name and location only", async () => {
    addPosting("p1", GH);
    hook.run = async () => {
      throw new Error(`fill("${M}") failed`);
    };
    const r = await cli(["p1"], true);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toMatch(
      /^dry-run: error Error at packages\/pipeline\/src\/dry-run\.value-free\.test\.ts:\d+\n$/,
    );
    expectValueFree(r);
  });

  it("a Playwright-style timeout quoting a typed value prints no part of the message", async () => {
    addPosting("p1", GH);
    hook.run = async () => {
      const e = new Error(
        `locator.fill: Timeout 30000ms exceeded.\nCall log:\n  - fill("${M}")\n  - waiting for getByLabel('${M} label')`,
      );
      e.name = "TimeoutError";
      throw e;
    };
    const r = await cli(["p1"], true);
    expect(r.err).toMatch(/^dry-run: error TimeoutError at /);
    expect(r.err).not.toContain("Timeout 30000ms");
    expect(r.err.trimEnd().split("\n")).toHaveLength(1);
    expectValueFree(r);
  });

  it("an error with a forged name or a multi-line message cannot add output lines", async () => {
    addPosting("p1", GH);
    hook.run = async () => {
      const e = new Error(`${M}\ndry-run: status=filled`);
      e.name = `Evil\ndry-run: status=filled ${M}`;
      throw e;
    };
    const r = await cli(["p1"], true);
    expect(r.err).toMatch(/^dry-run: error Error at /);
    expect(r.err.trimEnd().split("\n")).toHaveLength(1);
    expectValueFree(r);
  });

  it("a multi-line message with a forged stack-frame line prints no part of it", async () => {
    addPosting("p1", GH);
    hook.run = async () => {
      throw new Error(`typed\n    at x (${M}:12:3)\n    at ${M}:1:1`);
    };
    const r = await cli(["p1"], true);
    expect(r.err).toMatch(
      /^dry-run: error Error at packages\/pipeline\/src\/dry-run\.value-free\.test\.ts:\d+\n$/,
    );
    expectValueFree(r);
  });

  it("a non-Error throw (string, object, null) prints a fixed name", async () => {
    addPosting("p1", GH);
    for (const thrown of [`${M} text`, { message: M, toString: () => M }, null]) {
      hook.run = async () => {
        throw thrown;
      };
      const r = await cli(["p1"], true);
      expect(r.err).toBe("dry-run: error NonError\n");
      expectValueFree(r);
    }
  });

  it("a ZodError (a stored row failing its schema) prints no issue text", async () => {
    addPosting("p1", GH);
    hook.run = async () => {
      z.object({ label: z.string().refine(() => false, { message: `${M} bad row` }) }).parse({
        label: "x",
      });
    };
    const r = await cli(["p1"], true);
    expect(r.err).toMatch(/^dry-run: error ZodError at /);
    expectValueFree(r);
  });

  it("an unexpected error before the runner (a stored question row that fails its schema) is caught the same way", async () => {
    addPosting("p1", GH);
    db.$client
      .prepare("update posting_questions set options = ? where posting_id = 'p1'")
      .run(`{"${M}": not json`);
    const r = await cli(["p1"], true);
    expect(r.code).toBe(1);
    expect(r.err.trimEnd().split("\n")).toHaveLength(1);
    expectValueFree(r);
  });

  it("an error thrown by the real error type the harness uses prints no message", async () => {
    addPosting("p1", GH);
    const { HarnessRefusalError } = await import("@job-agent/apply");
    hook.run = async () => {
      throw new HarnessRefusalError(`refused: cannot fill a ${M}[${M}]`);
    };
    const r = await cli(["p1"], true);
    expect(r.err).toMatch(/^dry-run: error HarnessRefusalError at /);
    expectValueFree(r);
  });

  it("through main(): a bad flag quoting a marker and a database that cannot be opened", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };
    expect(await main(["dry-run", `--${M}`], io)).toBe(1);
    expect(err.join("")).toContain("Usage: job-agent dry-run");
    expect(err.join("")).not.toContain(M);

    err.length = 0;
    // The DB's folder would sit below a regular file: opening fails with an error that names the path.
    writeFileSync(join(dir, M), "");
    vi.stubEnv("JOB_AGENT_DB", join(dir, M, "x.db"));
    expect(await main(["dry-run", "p1"], io)).toBe(1);
    expect(err.join("")).toMatch(/^dry-run: error \w+/);
    expect(err.join("") + out.join("")).not.toContain(M);
  });

  it("twin: the same assertion fails when the raw message is printed", async () => {
    addPosting("p1", GH);
    hook.run = async () => {
      throw new Error(`fill("${M}") failed`);
    };
    const r = await cli(["p1"], true);
    expectValueFree(r); // passes with the shared printer
    // What the old code printed: `dry-run: <message>`.
    const rawPrinter = (e: unknown) => `dry-run: ${e instanceof Error ? e.message : String(e)}\n`;
    const raw = { out: "", err: rawPrinter(new Error(`fill("${M}") failed`)) };
    expect(() => expectValueFree(raw)).toThrow();
  });

  it("every printed line is one line: the posting id in a refusal is sanitised", async () => {
    const r = await cli([`x\ny z${"q".repeat(300)}`], true);
    expect(r.err.trimEnd().split("\n")).toHaveLength(1);
    expect(r.err).not.toContain(" ");
    expect(r.err.length).toBeLessThan(260);
  });
});

describe("ZodError sanity", () => {
  it("the error used above carries the marker in its message (so the test above would catch a leak)", () => {
    try {
      z.object({ label: z.string().refine(() => false, { message: `${M} bad row` }) }).parse({
        label: "x",
      });
    } catch (e) {
      expect(e).toBeInstanceOf(ZodError);
      expect((e as ZodError).message).toContain(M);
      return;
    }
    throw new Error("expected a ZodError");
  });
});
