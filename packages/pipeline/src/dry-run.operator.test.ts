import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply_links, dry_runs, intel, openDb, postings, reviews, type Db } from "@job-agent/core";
import {
  EARLY_BATCH_RUNS,
  LATER_BATCH_RUNS,
  LOCK_STALE_MS,
  OPERATOR_DAILY_CEILING,
  PACING_MAX_S,
  PACING_MIN_S,
  pacingGapMs,
  ownerWaiting,
  seedGreenhouseFixture,
  tryAcquire,
  type GreenhouseRunSummary,
} from "@job-agent/apply";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli.ts";
import { OPERATOR_WAIT_EXIT, runDryRun, runOperatorDryRun } from "./dry-run.ts";

// The Greenhouse runner is replaced per test, like in dry-run.value-free.test.ts. Everything else is real.
type RunnerOptions = {
  db: Db;
  postingId: string;
  headless?: boolean;
  dataDir: string;
  starter?: { by: "owner" | "operator"; batch: string | null } | undefined;
};
const hook = vi.hoisted(() => ({
  run: null as null | ((o: RunnerOptions) => Promise<unknown>),
}));
vi.mock("@job-agent/apply", async (importOriginal) => {
  const real = await importOriginal<typeof import("@job-agent/apply")>();
  return {
    ...real,
    runGreenhouseDryRun: (o: Parameters<typeof real.runGreenhouseDryRun>[0]) =>
      hook.run === null ? real.runGreenhouseDryRun(o) : hook.run(o),
  };
});

/** Every fake value carries this marker; it must appear in neither stdout nor stderr. */
const M = "QZ7MARKER";
const T = "2026-10-13T00:00:00.000Z";
const GH = "https://job-boards.greenhouse.io/acme/jobs/1001";

let dir: string;
let dbPath: string;
let db: Db;
let seq = 0;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dry-run-op-"));
  dbPath = join(dir, "real.db");
  db = openDb(dbPath);
  hook.run = null;
  seq = 0;
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const lockDir = () => join(dir, "locks", "dryrun");

function expectValueFree(r: { out: string; err: string }) {
  expect(r.out).not.toContain(M);
  expect(r.err).not.toContain(M);
}

async function op(
  positionals: string[],
  isRealDb = true,
  // Pacing is off here (the fake runs are stamped up to a few ms ahead of now, so the gap is negative) unless a test is about it.
  pacing: { nowMs?: () => number; gapMs?: (id: string) => number } = { gapMs: () => -60_000 },
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runOperatorDryRun({
    positionals,
    db,
    dbPath,
    isRealDb,
    pacing,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  return { code, out: out.join(""), err: err.join("") };
}

/** A posting that passes the candidate rule (kept, not scam, no status action) with a Greenhouse link and questions. */
function addCandidate(id: string, decision: "keep" | "reject" | "suspicious" = "keep") {
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
  db.insert(apply_links)
    .values({
      id: `l-${id}`,
      posting_id: id,
      apply_url: GH,
      apply_type: "ats",
      method: "ats_db",
      found_on: "test",
      checked_at: T,
    })
    .run();
  db.insert(intel)
    .values({
      id: `i-${id}`,
      posting_id: id,
      status: "done",
      final_decision: decision,
      updated_at: T,
    })
    .run();
  seedGreenhouseFixture(db);
  db.$client
    .prepare(
      "insert into posting_questions (id, posting_id, ats_type, question_id, label, required, type, options, normalized_label, matched_key, fetched_at) select id || '-' || ?, ?, ats_type, question_id, label, required, type, options, normalized_label, matched_key, fetched_at from posting_questions where posting_id = 'fixture-greenhouse-1001'",
    )
    .run(id, id);
}

function review(postingId: string, action: typeof reviews.$inferInsert.action, at: string) {
  db.insert(reviews)
    .values({
      id: `rv-${++seq}`,
      posting_id: postingId,
      action,
      reviewed_at: at,
      review_day: "2026-10-13",
      note: `${M} review note`,
    })
    .run();
}

function summary(runId: string, over: Partial<GreenhouseRunSummary> = {}): GreenhouseRunSummary {
  return {
    runId,
    status: "filled",
    stopReason: null,
    screenshotPath: `dryruns/2026-10-13/${runId}/screenshot.png`,
    aborted: [],
    attempts: [],
    captchaPassive: [],
    filled: 13,
    total: 13,
    ...over,
  };
}

/** What the real filler does: records the run (free text that is not for the terminal) and returns its summary. */
function fakeFiller(
  over: Partial<GreenhouseRunSummary> = {},
  onCall?: (o: RunnerOptions) => void,
  /** Test clock: run n starts `n * stepMs` after a base far in the past (0 = now), so old runs fall out of the day window. */
  stepMs = 0,
  /** After recording, like a screenshot or close() that throws. */
  thenThrow = false,
) {
  hook.run = async (o) => {
    onCall?.(o);
    const runId = `run-${++seq}`;
    const at = new Date(
      stepMs === 0 ? Date.now() + seq : Date.parse(T) + (seq - 100) * stepMs,
    ).toISOString();
    db.insert(dry_runs)
      .values({
        id: runId,
        posting_id: o.postingId,
        ats_type: "greenhouse",
        started_at: at,
        finished_at: at,
        status: over.status ?? "filled",
        stop_reason: over.stopReason ?? null,
        stop_detail: `${M} detail`,
        review_note: `${M} review note`,
        fixture: false,
        started_by: o.starter?.by ?? null,
        operator_batch: o.starter?.by === "operator" ? o.starter.batch : null,
      })
      .run();
    if (thenThrow) throw new Error(`${M} screenshot failed`);
    return summary(runId, over);
  };
}

const row = (id: string) => db.select().from(dry_runs).where(eq(dry_runs.id, id)).get();

describe("operator-dry-run: the run", () => {
  it("fills through the shared filler, headed, and prints ids, enums and counts only", async () => {
    addCandidate("p1");
    let headless: boolean | undefined;
    fakeFiller({}, (o) => (headless = o.headless));
    const r = await op(["batch-1", "p1"]);
    expect(r).toEqual({
      code: 0,
      out: "operator-dry-run: run=run-1 posting=p1 ats=greenhouse status=filled reason=- fields=13/13\n",
      err: "",
    });
    expectValueFree(r);
    expect(r.out).not.toMatch(/screenshot|\.png|dryruns/);
    expect(headless).toBe(false);
    expect(row("run-1")).toMatchObject({ started_by: "operator", operator_batch: "batch-1" });
    expect(existsSync(lockDir())).toBe(false);
  });

  it("prints the stop reason and the passive CAPTCHA mark for a stopped run", async () => {
    addCandidate("p1");
    fakeFiller({
      status: "needs_input",
      stopReason: "uncovered_question",
      filled: 9,
      captchaPassive: ["script"],
    });
    const r = await op(["batch-1", "p1"]);
    expect(r.out).toBe(
      "operator-dry-run: run=run-1 posting=p1 ats=greenhouse status=needs_input reason=uncovered_question fields=9/13 captcha=passive\n",
    );
    expect(r.code).toBe(0);
    expectValueFree(r);
  });

  it("an error run exits 1; a thrown error prints its name and location only and frees the lock", async () => {
    addCandidate("p1");
    fakeFiller({ status: "error", stopReason: "page_error", filled: 0, total: 0 });
    const errored = await op(["batch-1", "p1"]);
    expect(errored.code).toBe(1);
    expect(errored.out).toContain("status=error reason=page_error");

    hook.run = async () => {
      throw new Error(`fill("${M}") failed`);
    };
    const thrown = await op(["batch-1", "p1"]);
    expect(thrown.code).toBe(1);
    expect(thrown.out).toBe("");
    expect(thrown.err).toMatch(
      /^operator-dry-run: error Error at packages\/pipeline\/src\/dry-run\.operator\.test\.ts:\d+\n$/,
    );
    expectValueFree(thrown);
    expect(existsSync(lockDir())).toBe(false);
  });

  it("the owner's own dry-run records started_by owner; older rows stay NULL", async () => {
    addCandidate("p1");
    db.insert(dry_runs)
      .values({
        id: "old",
        posting_id: "p1",
        ats_type: "greenhouse",
        started_at: T,
        finished_at: T,
        status: "filled",
      })
      .run();
    fakeFiller();
    const out: string[] = [];
    const code = await runDryRun({
      positionals: ["p1"],
      fixture: undefined,
      headless: true,
      db,
      dbPath,
      isRealDb: true,
      out: (t) => out.push(t),
      err: () => undefined,
    });
    expect(code).toBe(0);
    expect(row("run-1")).toMatchObject({ started_by: "owner", operator_batch: null });
    expect(row("old")).toMatchObject({ started_by: null, operator_batch: null });
  });
});

describe("operator-dry-run: refusals are one fixed line, exit 2, no value", () => {
  async function refused(positionals: string[], line: string, code: string, isRealDb = true) {
    const r = await op(positionals, isRealDb);
    // stdout carries the fixed code (bin/operator drops stderr); stderr keeps the readable line.
    expect(r).toMatchObject({ code: 2, out: `operator-dry-run: refused:${code}\n`, err: line });
    expect(r.err.trimEnd().split("\n")).toHaveLength(1);
    expectValueFree(r);
  }

  it("a scratch database, like dry-run", async () => {
    addCandidate("p1");
    fakeFiller();
    const r = await op(["b", "p1"], false);
    expect(r.code).toBe(2);
    expect(r.out).toBe("operator-dry-run: refused:not_real_db\n");
    expect(r.err).toBe(
      "operator-dry-run: refused: a real form is only opened with the real database\n",
    );
    expect(hook.run).not.toBeNull();
    expect(db.select().from(dry_runs).all()).toEqual([]);
  });

  it("invalid arguments: missing, too many, a batch id that is not a plain token", async () => {
    const usage = (s: string) => s.split("\n")[0];
    for (const args of [[], ["b"], ["b", "p", "x"], [`${M} bad id`, "p"], ["b", ""]]) {
      const r = await op(args);
      expect(r.code).toBe(2);
      expect(usage(r.err)).toBe("operator-dry-run: refused: invalid arguments");
      expect(r.out).toBe("operator-dry-run: refused:invalid_arguments\n");
      expect(r.err).toContain("Usage: job-agent operator-dry-run <batch-id> <posting-id>");
      expectValueFree(r);
    }
  });

  it("the posting is not a candidate: unknown, rejected, suspicious, scam, not_interested, applied; reopen makes it one again", async () => {
    const notCandidate = (id: string) =>
      refused(["b", id], "operator-dry-run: refused: not a candidate\n", "unknown_posting");
    fakeFiller();
    await notCandidate(`nope-${M}`);
    addCandidate("noi");
    db.delete(intel).where(eq(intel.posting_id, "noi")).run();
    await notCandidate("noi");
    addCandidate("rej", "reject");
    await notCandidate("rej");
    addCandidate("sus", "suspicious");
    await notCandidate("sus");
    addCandidate("scam");
    review("scam", "scam", "2026-10-13T01:00:00.000Z");
    await notCandidate("scam");
    addCandidate("ni");
    review("ni", "not_interested", "2026-10-13T01:00:00.000Z");
    await notCandidate("ni");
    addCandidate("ap");
    review("ap", "applied_manually", "2026-10-13T01:00:00.000Z");
    await notCandidate("ap");
    expect(db.select().from(dry_runs).all()).toEqual([]);

    review("ni", "reopen", "2026-10-13T02:00:00.000Z");
    expect((await op(["b", "ni"])).code).toBe(0);
    addCandidate("later");
    review("later", "later", "2026-10-13T02:00:00.000Z");
    expect((await op(["b", "later"])).code).toBe(0);
  });

  it("the lock is held, and an owner run is waiting", async () => {
    addCandidate("p1");
    fakeFiller();
    const held = tryAcquire(dir, "owner");
    await refused(
      ["b", "p1"],
      "operator-dry-run: refused: a dry run is already running\n",
      "lock_held",
    );
    if (held.ok) held.release();

    writeFileSync(join(mkdirSyncLocks(), "dryrun.owner-waiting-x"), "x\n");
    await refused(
      ["b", "p1"],
      "operator-dry-run: refused: an owner run is waiting\n",
      "owner_waiting",
    );
    expect(db.select().from(dry_runs).all()).toEqual([]);
  });

  it("the batch is full: 5 runs in each of the first 3 batches, 10 from the 4th; a re-run counts", async () => {
    addCandidate("p1");
    // Runs are 25 h apart, so the daily ceiling never applies here (it has its own test).
    fakeFiller({}, undefined, 25 * 3_600_000);
    // Batch "a" is the first batch ever: limit 5, the same posting five times (re-runs count).
    for (let i = 0; i < EARLY_BATCH_RUNS; i++) expect((await op(["a", "p1"])).code).toBe(0);
    await refused(["a", "p1"], "operator-dry-run: refused: batch full\n", "batch_limit");
    expect(db.select().from(dry_runs).all()).toHaveLength(EARLY_BATCH_RUNS);
    // Batches b and c are the 2nd and 3rd.
    expect((await op(["b", "p1"])).code).toBe(0);
    expect((await op(["c", "p1"])).code).toBe(0);
    // Batch d is the 4th: limit 10.
    for (let i = 0; i < LATER_BATCH_RUNS; i++) expect((await op(["d", "p1"])).code).toBe(0);
    await refused(["d", "p1"], "operator-dry-run: refused: batch full\n", "batch_limit");
    // A full batch does not block another one.
    expect((await op(["b", "p1"])).code).toBe(0);
  });

  it("a CAPTCHA stop halts the batch and every other batch id for a day", async () => {
    addCandidate("p1");
    addCandidate("p2");
    fakeFiller({ status: "stopped", stopReason: "captcha", filled: 0, total: 0 });
    const hit = await op(["b", "p1"]);
    expect(hit.code).toBe(0);
    expect(hit.out).toContain("status=stopped reason=captcha");
    const next = await op(["b", "p2"]);
    expect(next).toEqual({
      code: 2,
      out: "operator-dry-run: refused:captcha_stop\n",
      err: "operator-dry-run: batch halted: captcha\n",
    });
    expectValueFree(next);
    // A fresh batch id does not get past the halt.
    expect((await op(["other", "p2"])).err).toBe("operator-dry-run: batch halted: captcha\n");
    expect(db.select().from(dry_runs).all()).toHaveLength(1);
  });

  it("a CAPTCHA stop older than a day no longer halts", async () => {
    addCandidate("p1");
    fakeFiller(
      { status: "stopped", stopReason: "captcha", filled: 0, total: 0 },
      undefined,
      3_600_000,
    );
    expect((await op(["b", "p1"])).code).toBe(0);
    expect((await op(["other", "p1"])).code).toBe(0);
  });

  it("a second batch the same day is allowed: the limit is per batch, not 5 or 10 per day", async () => {
    addCandidate("p1");
    fakeFiller();
    for (let i = 0; i < EARLY_BATCH_RUNS; i++) expect((await op(["morning", "p1"])).code).toBe(0);
    await refused(["morning", "p1"], "operator-dry-run: refused: batch full\n", "batch_limit");
    // A new batch (a re-run after a merged fix) starts right away, and a third one too.
    for (let i = 0; i < EARLY_BATCH_RUNS; i++) expect((await op(["rerun", "p1"])).code).toBe(0);
    expect((await op(["rerun-2", "p1"])).code).toBe(0);
    expect(db.select().from(dry_runs).all()).toHaveLength(2 * EARLY_BATCH_RUNS + 1);
  });

  it("the daily ceiling holds whatever the batch id: fresh ids do not give fresh runs", async () => {
    addCandidate("p1");
    fakeFiller();
    for (let i = 0; i < OPERATOR_DAILY_CEILING; i++)
      expect((await op([`id-${i}`, "p1"])).code).toBe(0);
    const next = await op(["yet-another", "p1"]);
    expect(next).toEqual({
      code: 2,
      out: "operator-dry-run: refused:daily_ceiling\n",
      err: "operator-dry-run: refused: daily operator limit reached\n",
    });
    expect(db.select().from(dry_runs).all()).toHaveLength(OPERATOR_DAILY_CEILING);
  });

  it("a run that threw after it was recorded still counts and still halts on a CAPTCHA", async () => {
    addCandidate("p1");
    fakeFiller(
      { status: "stopped", stopReason: "captcha", filled: 0, total: 0 },
      undefined,
      0,
      true,
    );
    const thrown = await op(["b", "p1"]);
    expect(thrown.code).toBe(1);
    expectValueFree(thrown);
    expect(row("run-1")).toMatchObject({ started_by: "operator", operator_batch: "b" });
    expect((await op(["b", "p1"])).err).toBe("operator-dry-run: batch halted: captcha\n");
    expect((await op(["c", "p1"])).err).toBe("operator-dry-run: batch halted: captcha\n");
  });

  it("a thrown run counts toward the batch limit", async () => {
    addCandidate("p1");
    fakeFiller({}, undefined, 0, true);
    for (let i = 0; i < EARLY_BATCH_RUNS; i++) expect((await op(["b", "p1"])).code).toBe(1);
    await refused(["b", "p1"], "operator-dry-run: refused: batch full\n", "batch_limit");
  });

  it("a stopped (not CAPTCHA) run does not halt the batch", async () => {
    addCandidate("p1");
    fakeFiller({ status: "stopped", stopReason: "login_wall", filled: 0, total: 0 });
    expect((await op(["b", "p1"])).code).toBe(0);
    expect((await op(["b", "p1"])).code).toBe(0);
  });

  it("the posting's link or questions are not usable: fixed text, no id", async () => {
    addCandidate("p1");
    db.delete(apply_links).where(eq(apply_links.posting_id, "p1")).run();
    db.insert(apply_links)
      .values({
        id: "l2",
        posting_id: "p1",
        apply_url: "https://apply.workable.com/acme/j/ABC123/",
        apply_type: "ats",
        method: "ats_db",
        found_on: "test",
        checked_at: T,
      })
      .run();
    fakeFiller();
    await refused(
      ["b", "p1"],
      "operator-dry-run: refused: the posting's apply link is not a Greenhouse, Lever or Ashby job link\n",
      "not_fillable",
    );
  });

  function mkdirSyncLocks(): string {
    const p = join(dir, "locks");
    mkdirSync(p, { recursive: true });
    return p;
  }
});

describe("the shared lock between operator and owner runs", () => {
  /** A runner that waits on a gate, to hold a form open. */
  function gatedFiller() {
    const calls: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    fakeFiller();
    const record = hook.run;
    hook.run = async (o) => {
      calls.push(`start:${o.postingId}`);
      await gate;
      const s = await record?.(o);
      calls.push(`end:${o.postingId}`);
      return s;
    };
    return { calls, open };
  }

  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(cond()).toBe(true);
  }

  it("two runs at once: the second is refused and the first is not disturbed", async () => {
    addCandidate("p1");
    addCandidate("p2");
    const g = gatedFiller();
    const first = op(["b", "p1"]);
    await until(() => g.calls.includes("start:p1"));
    const second = await op(["b", "p2"]);
    expect(second).toEqual({
      code: 2,
      out: "operator-dry-run: refused:lock_held\n",
      err: "operator-dry-run: refused: a dry run is already running\n",
    });
    g.open();
    expect((await first).code).toBe(0);
    expect(g.calls).toEqual(["start:p1", "end:p1"]);
    expect(existsSync(lockDir())).toBe(false);
  });

  it("an owner run waits for the operator's one form (one line), then runs; the operator is refused meanwhile", async () => {
    addCandidate("p1");
    addCandidate("p2");
    addCandidate("p3");
    const g = gatedFiller();
    const first = op(["b", "p1"]);
    await until(() => g.calls.includes("start:p1"));

    const ownerOut: string[] = [];
    const owner = runDryRun({
      positionals: ["p2"],
      fixture: undefined,
      headless: true,
      db,
      dbPath,
      isRealDb: true,
      out: (t) => ownerOut.push(t),
      err: () => undefined,
      lock: { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) },
    });
    await until(() => ownerWaiting(dir));
    expect(ownerOut).toEqual(["dry-run: waiting for the operator's current form\n"]);
    // The operator is refused while the owner waits, and the owner never waits for a whole batch.
    const refusedOp = await op(["b", "p3"]);
    expect(refusedOp.out).toBe("operator-dry-run: refused:owner_waiting\n");
    expect(refusedOp.err).toBe("operator-dry-run: refused: an owner run is waiting\n");

    g.open();
    expect((await first).code).toBe(0);
    expect(await owner).toBe(0);
    // The owner's form started only after the operator's ended.
    expect(g.calls).toEqual(["start:p1", "end:p1", "start:p2", "end:p2"]);
    expect(ownerOut).toHaveLength(2);
    expect(ownerOut[1]).toMatch(/^dry-run: status=filled/);
    expect(ownerWaiting(dir)).toBe(false);
    expect(existsSync(lockDir())).toBe(false);
    expect(db.select().from(dry_runs).where(eq(dry_runs.started_by, "owner")).all()).toHaveLength(
      1,
    );
  });

  it("an owner run is refused (not queued) while another owner run holds the lock", async () => {
    addCandidate("p1");
    fakeFiller();
    const held = tryAcquire(dir, "owner");
    const err: string[] = [];
    const code = await runDryRun({
      positionals: ["p1"],
      fixture: undefined,
      headless: true,
      db,
      dbPath,
      isRealDb: true,
      out: () => undefined,
      err: (t) => err.push(t),
    });
    expect(code).toBe(1);
    expect(err.join("")).toBe("dry-run: refused: another dry run is running\n");
    if (held.ok) held.release();
  });

  it("a stale lock (a crashed run) is taken over by the operator", async () => {
    addCandidate("p1");
    fakeFiller();
    expect(tryAcquire(dir, "operator").ok).toBe(true);
    const old = new Date(Date.now() - LOCK_STALE_MS - 60_000);
    utimesSync(lockDir(), old, old);
    const r = await op(["b", "p1"]);
    expect(r.code).toBe(0);
    expect(existsSync(lockDir())).toBe(false);
  });
});

describe("operator-dry-run through main()", () => {
  it("no flag exists (headed always); a scratch database is refused with exit 2", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };
    expect(await main(["operator-dry-run", "--headless", "b", "p1"], io)).toBe(2);
    expect(err.join("")).toContain("operator-dry-run: refused: invalid arguments");
    err.length = 0;
    vi.stubEnv("JOB_AGENT_DB", join(dir, "scratch.db"));
    expect(await main(["operator-dry-run", "b", `p-${M}`], io)).toBe(2);
    expect(err.join("")).toBe(
      "operator-dry-run: refused: a real form is only opened with the real database\n",
    );
    expect(out.join("") + err.join("")).not.toContain(M);
  });

  it("a database that cannot be opened prints the error name only", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };
    writeFileSync(join(dir, M), "");
    vi.stubEnv("JOB_AGENT_DB", join(dir, M, "x.db"));
    expect(await main(["operator-dry-run", "b", "p1"], io)).toBe(1);
    expect(err.join("")).toMatch(/^operator-dry-run: error \w+/);
    expect(out.join("") + err.join("")).not.toContain(M);
  });
});

describe("operator-dry-run: pacing of 60 to 120 s between two real forms", () => {
  const BASE = Date.parse(T);
  const lastRun = (by: "operator" | "owner", at: number, id: string) =>
    db
      .insert(dry_runs)
      .values({
        id,
        posting_id: "p1",
        ats_type: "greenhouse",
        started_at: new Date(at - 5_000).toISOString(),
        finished_at: new Date(at).toISOString(),
        status: "filled",
        fixture: false,
        started_by: by,
        operator_batch: by === "operator" ? "b" : null,
      })
      .run();
  const at = (ms: number) => ({ nowMs: () => BASE + ms });

  it("the gap is in range, stable per run and not the same for every run", () => {
    const gaps = Array.from({ length: 200 }, (_, i) => pacingGapMs(`run-${i}`));
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(PACING_MIN_S * 1000);
      expect(g).toBeLessThanOrEqual(PACING_MAX_S * 1000);
      expect(g % 1000).toBe(0);
    }
    expect(pacingGapMs("run-1")).toBe(pacingGapMs("run-1"));
    expect(new Set(gaps).size).toBeGreaterThan(20);
    expect(Math.min(...gaps)).toBeLessThan(70_000);
    expect(Math.max(...gaps)).toBeGreaterThan(110_000);
  });

  it("the first operator form never waits; the next one waits the rest of the gap and opens nothing", async () => {
    addCandidate("p1");
    let calls = 0;
    fakeFiller({}, () => calls++);
    expect((await op(["b", "p1"], true, at(0))).code).toBe(0);
    expect(calls).toBe(1);
    db.delete(dry_runs).run();
    lastRun("operator", BASE, "prev-op");
    const gap = pacingGapMs("prev-op") / 1000;
    const r = await op(["b", "p1"], true, at(10_000));
    expect(r).toEqual({
      code: OPERATOR_WAIT_EXIT,
      out: `operator-dry-run: waiting:${gap - 10}\n`,
      err: "operator-dry-run: waiting: the pacing gap has not passed\n",
    });
    expect(calls).toBe(1);
    expect(existsSync(lockDir())).toBe(false);
    expectValueFree(r);
  });

  it("once the gap has passed the form is opened; the wait counts down to zero", async () => {
    addCandidate("p1");
    fakeFiller();
    lastRun("operator", BASE, "prev-op");
    const gapMs = pacingGapMs("prev-op");
    const almost = await op(["b", "p1"], true, at(gapMs - 1));
    expect(almost.out).toBe("operator-dry-run: waiting:1\n");
    expect((await op(["b", "p1"], true, at(gapMs))).code).toBe(0);
  });

  it("an owner run neither waits nor makes the operator wait", async () => {
    addCandidate("p1");
    fakeFiller();
    lastRun("owner", BASE, "prev-owner");
    expect((await op(["b", "p1"], true, at(1_000))).code).toBe(0);
    // the owner's own command has no pacing at all, even right after an operator run
    lastRun("operator", Date.now(), "prev-op");
    const out: string[] = [];
    const code = await runDryRun({
      positionals: ["p1"],
      fixture: undefined,
      headless: true,
      db,
      dbPath,
      isRealDb: true,
      out: (t) => out.push(t),
      err: () => undefined,
    });
    expect(code).toBe(0);
    expect(out.join("")).not.toContain("waiting");
  });

  it("a refusal never waits: it comes before the pacing check", async () => {
    addCandidate("p1");
    fakeFiller();
    lastRun("operator", BASE, "prev-op");
    const r = await op(["b", `nope-${M}`], true, at(1_000));
    expect(r.out).toBe("operator-dry-run: refused:unknown_posting\n");
    expect(r.code).toBe(2);
  });

  it("the defaults are the real clock and the random gap: a run that just finished makes the next wait 1 to 120 s", async () => {
    addCandidate("p1");
    fakeFiller();
    lastRun("operator", Date.now(), "prev-op");
    const r = await op(["b", "p1"], true, {});
    expect(r.code).toBe(OPERATOR_WAIT_EXIT);
    const s = Number(/waiting:(\d+)\n$/.exec(r.out)?.[1]);
    expect(s).toBeGreaterThanOrEqual(1);
    expect(s).toBeLessThanOrEqual(PACING_MAX_S);
  });

  it("the daily ceiling is 100 forms", () => {
    expect(OPERATOR_DAILY_CEILING).toBe(100);
  });
});
