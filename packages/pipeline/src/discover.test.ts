import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  SourceError,
  openDb,
  postings,
  source_runs,
  type Db,
  type RawPosting,
  type SourceAdapter,
} from "@job-agent/core";
import { runDiscover } from "./discover.ts";

const T0 = new Date("2026-10-07T12:00:00.000Z");
const minutes = (n: number) => n * 60_000;

function raw(source: string, n: number, extra: Partial<RawPosting> = {}): RawPosting {
  return {
    source,
    externalId: `job-${n}`,
    url: `https://example.com/${source}/${n}`,
    title: `Engineer ${n}`,
    company: "Example Co",
    ...extra,
  };
}

function fake(
  name: string,
  fetch: SourceAdapter["fetch"],
  minIntervalMinutes = 60,
): SourceAdapter & { calls: Date[] } {
  const calls: Date[] = [];
  return {
    name,
    minIntervalMinutes,
    calls,
    fetch: (since) => {
      calls.push(since);
      return fetch(since);
    },
  };
}

const three = (source: string) => [raw(source, 1), raw(source, 2), raw(source, 3)];

let db: Db;
let clock: Date;
const now = () => clock;
const run = (opts: Partial<Parameters<typeof runDiscover>[0]> & { adapters: SourceAdapter[] }) => {
  const out: string[] = [];
  const err: string[] = [];
  return runDiscover({
    db,
    now,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    ...opts,
  }).then((code) => ({ code, out, err }));
};
const runsFor = (source: string) =>
  db.select().from(source_runs).where(eq(source_runs.source, source)).all();

beforeEach(() => {
  db = openDb(":memory:");
  clock = T0;
});
afterEach(() => {
  db.$client.close();
});

describe("runDiscover storage", () => {
  it("stores new postings and logs an ok run, then only touches last_seen_at on re-run", async () => {
    const a = fake("remotive", async () => three("remotive"));
    expect((await run({ adapters: [a] })).code).toBe(0);

    expect(db.select().from(postings).all()).toHaveLength(3);
    const [first] = runsFor("remotive");
    expect(first).toMatchObject({ status: "ok", found: 3, new: 3, error_message: null });
    expect(first?.started_at).toBe(T0.toISOString());

    const before = db.select().from(postings).where(eq(postings.external_id, "job-1")).get();
    clock = new Date(T0.getTime() + minutes(5));
    expect((await run({ adapters: [a], force: true })).code).toBe(0);

    const runs = runsFor("remotive");
    expect(runs).toHaveLength(2);
    expect(runs.find((r) => r.started_at === clock.toISOString())).toMatchObject({
      status: "ok",
      found: 3,
      new: 0,
    });
    const after = db.select().from(postings).where(eq(postings.external_id, "job-1")).get();
    expect(db.select().from(postings).all()).toHaveLength(3);
    expect(after?.last_seen_at).toBe(clock.toISOString());
    expect({ ...after, last_seen_at: null }).toEqual({ ...before, last_seen_at: null });
    expect(after?.first_seen_at).toBe(T0.toISOString());
  });

  it("maps fields 1:1 and falls back to descriptionHtml", async () => {
    const a = fake("remotive", async () => [
      raw("remotive", 1, {
        applyUrl: "https://example.com/apply",
        descriptionHtml: "<p>html</p>",
        locationText: "Worldwide",
        remote: true,
        salaryText: "$100k",
        salary: { min: 100, max: 200, currency: "USD", period: "year" },
        postedAt: "2026-10-01T00:00:00Z",
      }),
      raw("remotive", 2, { descriptionHtml: "<p>html</p>", descriptionText: "plain" }),
    ]);
    await run({ adapters: [a] });
    const one = db.select().from(postings).where(eq(postings.external_id, "job-1")).get();
    expect(one).toMatchObject({
      source: "remotive",
      url: "https://example.com/remotive/1",
      apply_url: "https://example.com/apply",
      title: "Engineer 1",
      company_name: "Example Co",
      description_text: "<p>html</p>",
      location_text: "Worldwide",
      remote: true,
      salary_text: "$100k",
      salary_min: 100,
      salary_max: 200,
      salary_currency: "USD",
      salary_period: "year",
      posted_at: "2026-10-01T00:00:00Z",
    });
    const two = db.select().from(postings).where(eq(postings.external_id, "job-2")).get();
    expect(two?.description_text).toBe("plain");
  });

  it("counts a duplicate inside one batch as seen, not new", async () => {
    const a = fake("remotive", async () => [raw("remotive", 1), raw("remotive", 1)]);
    await run({ adapters: [a] });
    expect(runsFor("remotive")[0]).toMatchObject({ found: 2, new: 1 });
    expect(db.select().from(postings).all()).toHaveLength(1);
  });
});

describe("runDiscover poll interval", () => {
  it("skips an adapter whose last ok run was 10 minutes ago, and logs a skipped row", async () => {
    const a = fake("remotive", async () => three("remotive"), 60);
    await run({ adapters: [a] });
    clock = new Date(T0.getTime() + minutes(10));
    const r = await run({ adapters: [a] });

    expect(r.code).toBe(0);
    expect(a.calls).toHaveLength(1);
    const skipped = runsFor("remotive").filter((x) => x.status === "skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ found: 0, new: 0, started_at: clock.toISOString() });
  });

  it("calls the adapter with --force even inside the interval, and logs it", async () => {
    const a = fake("remotive", async () => three("remotive"), 60);
    await run({ adapters: [a] });
    clock = new Date(T0.getTime() + minutes(10));
    await run({ adapters: [a], force: true });
    expect(a.calls).toHaveLength(2);
    expect(runsFor("remotive").filter((x) => x.status === "ok")).toHaveLength(2);
  });

  it("runs again once the interval has elapsed", async () => {
    const a = fake("remotive", async () => [], 60);
    await run({ adapters: [a] });
    clock = new Date(T0.getTime() + minutes(60));
    await run({ adapters: [a] });
    expect(a.calls).toHaveLength(2);
  });

  it("a skipped or error run does not reset the interval", async () => {
    let fail = false;
    const a = fake(
      "remotive",
      async () => {
        if (fail) throw new SourceError("remotive", "boom");
        return [];
      },
      60,
    );
    await run({ adapters: [a] });
    fail = true;
    clock = new Date(T0.getTime() + minutes(70));
    await run({ adapters: [a] }); // due, errors
    clock = new Date(T0.getTime() + minutes(75));
    await run({ adapters: [a] }); // last ok is 75 min old: still due
    expect(a.calls).toHaveLength(3);
  });
});

describe("runDiscover since", () => {
  it("passes the start of the last ok run", async () => {
    const a = fake("remotive", async () => []);
    await run({ adapters: [a] });
    clock = new Date(T0.getTime() + minutes(90));
    await run({ adapters: [a] });
    expect(a.calls[1]?.toISOString()).toBe(T0.toISOString());
  });

  it("uses a stored run as the source of truth", async () => {
    const stored = new Date("2026-10-06T08:30:00.000Z");
    db.insert(source_runs)
      .values({
        id: "r1",
        source: "remotive",
        started_at: stored.toISOString(),
        finished_at: stored.toISOString(),
        status: "ok",
        found: 0,
        new: 0,
      })
      .run();
    const a = fake("remotive", async () => []);
    await run({ adapters: [a] });
    expect(a.calls[0]?.toISOString()).toBe(stored.toISOString());
  });

  it("falls back to now minus 7 days when there is no ok run", async () => {
    const a = fake("remotive", async () => []);
    await run({ adapters: [a] });
    expect(a.calls[0]?.toISOString()).toBe("2026-09-30T12:00:00.000Z");
  });
});

describe("runDiscover errors", () => {
  it("keeps going after a throwing adapter, logs the error and returns 1", async () => {
    const good1 = fake("a", async () => three("a"));
    const bad = fake("b", async () => {
      throw new SourceError("b", "HTTP 500 from https://example.com/?token=[redacted]");
    });
    const good2 = fake("c", async () => three("c"));
    const r = await run({ adapters: [good1, bad, good2] });

    expect(r.code).toBe(1);
    expect(db.select().from(postings).all()).toHaveLength(6);
    expect(runsFor("a")[0]?.status).toBe("ok");
    expect(runsFor("c")[0]?.status).toBe("ok");
    expect(runsFor("b")[0]).toMatchObject({
      status: "error",
      found: 0,
      new: 0,
      error_message: "[b] HTTP 500 from https://example.com/?token=[redacted]",
    });
  });

  it("does not store the raw message of a non-SourceError", async () => {
    const bad = fake("b", async () => {
      throw new Error("secret https://x/?token=abc123");
    });
    const r = await run({ adapters: [bad] });
    expect(r.code).toBe(1);
    const msg = runsFor("b")[0]?.error_message;
    expect(msg).toBe("[b] unexpected error (Error)");
    expect(msg).not.toContain("abc123");
  });

  it("stores nothing from an adapter whose batch fails to store", async () => {
    const bad = fake("b", async () => [raw("b", 1), { ...raw("b", 2), title: undefined as never }]);
    const r = await run({ adapters: [bad] });
    expect(r.code).toBe(1);
    expect(db.select().from(postings).all()).toHaveLength(0);
    expect(runsFor("b")[0]?.status).toBe("error");
  });
});

describe("runDiscover ordering and selection", () => {
  it("runs adapters sequentially", async () => {
    let active = 0;
    let maxActive = 0;
    const slow = (name: string) =>
      fake(name, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((res) => setTimeout(res, 20));
        active--;
        return [];
      });
    const order: string[] = [];
    const adapters = ["a", "b", "c"].map(slow);
    adapters.forEach((a) => {
      const orig = a.fetch;
      a.fetch = (s) => {
        order.push(a.name);
        return orig(s);
      };
    });
    await run({ adapters });
    expect(maxActive).toBe(1);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("--source runs only that adapter", async () => {
    const a = fake("remotive", async () => []);
    const b = fake("remoteok", async () => []);
    const r = await run({ adapters: [a, b], source: "remotive" });
    expect(r.code).toBe(0);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
    expect(runsFor("remoteok")).toHaveLength(0);
  });

  it("an unknown source returns 1 and lists the valid names", async () => {
    const a = fake("remotive", async () => []);
    const b = fake("remoteok", async () => []);
    const r = await run({ adapters: [a, b], source: "nope" });
    expect(r.code).toBe(1);
    expect(r.err.join("")).toContain("Unknown source: nope");
    expect(r.err.join("")).toContain("remotive, remoteok");
    expect(a.calls).toHaveLength(0);
    expect(db.select().from(source_runs).all()).toHaveLength(0);
  });
});
