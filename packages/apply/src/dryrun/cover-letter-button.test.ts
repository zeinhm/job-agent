import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, postings, type Db } from "@job-agent/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { launchChromium } from "./browser.ts";
import { dataDirOfDb } from "./output.ts";
import { HarnessRefusalError, openDryRunSession, type DryRunSession } from "./session.ts";
import { pageOf, resetRunLimit, startFixtureServer, type FixtureServer } from "./testing.ts";

/** t_76852372: the one button the session ever clicks is refused unless it is a plain `type=button` away from submit. */

const T0 = "2026-10-01T10:00:00.000Z";

let server: FixtureServer;
let dir: string;
let db: Db;
let open: DryRunSession[] = [];
let closeBrowser: (() => Promise<void>) | undefined;

beforeAll(async () => {
  server = await startFixtureServer();
  // Fails loudly with the install command when Chromium is missing: no skip.
  const browser = await launchChromium({ headless: true });
  closeBrowser = () => browser.close();
}, 60_000);
afterAll(async () => {
  await closeBrowser?.();
  await server?.close();
});
beforeEach(() => {
  resetRunLimit();
  server.requests.length = 0;
  dir = mkdtempSync(join(tmpdir(), "dryrun-cover-btn-"));
  db = openDb(join(dir, "test.db"));
  db.insert(postings)
    .values({
      id: "p1",
      source: "greenhouse",
      external_id: "p1",
      url: "https://fake.example.com/jobs/p1",
      title: "Senior Backend Engineer",
      company_name: "Fake Co",
      first_seen_at: T0,
      last_seen_at: T0,
    })
    .run();
});
afterEach(async () => {
  await Promise.all(open.map((s) => s.close()));
  open = [];
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(variant: string): Promise<DryRunSession> {
  const session = await openDryRunSession({
    db,
    dataDir: dataDirOfDb(join(dir, "test.db")),
    postingId: "p1",
    ats: "greenhouse",
    url: `${server.origin}/cover-btn-${variant}`,
    fixture: true,
  });
  open.push(session);
  return session;
}

const clicks = (s: DryRunSession) => pageOf(s).evaluate<number>("window.__clicks");

describe("revealCoverLetterText", () => {
  it("clicks a plain type=button once", async () => {
    const s = await start("safe");
    expect(await s.revealCoverLetterText()).toBe(true);
    expect(await clicks(s)).toBe(1);
    expect(server.nonGet()).toEqual([]);
  }, 60_000);

  it("returns false and clicks nothing when the page has no such button", async () => {
    const s = await start("none");
    expect(await s.revealCoverLetterText()).toBe(false);
    expect(await clicks(s)).toBe(0);
  }, 60_000);

  it.each([
    ["a button without a type", "no-type"],
    ["a type=submit button", "type-submit"],
    ["submit in the id", "submit-id"],
    ["submit in the name", "submit-name"],
    ["submit in data-qa", "submit-data-qa"],
    ["a button inside .application--submit", "in-submit-area"],
    ["a button inside a type=submit control", "in-submit-control"],
  ])(
    "refuses %s and does not click",
    async (_name, variant) => {
      const s = await start(variant);
      await expect(s.revealCoverLetterText()).rejects.toThrow(HarnessRefusalError);
      await expect(s.revealCoverLetterText()).rejects.toThrow(/submit control/);
      expect(await clicks(s)).toBe(0);
      expect(server.nonGet()).toEqual([]);
    },
    60_000,
  );

  it("refuses two matching buttons and does not click", async () => {
    const s = await start("duplicate");
    await expect(s.revealCoverLetterText()).rejects.toThrow(/exactly one element, found 2/);
    expect(await clicks(s)).toBe(0);
    expect(server.nonGet()).toEqual([]);
  }, 60_000);
});
