import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dry_run_fields, openDb, type Db } from "@job-agent/core";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../greenhouse/filler.ts";
import { CONTRACTOR_NOTE_FIXTURE_TEXT, type FixtureServer } from "../greenhouse/fixture.ts";
import { dataDirOfDb } from "../output.ts";
import { pageOf, resetRunLimit } from "../testing.ts";
import { runLeverDryRun } from "./filler.ts";
import {
  LEVER_FIXTURE_ADDITIONAL_PATH,
  LEVER_FIXTURE_POSTING_ID,
  leverFixtureContext,
  seedLeverFixture,
  startLeverFixtureServer,
} from "./fixture.ts";

/** t_8ff8aff5: an "Additional information" text field is filled from misc.contractor_note. */

let server: FixtureServer;
let dir: string;
let db: Db;
let dataDir: string;

beforeAll(async () => {
  server = await startLeverFixtureServer();
}, 60_000);
afterAll(async () => {
  await server?.close();
});
beforeEach(() => {
  resetRunLimit();
  server.requests.length = 0;
  dir = mkdtempSync(join(tmpdir(), "lever-additional-"));
  db = openDb(join(dir, "test.db"));
  dataDir = dataDirOfDb(join(dir, "test.db"));
  seedLeverFixture(db);
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

async function run(context: (c: PlanContext) => PlanContext = (c) => c) {
  let page = "";
  const summary = await runLeverDryRun({
    db,
    dataDir,
    postingId: LEVER_FIXTURE_POSTING_ID,
    url: `${server.origin}${LEVER_FIXTURE_ADDITIONAL_PATH}`,
    fixture: true,
    context: context(leverFixtureContext(dataDir)),
    beforeFinish: async (s) => {
      page = await pageOf(s).evaluate<string>(
        `document.querySelector("textarea[name=comments]").value`,
      );
    },
  });
  return { summary, page };
}

const rows = (runId: string) =>
  db.select().from(dry_run_fields).where(eq(dry_run_fields.dry_run_id, runId)).all();

describe("Lever additional information", () => {
  it("is filled from the contractor note, with source answer and the key", async () => {
    const { summary, page } = await run();
    expect(summary).toMatchObject({ status: "filled", filled: 14, total: 14 });
    expect(page).toBe(CONTRACTOR_NOTE_FIXTURE_TEXT);
    expect(rows(summary.runId).find((r) => r.label === "Additional information")).toMatchObject({
      source: "answer",
      answer_key: "misc.contractor_note",
      value: CONTRACTOR_NOTE_FIXTURE_TEXT,
      filled: true,
    });
    expect(server.nonGet()).toEqual([]);
  }, 90_000);

  it("stays empty and needs input without an approved contractor note", async () => {
    const { summary, page } = await run((c) => ({
      ...c,
      answers: c.answers.map((a) =>
        a.key === "misc.contractor_note" ? { ...a, approved: false } : a,
      ),
    }));
    expect(summary.status).toBe("needs_input");
    expect(page).toBe("");
    expect(rows(summary.runId).find((r) => r.label === "Additional information")).toMatchObject({
      filled: false,
      source: "none",
      answer_key: "misc.contractor_note",
    });
  }, 90_000);
});
