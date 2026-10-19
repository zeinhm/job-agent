import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dry_run_fields, openDb, type Db } from "@job-agent/core";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../greenhouse/filler.ts";
import { dataDirOfDb } from "../output.ts";
import { pageOf, resetRunLimit } from "../testing.ts";
import { runAshbyDryRun } from "./filler.ts";
import {
  ASHBY_FIXTURE_COVER_PATH,
  ASHBY_FIXTURE_POSTING_ID,
  ashbyFixtureContext,
  seedAshbyFixture,
  startAshbyFixtureServer,
  type AshbyFixtureServer,
} from "./fixture.ts";

/** t_8ff8aff5: a "Cover letter" textarea is filled from misc.cover_letter_text with {company} / {role} replaced. */

const COVER = "4a1f0c52-7e1d-4b8a-9a31-0c2d5e6f7b04";
const EXPECTED =
  "Dear Fixture Co team, I am applying for the Senior Backend Engineer (fixture) position. Thank you for reading.";

let server: AshbyFixtureServer;
let dir: string;
let db: Db;
let dataDir: string;

beforeAll(async () => {
  server = await startAshbyFixtureServer();
}, 60_000);
afterAll(async () => {
  await server?.close();
});
beforeEach(() => {
  resetRunLimit();
  server.requests.length = 0;
  server.graphql.length = 0;
  dir = mkdtempSync(join(tmpdir(), "ashby-cover-"));
  db = openDb(join(dir, "test.db"));
  dataDir = dataDirOfDb(join(dir, "test.db"));
  seedAshbyFixture(db);
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

async function run(context: (c: PlanContext) => PlanContext = (c) => c) {
  let page = "";
  const summary = await runAshbyDryRun({
    db,
    dataDir,
    postingId: ASHBY_FIXTURE_POSTING_ID,
    url: `${server.origin}${ASHBY_FIXTURE_COVER_PATH}`,
    fixture: true,
    context: context(ashbyFixtureContext(dataDir)),
    beforeFinish: async (s) => {
      page = await pageOf(s).evaluate<string>(
        `[...document.querySelectorAll("textarea")].find((e) => e.getAttribute("name") === "${COVER}")?.value ?? "(none)"`,
      );
    },
  });
  return { summary, page };
}

const cover = (runId: string) =>
  db
    .select()
    .from(dry_run_fields)
    .where(eq(dry_run_fields.dry_run_id, runId))
    .all()
    .find((r) => r.label === "Cover letter");

describe("Ashby cover letter textarea", () => {
  it("gets the approved text with company and role replaced", async () => {
    const { summary, page } = await run();
    expect(summary.status).toBe("filled");
    expect(page).toBe(EXPECTED);
    expect(cover(summary.runId)).toMatchObject({
      source: "answer",
      answer_key: "misc.cover_letter_text",
      value: EXPECTED,
      filled: true,
    });
    expect(server.graphql.some((g) => g.kind === "mutation")).toBe(false);
    expect(server.nonGet().every((r) => r.path === "/api/non-user-graphql")).toBe(true);
  }, 90_000);

  it("an unknown placeholder leaves it empty and needs input", async () => {
    const { summary, page } = await run((c) => ({
      ...c,
      answers: c.answers.map((a) =>
        a.key === "misc.cover_letter_text" ? { ...a, answer: "To {company}, {greeting}." } : a,
      ),
    }));
    expect(summary.status).toBe("needs_input");
    expect(page).toBe("");
    expect(cover(summary.runId)).toMatchObject({
      filled: false,
      note: "cover letter text has an unknown placeholder",
    });
  }, 90_000);
});
