import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  SourceBlockedError,
  SourceError,
  SourceSkippedError,
  openDb,
  postings,
  source_runs,
  type Db,
  type SourceAdapter,
} from "@job-agent/core";
import { BLOCK_BACKOFF_HOURS, runDiscover } from "./discover.ts";

const T0 = new Date("2026-10-14T10:00:00.000Z");
const hours = (n: number) => n * 3_600_000;

let db: Db;
let clock: Date;
beforeEach(() => {
  db = openDb(":memory:");
  clock = T0;
});
afterEach(() => db.$client.close());

function tier2(fetch: () => Promise<never[]>): SourceAdapter & { calls: number } {
  const a = {
    name: "linkedin",
    minIntervalMinutes: 50,
    calls: 0,
    fetch: () => {
      a.calls++;
      return fetch();
    },
  };
  return a;
}
const run = (adapter: SourceAdapter, force = false) => {
  const out: string[] = [];
  return runDiscover({
    db,
    adapters: [adapter],
    force,
    now: () => clock,
    out: (t) => out.push(t),
    err: () => undefined,
  }).then((code) => ({ code, out: out.join("") }));
};
const runs = () => db.select().from(source_runs).where(eq(source_runs.source, "linkedin")).all();

describe("Tier 2 block backoff", () => {
  const blocked = () =>
    tier2(() => Promise.reject(new SourceBlockedError("linkedin", "response status code 429")));

  it("a block is an error run with the reason, exit code 1", async () => {
    const a = blocked();
    const { code } = await run(a);
    expect(code).toBe(1);
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({
      status: "error",
      found: 0,
      error_message: "blocked: [linkedin] response status code 429",
    });
  });

  it("the next runs within 6 h are skipped without calling the adapter, even with --force", async () => {
    const a = blocked();
    await run(a);
    expect(a.calls).toBe(1);
    expect(BLOCK_BACKOFF_HOURS).toBe(6);

    for (const [offset, force] of [
      [1, false],
      [3, true],
      [5.9, true],
    ] as const) {
      clock = new Date(T0.getTime() + hours(offset));
      const { code, out } = await run(a, force);
      expect(code).toBe(0);
      expect(out).toContain("backoff after block until 2026-10-14T16:00:00.000Z");
    }
    expect(a.calls).toBe(1);
    const skipped = runs().filter((r) => r.status === "skipped");
    expect(skipped).toHaveLength(3);
    expect(skipped[0]?.error_message).toBe("backoff after block until 2026-10-14T16:00:00.000Z");
  });

  it("skipped backoff runs do not extend the backoff: after 6 h the source runs again", async () => {
    const a = blocked();
    await run(a);
    clock = new Date(T0.getTime() + hours(5));
    await run(a);
    clock = new Date(T0.getTime() + hours(6));
    await run(a);
    expect(a.calls).toBe(2);
    expect(runs().at(-1)?.status).toBe("error");
  });

  it("an ordinary error does not start a backoff", async () => {
    const a = tier2(() => Promise.reject(new SourceError("linkedin", "worker timed out")));
    await run(a);
    clock = new Date(T0.getTime() + hours(1));
    await run(a);
    expect(a.calls).toBe(2);
  });

  it("a SourceSkippedError is recorded as skipped with its reason, no error, no postings", async () => {
    const a = tier2(() =>
      Promise.reject(
        new SourceSkippedError(
          "linkedin",
          "jobspy worker not installed (see workers/jobspy/README.md)",
        ),
      ),
    );
    const { code, out } = await run(a);
    expect(code).toBe(0);
    expect(runs()[0]).toMatchObject({
      status: "skipped",
      found: 0,
      error_message: "jobspy worker not installed (see workers/jobspy/README.md)",
    });
    expect(out).toContain("skipped (jobspy worker not installed");
    expect(db.select().from(postings).all()).toHaveLength(0);
  });

  it("postings fetched before the block are kept", async () => {
    const a = tier2(() =>
      Promise.reject(
        new SourceBlockedError("linkedin", "429", [
          {
            source: "linkedin",
            externalId: "1",
            url: "https://www.linkedin.com/jobs/view/1",
            title: "T",
            company: "C",
          },
        ]),
      ),
    );
    await run(a);
    expect(db.select().from(postings).all()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({ status: "error", found: 1, new: 1 });
  });
});
