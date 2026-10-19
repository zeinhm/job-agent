import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, postings, type Db } from "@job-agent/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeNavFailure } from "./detectors.ts";
import { dataDirOfDb } from "./output.ts";
import { openDryRunSession, type DryRunSession } from "./session.ts";
import { resetRunLimit, startFixtureServer } from "./testing.ts";

/** t_40e617cc: a page that gives no response says why (network error, timeout, our own guard) and nothing else. */

const T0 = "2026-10-01T10:00:00.000Z";

let dir: string;
let db: Db;
let session: DryRunSession | undefined;

beforeEach(() => {
  resetRunLimit();
  dir = mkdtempSync(join(tmpdir(), "dryrun-nav-"));
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
  await session?.close();
  session = undefined;
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

async function open(url: string): Promise<DryRunSession> {
  session = await openDryRunSession({
    db,
    dataDir: dataDirOfDb(join(dir, "test.db")),
    postingId: "p1",
    ats: "greenhouse",
    url,
    fixture: true,
  });
  return session;
}

describe("describeNavFailure", () => {
  it("keeps the Chromium error code and drops the URL", () => {
    const err = new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at https://secret.example/x?t=1");
    expect(describeNavFailure(err)).toBe("navigation failed (net::ERR_NAME_NOT_RESOLVED)");
  });
  it("names a timeout without the URL", () => {
    const err = new Error(
      'page.goto: Timeout 10000ms exceeded.\nNavigating to "https://x.example/"',
    );
    expect(describeNavFailure(err)).toBe("navigation timeout");
  });
  it("never echoes unknown error text", () => {
    expect(describeNavFailure(new Error("boom https://x.example/?token=1"))).toBe(
      "navigation failed (other)",
    );
    expect(describeNavFailure("not an error")).toBe("navigation failed (other)");
  });
});

describe("page_error detail when the page gives no response", () => {
  it("a refused connection reports the network error", async () => {
    const gone = await startFixtureServer();
    const origin = gone.origin;
    await gone.close();
    const s = await open(`${origin}/form`);
    expect(s.stop).toEqual({
      reason: "page_error",
      detail: "no response: navigation failed (net::ERR_CONNECTION_REFUSED)",
    });
  });

  it("our own request guard aborting the page load is named as such", async () => {
    const s = await open("http://not-the-fixture.example/form");
    expect(s.stop?.reason).toBe("page_error");
    expect(s.stop?.detail).toMatch(
      /^no response: navigation failed \(net::ERR_BLOCKED_BY_CLIENT\)/,
    );
    expect(s.stop?.detail).toContain(
      "request guard aborted 1 request(s): host GET not-the-fixture.example",
    );
  });
});
