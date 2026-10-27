import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dry_run_fields, openDb, posting_questions, type Db } from "@job-agent/core";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runGreenhouseDryRun, type GreenhouseRunSummary, type PlanContext } from "./filler.ts";
import {
  COVER_LETTER_FIXTURE_TEXT,
  FIXTURE_COVER_FILE_ONLY_PATH,
  FIXTURE_COVER_MANUAL_PATH,
  FIXTURE_COVER_TEXTAREA_PATH,
  FIXTURE_POSTING_ID,
  fixtureContext,
  seedGreenhouseFixture,
  startGreenhouseFixtureServer,
  type GreenhouseFixtureServer,
} from "./fixture.ts";
import { dataDirOfDb } from "../output.ts";
import { pageOf, resetRunLimit } from "../testing.ts";

/** t_8ff8aff5: a "Cover letter" text field is filled from misc.cover_letter_text with {company} / {role} replaced. */

const EXPECTED =
  "Dear Fixture Co team, I am applying for the Senior Backend Engineer (fixture) position. Thank you for reading.";

let server: GreenhouseFixtureServer;
let dir: string;
let db: Db;
let dataDir: string;

beforeAll(async () => {
  server = await startGreenhouseFixtureServer();
}, 60_000);
afterAll(async () => {
  await server?.close();
});
beforeEach(() => {
  resetRunLimit();
  server.requests.length = 0;
  dir = mkdtempSync(join(tmpdir(), "gh-cover-"));
  db = openDb(join(dir, "test.db"));
  dataDir = dataDirOfDb(join(dir, "test.db"));
  seedGreenhouseFixture(db);
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The stored Cover Letter question, as `fetch-questions` stores it (the API's first field of the question). */
function storeCoverLetter(type: "long_text" | "file"): void {
  db.insert(posting_questions)
    .values({
      id: randomUUID(),
      posting_id: FIXTURE_POSTING_ID,
      ats_type: "greenhouse",
      question_id: "cover_letter",
      label: "Cover Letter",
      required: false,
      type,
      options: null,
      normalized_label: "cover letter",
      matched_key: null,
      fetched_at: new Date().toISOString(),
    })
    .run();
}

async function run(
  path: string,
  context: (c: PlanContext) => PlanContext = (c) => c,
): Promise<{ summary: GreenhouseRunSummary; dom: Record<string, string> }> {
  let dom: Record<string, string> = {};
  const summary = await runGreenhouseDryRun({
    db,
    dataDir,
    postingId: FIXTURE_POSTING_ID,
    url: `${server.origin}${path}`,
    fixture: true,
    context: context(fixtureContext(dataDir)),
    beforeFinish: async (s) => {
      dom = await pageOf(s).evaluate<Record<string, string>>(`(() => ({
        textarea: document.getElementById("cover_letter")?.value ?? "(none)",
        manual: document.getElementById("cover_letter_text")?.value ?? "(none)",
      }))()`);
    },
  });
  return { summary, dom };
}

const row = (runId: string, label: string) =>
  db
    .select()
    .from(dry_run_fields)
    .where(eq(dry_run_fields.dry_run_id, runId))
    .all()
    .find((r) => r.label === label);

const withCoverText = (text: string) => (c: PlanContext) => ({
  ...c,
  answers: c.answers.map((a) => (a.key === "misc.cover_letter_text" ? { ...a, answer: text } : a)),
});

describe("Greenhouse cover letter text", () => {
  it("a Cover Letter textarea gets the approved text with company and role replaced", async () => {
    storeCoverLetter("long_text");
    const { summary, dom } = await run(FIXTURE_COVER_TEXTAREA_PATH);
    expect(summary).toMatchObject({ status: "filled", filled: 14, total: 14 });
    expect(dom["textarea"]).toBe(EXPECTED);
    // The review panel shows the text after the replacement, with its source and key.
    expect(row(summary.runId, "Cover Letter")).toMatchObject({
      source: "answer",
      answer_key: "misc.cover_letter_text",
      value: EXPECTED,
      filled: true,
    });
    expect(server.nonGet()).toEqual([]);
  }, 90_000);

  it("the stored template itself keeps its placeholders (nothing stored is rewritten)", () => {
    expect(COVER_LETTER_FIXTURE_TEXT).toContain("{company}");
    expect(COVER_LETTER_FIXTURE_TEXT).toContain("{role}");
  });

  it("a file upload with an Enter manually option: the option is opened and the textarea filled", async () => {
    storeCoverLetter("file");
    const { summary, dom } = await run(FIXTURE_COVER_MANUAL_PATH);
    expect(summary).toMatchObject({ status: "filled", filled: 14, total: 14 });
    expect(dom["manual"]).toBe(EXPECTED);
    expect(row(summary.runId, "Cover Letter")).toMatchObject({
      field_type: "long_text",
      source: "answer",
      answer_key: "misc.cover_letter_text",
      value: EXPECTED,
    });
    expect(server.nonGet()).toEqual([]);
    expect(summary.attempts.map((a) => a.kind)).not.toContain("submit_event");
  }, 90_000);

  it("a missing cover letter text leaves the manual textarea empty with the missing-key note", async () => {
    storeCoverLetter("file");
    const { summary, dom } = await run(FIXTURE_COVER_MANUAL_PATH, (c) => ({
      ...c,
      answers: c.answers.filter((a) => a.key !== "misc.cover_letter_text"),
    }));
    expect(dom["manual"]).toBe("");
    expect(summary.status).toBe("needs_input");
    expect(row(summary.runId, "Cover Letter")).toMatchObject({
      filled: false,
      source: "none",
      note: "no answer-bank key for cover_letter",
    });
  }, 90_000);

  it("a cover letter text that is not approved is never typed", async () => {
    storeCoverLetter("file");
    const { summary, dom } = await run(FIXTURE_COVER_MANUAL_PATH, (c) => ({
      ...c,
      answers: c.answers.map((a) =>
        a.key === "misc.cover_letter_text" ? { ...a, approved: false } : a,
      ),
    }));
    expect(dom["manual"]).toBe("");
    expect(summary.status).toBe("needs_input");
    expect(row(summary.runId, "Cover Letter")).toMatchObject({
      filled: false,
      value: null,
      note: "cover letter text not approved",
    });
  }, 90_000);

  it("a file upload without a text option stays needs_input", async () => {
    storeCoverLetter("file");
    const { summary, dom } = await run(FIXTURE_COVER_FILE_ONLY_PATH);
    expect(summary).toMatchObject({ status: "needs_input", filled: 13, total: 14 });
    expect(dom["manual"]).toBe("(none)");
    expect(row(summary.runId, "Cover Letter")).toMatchObject({
      filled: false,
      source: "none",
      value: null,
      note: "cover letter needs a file",
    });
  }, 90_000);

  it("an unknown placeholder leaves the field empty and needs input", async () => {
    storeCoverLetter("long_text");
    const { summary, dom } = await run(
      FIXTURE_COVER_TEXTAREA_PATH,
      withCoverText("Hello {company}, from {name}."),
    );
    expect(summary.status).toBe("needs_input");
    expect(dom["textarea"]).toBe("");
    expect(row(summary.runId, "Cover Letter")).toMatchObject({
      filled: false,
      value: null,
      note: "cover letter text has an unknown placeholder",
    });
  }, 90_000);

  it("a missing company name leaves the field empty and needs input", async () => {
    storeCoverLetter("long_text");
    const { summary, dom } = await run(FIXTURE_COVER_TEXTAREA_PATH, (c) => ({
      ...c,
      posting: { company: "  ", title: "Engineer" },
    }));
    expect(summary.status).toBe("needs_input");
    expect(dom["textarea"]).toBe("");
    expect(row(summary.runId, "Cover Letter")?.note).toBe(
      "cover letter needs the posting's company name",
    );
  }, 90_000);
});
