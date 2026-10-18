import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dry_run_fields, dry_runs, openDb, posting_questions, type Db } from "@job-agent/core";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAshbyDryRun } from "./ashby/filler.ts";
import {
  ASHBY_FIXTURE_CAPTCHA_PATH,
  ASHBY_FIXTURE_CHANGED_PATH,
  ASHBY_FIXTURE_DATE_PATH,
  ASHBY_FIXTURE_FORM_PATH,
  ASHBY_FIXTURE_POSTING_ID,
  ashbyFixtureContext,
  seedAshbyFixture,
  startAshbyFixtureServer,
} from "./ashby/fixture.ts";
import { runGreenhouseDryRun, type PlanContext } from "./greenhouse/filler.ts";
import {
  FIXTURE_CAPTCHA_PATH,
  FIXTURE_CHANGED_PATH,
  FIXTURE_FORM_PATH,
  FIXTURE_POSTING_ID,
  fixtureContext,
  seedGreenhouseFixture,
  startGreenhouseFixtureServer,
} from "./greenhouse/fixture.ts";
import { runLeverDryRun } from "./lever/filler.ts";
import {
  LEVER_FIXTURE_CAPTCHA_PATH,
  LEVER_FIXTURE_CHANGED_PATH,
  LEVER_FIXTURE_DATE_PATH,
  LEVER_FIXTURE_FORM_PATH,
  LEVER_FIXTURE_POSTING_ID,
  leverFixtureContext,
  seedLeverFixture,
  startLeverFixtureServer,
} from "./lever/fixture.ts";
import { dataDirOfDb } from "./output.ts";
import { resetRunLimit } from "./testing.ts";

/** Every answer value of the fake persona carries this marker; it must never reach a stop detail or a field note. */
const MARK = "QZ7MARKER";

interface Vendor {
  name: string;
  start: () => Promise<{ origin: string; close: () => Promise<void> }>;
  seed: (db: Db) => void;
  postingId: string;
  context: (dataDir: string) => PlanContext;
  run: (o: {
    db: Db;
    dataDir: string;
    url: string;
    context: PlanContext;
  }) => Promise<{ runId: string; status: string; stopReason: string | null }>;
  form: string;
  captcha: string;
  changed: string;
  /** A page with a field the filler does not support (null: the stored question type is changed instead). */
  unsupported: string | null;
}

const VENDORS: Vendor[] = [
  {
    name: "greenhouse",
    start: startGreenhouseFixtureServer,
    seed: (db) => void seedGreenhouseFixture(db),
    postingId: FIXTURE_POSTING_ID,
    context: fixtureContext,
    run: (o) =>
      runGreenhouseDryRun({
        db: o.db,
        dataDir: o.dataDir,
        postingId: FIXTURE_POSTING_ID,
        url: o.url,
        fixture: true,
        context: o.context,
      }),
    form: FIXTURE_FORM_PATH,
    captcha: FIXTURE_CAPTCHA_PATH,
    changed: FIXTURE_CHANGED_PATH,
    unsupported: null,
  },
  {
    name: "lever",
    start: startLeverFixtureServer,
    seed: (db) => void seedLeverFixture(db),
    postingId: LEVER_FIXTURE_POSTING_ID,
    context: leverFixtureContext,
    run: (o) =>
      runLeverDryRun({
        db: o.db,
        dataDir: o.dataDir,
        postingId: LEVER_FIXTURE_POSTING_ID,
        url: o.url,
        fixture: true,
        context: o.context,
      }),
    form: LEVER_FIXTURE_FORM_PATH,
    captcha: LEVER_FIXTURE_CAPTCHA_PATH,
    changed: LEVER_FIXTURE_CHANGED_PATH,
    unsupported: LEVER_FIXTURE_DATE_PATH,
  },
  {
    name: "ashby",
    start: startAshbyFixtureServer,
    seed: (db) => void seedAshbyFixture(db),
    postingId: ASHBY_FIXTURE_POSTING_ID,
    context: ashbyFixtureContext,
    run: (o) =>
      runAshbyDryRun({
        db: o.db,
        dataDir: o.dataDir,
        postingId: ASHBY_FIXTURE_POSTING_ID,
        url: o.url,
        fixture: true,
        context: o.context,
      }),
    form: ASHBY_FIXTURE_FORM_PATH,
    captcha: ASHBY_FIXTURE_CAPTCHA_PATH,
    changed: ASHBY_FIXTURE_CHANGED_PATH,
    unsupported: ASHBY_FIXTURE_DATE_PATH,
  },
];

/** The persona with every answer replaced by marker text (keeps keys, questions and choices). */
const marked = (c: PlanContext): PlanContext => ({
  ...c,
  answers: c.answers.map((a) => ({ ...a, answer: `${MARK}-${a.key}` })),
});
/** The persona with the marker inside a long value for the textarea question: the page cuts it. */
const longValue = (c: PlanContext): PlanContext => ({
  ...c,
  answers: c.answers.map((a) =>
    a.key === "misc.open_to_crypto_web3" ? { ...a, answer: `${MARK}${"x".repeat(600)}` } : a,
  ),
});
/** A second answer under another key for the wording "Email": an ambiguous match whose value is a marker. */
const ambiguous = (c: PlanContext): PlanContext => ({
  ...c,
  answers: [
    ...c.answers,
    {
      key: "contact.github",
      question: "Email",
      alternatives: null,
      answer: `${MARK}-github`,
      type: null,
      choices: null,
      approved: true,
    },
  ],
});

describe.each(VENDORS)("$name: stop_detail and field notes hold no answer value", (v) => {
  let server: { origin: string; close: () => Promise<void> };
  let dir: string;
  let db: Db;
  let dataDir: string;

  beforeEach(async () => {
    resetRunLimit();
    server = await v.start();
    dir = mkdtempSync(join(tmpdir(), "stop-detail-"));
    db = openDb(join(dir, "test.db"));
    dataDir = dataDirOfDb(join(dir, "test.db"));
    v.seed(db);
  }, 60_000);
  afterEach(async () => {
    // Whatever the scenario, no marker anywhere the run recorded text.
    const runs = db.select().from(dry_runs).all();
    for (const r of runs) {
      expect(r.stop_detail ?? "").not.toContain(MARK);
    }
    for (const f of db.select().from(dry_run_fields).all()) {
      expect(f.note ?? "").not.toContain(MARK);
    }
    await server.close();
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const go = (path: string, context: PlanContext) =>
    v.run({ db, dataDir, url: `${server.origin}${path}`, context });
  const detailOf = (runId: string) =>
    db.select().from(dry_runs).where(eq(dry_runs.id, runId)).get()?.stop_detail ?? null;

  it("filled and needs_input with marker values (every answer, one over-long, no choice mappings)", async () => {
    const all = await go(v.form, marked(v.context(dataDir)));
    expect(["filled", "needs_input"]).toContain(all.status);

    resetRunLimit();
    const refused = await go(v.form, longValue(v.context(dataDir)));
    expect(refused).toMatchObject({ status: "needs_input", stopReason: "uncovered_question" });
    expect(detailOf(refused.runId)).toBe("1 field(s) need input; the page refused 1");

    resetRunLimit();
    const unmapped = await go(v.form, {
      ...marked(v.context(dataDir)),
      choiceMappings: new Map(),
    });
    expect(unmapped.status).toBe("needs_input");

    resetRunLimit();
    const noAsk = await go(v.form, { ...longValue(v.context(dataDir)), ask: null });
    expect(noAsk.status).toBe("needs_input");
  }, 180_000);

  it("stops: scam flagged, an unsupported field, an ambiguous match, a CAPTCHA page", async () => {
    const scam = await go(v.form, { ...marked(v.context(dataDir)), scamFlagged: true });
    expect(scam).toMatchObject({ status: "stopped", stopReason: "other" });
    expect(detailOf(scam.runId)).toBe("scam flagged");

    resetRunLimit();
    const amb = await go(v.form, ambiguous(v.context(dataDir)));
    expect(amb).toMatchObject({ status: "stopped", stopReason: "other" });
    expect(detailOf(amb.runId)).toContain("ambiguous match");

    resetRunLimit();
    const cap = await go(v.captcha, marked(v.context(dataDir)));
    expect(cap).toMatchObject({ status: "stopped", stopReason: "captcha" });
  }, 240_000);

  it("stops: an unsupported field type (on a fresh database)", async () => {
    if (v.unsupported === null) {
      db.update(posting_questions)
        .set({ type: "other" })
        .where(
          and(
            eq(posting_questions.posting_id, v.postingId),
            eq(posting_questions.question_id, "question_1005"),
          ),
        )
        .run();
    }
    const bad = await go(v.unsupported ?? v.form, marked(v.context(dataDir)));
    expect(bad).toMatchObject({ status: "stopped", stopReason: "unexpected_field" });
  }, 120_000);

  it("a changed form (labels of the changes only)", async () => {
    if (v.name !== "greenhouse") {
      await go(v.form, marked(v.context(dataDir))); // stores the page's fields
      resetRunLimit();
    }
    const r = await go(v.changed, marked(v.context(dataDir)));
    expect(r).toMatchObject({ status: "stopped", stopReason: "form_changed" });
    expect(detailOf(r.runId)).toMatch(/^form changed \(/);
  }, 180_000);

  it("a page without the application form (page_error)", async () => {
    const r = await go("/acme/nothing/apply", marked(v.context(dataDir)));
    expect(["error", "stopped"]).toContain(r.status);
  }, 90_000);
});
