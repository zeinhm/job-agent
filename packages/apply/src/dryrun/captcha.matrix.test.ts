import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dry_run_fields, dry_runs, openDb, type Db } from "@job-agent/core";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runAshbyDryRun } from "./ashby/filler.ts";
import {
  ASHBY_FIXTURE_CAPTCHA_PATHS,
  ASHBY_FIXTURE_FORM_PATH,
  ashbyFixtureContext,
  seedAshbyFixture,
  startAshbyFixtureServer,
} from "./ashby/fixture.ts";
import { runGreenhouseDryRun, type PlanContext } from "./greenhouse/filler.ts";
import {
  CAPTCHA_HIT_PREFIX,
  FIELD_CHANGE_PATH,
  FIXTURE_CAPTCHA_PATHS,
  FIXTURE_FORM_PATH,
  fixtureContext,
  seedGreenhouseFixture,
  startGreenhouseFixtureServer,
  type CaptchaVariant,
  type FixtureServer,
} from "./greenhouse/fixture.ts";
import { runLeverDryRun } from "./lever/filler.ts";
import {
  LEVER_FIXTURE_CAPTCHA_PATHS,
  LEVER_FIXTURE_FORM_PATH,
  leverFixtureContext,
  seedLeverFixture,
  startLeverFixtureServer,
} from "./lever/fixture.ts";
import { dataDirOfDb } from "./output.ts";
import { resetRunLimit } from "./testing.ts";

// The five CAPTCHA outcomes of t_cbcbc227, per ATS fixture (decisions.md 2026-10-17 "Dry-run CAPTCHA rule").

interface Summary {
  status: string;
  stopReason: string | null;
  filled: number;
  total: number;
  runId: string;
  screenshotPath: string;
  captchaPassive: readonly string[];
}

interface Ats {
  name: string;
  start: () => Promise<FixtureServer>;
  seed: (db: Db) => string;
  formPath: string;
  paths: Record<CaptchaVariant, string>;
  run: (o: {
    db: Db;
    dataDir: string;
    postingId: string;
    url: string;
    context: PlanContext;
  }) => Promise<Summary>;
  context: (dataDir: string) => PlanContext;
}

const ATSES: Ats[] = [
  {
    name: "greenhouse",
    start: startGreenhouseFixtureServer,
    seed: (db) => seedGreenhouseFixture(db),
    formPath: FIXTURE_FORM_PATH,
    paths: FIXTURE_CAPTCHA_PATHS,
    run: (o) => runGreenhouseDryRun({ ...o, fixture: true }),
    context: fixtureContext,
  },
  {
    name: "lever",
    start: startLeverFixtureServer,
    seed: (db) => seedLeverFixture(db),
    formPath: LEVER_FIXTURE_FORM_PATH,
    paths: LEVER_FIXTURE_CAPTCHA_PATHS,
    run: (o) => runLeverDryRun({ ...o, fixture: true }),
    context: leverFixtureContext,
  },
  {
    name: "ashby",
    start: startAshbyFixtureServer,
    seed: (db) => seedAshbyFixture(db),
    formPath: ASHBY_FIXTURE_FORM_PATH,
    paths: ASHBY_FIXTURE_CAPTCHA_PATHS,
    run: (o) => runAshbyDryRun({ ...o, fixture: true }),
    context: ashbyFixtureContext,
  },
];

const dirs: string[] = [];
afterEach(() => {
  resetRunLimit();
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe.each(ATSES)("CAPTCHA outcomes on the $name fixture", (ats) => {
  let server: FixtureServer;
  beforeAll(async () => {
    server = await ats.start();
  }, 60_000);
  afterAll(async () => {
    await server?.close();
  });

  /** One run on a fresh database; returns what the run reported, stored and sent to the server. */
  async function go(path: string) {
    resetRunLimit();
    server.requests.length = 0;
    const dir = mkdtempSync(join(tmpdir(), "captcha-matrix-"));
    dirs.push(dir);
    const db = openDb(join(dir, "test.db"));
    try {
      const dataDir = dataDirOfDb(join(dir, "test.db"));
      const postingId = ats.seed(db);
      const summary = await ats.run({
        db,
        dataDir,
        postingId,
        url: `${server.origin}${path}`,
        context: ats.context(dataDir),
      });
      // Image beacons of the page may still be in flight.
      await new Promise((r) => setTimeout(r, 300));
      const row = db.select().from(dry_runs).where(eq(dry_runs.id, summary.runId)).get();
      const fields = db
        .select()
        .from(dry_run_fields)
        .where(eq(dry_run_fields.dry_run_id, summary.runId))
        .all();
      return {
        summary,
        row,
        fields,
        screenshot: existsSync(join(dataDir, summary.screenshotPath)),
        hits: server.requests.filter((r) => r.path.startsWith(CAPTCHA_HIT_PREFIX)),
        changes: server.requests.filter((r) => r.path === FIELD_CHANGE_PATH).length,
      };
    } finally {
      db.$client.close();
    }
  }

  it("(1) passive script + badge only: same status and filled count as the form without a CAPTCHA; nothing touched", async () => {
    const plain = await go(ats.formPath);
    expect(plain.summary.status).toBe("filled");
    expect(plain.summary.captchaPassive).toEqual([]);
    const passive = await go(ats.paths.passive);
    expect(passive.summary).toMatchObject({
      status: plain.summary.status,
      stopReason: plain.summary.stopReason,
      filled: plain.summary.filled,
      total: plain.summary.total,
    });
    expect(passive.summary.filled).toBeGreaterThan(0);
    expect(passive.summary.captchaPassive.length).toBeGreaterThan(0);
    expect(passive.row?.stop_detail).toMatch(/^captcha=passive:[a-z,-]+$/);
    expect(passive.fields.length).toBe(plain.fields.length);
    expect(passive.hits).toEqual([]);
  }, 120_000);

  it("(2) a visible checkbox widget at load: captcha, 0 filled, nothing touched", async () => {
    const r = await go(ats.paths["visible-checkbox"]);
    expect(r.summary).toMatchObject({ status: "stopped", stopReason: "captcha", filled: 0 });
    expect(r.row?.stop_detail).toBe("visible captcha challenge on the page");
    expect(r.fields).toEqual([]);
    expect(r.screenshot).toBe(true);
    expect(r.hits).toEqual([]);
    expect(r.changes).toBe(0);
  }, 120_000);

  it("(3) a visible challenge frame at load: captcha, 0 filled, nothing touched", async () => {
    const r = await go(ats.paths["visible-challenge"]);
    expect(r.summary).toMatchObject({ status: "stopped", stopReason: "captcha", filled: 0 });
    expect(r.row?.stop_detail).toBe("visible captcha challenge on the page");
    expect(r.screenshot).toBe(true);
    expect(r.hits).toEqual([]);
    expect(r.changes).toBe(0);
  }, 120_000);

  it("(4) a hidden challenge frame does not stop the run", async () => {
    const plain = await go(ats.formPath);
    const r = await go(ats.paths["hidden-challenge"]);
    expect(r.summary).toMatchObject({
      status: plain.summary.status,
      filled: plain.summary.filled,
      total: plain.summary.total,
    });
    expect(r.summary.captchaPassive).toContain("hidden-frame");
    expect(r.hits).toEqual([]);
  }, 120_000);

  it("(5) a challenge that becomes visible after the first field: captcha, no later field filled, screenshot taken", async () => {
    const r = await go(ats.paths["late-challenge"]);
    expect(r.summary).toMatchObject({
      status: "stopped",
      stopReason: "captcha",
      filled: 0,
      total: 0,
    });
    expect(r.row?.stop_detail).toBe("visible captcha challenge appeared during the run");
    expect(r.fields).toEqual([]);
    expect(r.screenshot).toBe(true);
    // Exactly one field changed: the one that raised the challenge. No later field was filled.
    expect(r.changes).toBe(1);
    expect(r.hits).toEqual([]);
  }, 120_000);
});
