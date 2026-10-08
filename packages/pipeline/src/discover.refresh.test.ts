import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  analysis,
  fx_rates,
  intel,
  openDb,
  postings,
  type Db,
  type RawPosting,
  type SourceAdapter,
} from "@job-agent/core";
import { runDigest } from "./digest/index.ts";
import { runDiscover } from "./discover.ts";
import { runProcess } from "./process.ts";

const T0 = new Date("2026-10-07T03:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

let db: Db;
let clock: Date;
let outDir: string;

function posting(extra: Partial<RawPosting> = {}): RawPosting {
  return {
    source: "remotive",
    externalId: "job-1",
    url: "https://example.com/1",
    title: "Senior Frontend Engineer",
    company: "Example Co",
    descriptionText: "Build UIs.",
    locationText: "Worldwide",
    remote: true,
    ...extra,
  };
}

async function discover(items: RawPosting[]) {
  const adapter: SourceAdapter = {
    name: "remotive",
    minIntervalMinutes: 0,
    fetch: async () => items,
  };
  await runDiscover({ db, adapters: [adapter], force: true, now: () => clock, out: () => {} });
}

function process_() {
  return runProcess({
    db,
    floorIdrMonth: 10_000_000,
    now: () => clock,
    out: () => {},
    err: () => {},
  });
}

function digest(date: string) {
  runDigest({ db, date, outDir, now: () => clock, out: () => {} });
  return readFileSync(join(outDir, `${date}.md`), "utf8");
}

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("expected a row");
  return v;
}
const one = () => must(db.select().from(postings).where(eq(postings.external_id, "job-1")).get());
const analysisOf = (id: string) =>
  db.select().from(analysis).where(eq(analysis.posting_id, id)).all();

function seedIntel(postingId: string) {
  db.insert(intel)
    .values({ id: "i1", posting_id: postingId, status: "done", updated_at: clock.toISOString() })
    .run();
}

beforeEach(() => {
  db = openDb(":memory:");
  clock = T0;
  outDir = mkdtempSync(join(tmpdir(), "job-agent-refresh-"));
  db.insert(fx_rates)
    .values({
      id: "fx1",
      date: "2026-10-07",
      base: "USD",
      quote: "IDR",
      rate: "16000",
      source: "test",
      fetched_at: T0.toISOString(),
    })
    .run();
});
afterEach(() => {
  db.$client.close();
  rmSync(outDir, { recursive: true, force: true });
});

describe("posting refresh on discover", () => {
  it("same content: no update, analysis and intel untouched", async () => {
    await discover([posting()]);
    process_();
    const id = one().id;
    seedIntel(id);
    const analysed = analysisOf(id)[0];

    clock = new Date(T0.getTime() + DAY);
    await discover([posting()]);

    expect(one().updated_at).toBeNull();
    expect(one().normalized_at).not.toBeNull();
    expect(one().last_seen_at).toBe(clock.toISOString());
    expect(analysisOf(id)).toEqual([analysed]);
    expect(db.select().from(intel).all()).toHaveLength(1);
  });

  it("changed description: row updated, analysis and intel dropped, analysis redone", async () => {
    await discover([posting()]);
    process_();
    const id = one().id;
    seedIntel(id);
    expect(analysisOf(id)[0]?.location_class).toBe("worldwide");

    clock = new Date(T0.getTime() + DAY);
    await discover([posting({ descriptionText: "Now US only.", locationText: "US only" })]);

    const row = one();
    expect(row.description_text).toBe("Now US only.");
    expect(row.updated_at).toBe(clock.toISOString());
    expect(row.normalized_at).toBeNull();
    expect(row.first_seen_at).toBe(T0.toISOString());
    expect(analysisOf(id)).toHaveLength(0);
    expect(db.select().from(intel).all()).toHaveLength(0);

    process_();
    expect(analysisOf(id)[0]).toMatchObject({ location_class: "restricted", decision: "reject" });
    expect(one().normalized_at).not.toBeNull();
  });

  it("changed salary or title also counts as a change", async () => {
    await discover([posting()]);
    await discover([posting({ salary: { min: 1, max: 2, currency: "USD", period: "year" } })]);
    expect(one().updated_at).not.toBeNull();
    const first = one().content_hash;
    await discover([posting({ salary: { min: 1, max: 2, currency: "USD", period: "year" } })]);
    expect(one().content_hash).toBe(first);
  });

  it("digested posting that stays keep is not re-sent", async () => {
    await discover([posting()]);
    process_();
    const day1 = digest("2026-10-07");
    expect(day1).toContain("Senior Frontend Engineer");
    const id = one().id;
    expect(analysisOf(id)[0]?.digested_at).toBe("2026-10-07");

    clock = new Date(T0.getTime() + DAY);
    await discover([posting({ descriptionText: "Build UIs, now with TypeScript." })]);
    expect(analysisOf(id)).toHaveLength(1); // tombstone keeps digested_at
    process_();

    const redone = analysisOf(id);
    expect(redone).toHaveLength(1);
    expect(redone[0]).toMatchObject({ decision: "keep", digested_at: "2026-10-07" });
    expect(redone[0]?.analyzed_at).toBe(clock.toISOString());
    expect(digest("2026-10-08")).not.toContain("Senior Frontend Engineer");
  });

  it("a reject that becomes keep after the edit is sent", async () => {
    await discover([posting({ locationText: "US only" })]);
    process_();
    const id = one().id;
    expect(analysisOf(id)[0]?.decision).toBe("reject");
    expect(digest("2026-10-07")).not.toContain("Senior Frontend Engineer");

    clock = new Date(T0.getTime() + DAY);
    await discover([posting({ locationText: "Worldwide" })]);
    process_();
    expect(analysisOf(id)[0]).toMatchObject({ decision: "keep", digested_at: null });
    expect(digest("2026-10-08")).toContain("Senior Frontend Engineer");
  });

  it("dedupe stays correct after a title update", async () => {
    const other = (extra: Partial<RawPosting> = {}) =>
      posting({
        source: "greenhouse",
        externalId: "gh-1",
        url: "https://example.com/gh/1",
        ...extra,
      });
    await discover([posting()]);
    await runDiscover({
      db,
      adapters: [{ name: "greenhouse", minIntervalMinutes: 0, fetch: async () => [other()] }],
      force: true,
      now: () => clock,
      out: () => {},
    });
    process_();
    const rows = db.select().from(postings).all();
    const remotive = must(rows.find((r) => r.source === "remotive"));
    const gh = must(rows.find((r) => r.source === "greenhouse"));
    expect(remotive.canonical_posting_id).toBe(gh.id);
    expect(gh.canonical_posting_id).toBeNull();

    // Same-title edit (description only) keeps the group intact.
    clock = new Date(T0.getTime() + DAY);
    await discover([posting({ descriptionText: "Edited text." })]);
    process_();
    expect(db.select().from(postings).where(eq(postings.id, remotive.id)).get()).toMatchObject({
      canonical_posting_id: gh.id,
    });

    // A title edit moves it out of the group; the other copy is standalone and the groups stay consistent.
    await discover([posting({ title: "Senior Backend Engineer" })]);
    process_();
    const after = db.select().from(postings).all();
    expect(after.every((r) => r.canonical_posting_id === null)).toBe(true);
    expect(after.find((r) => r.id === remotive.id)?.dedupe_hash).not.toBe(
      after.find((r) => r.id === gh.id)?.dedupe_hash,
    );
    expect(analysisOf(remotive.id)).toHaveLength(1);
    expect(analysisOf(gh.id)).toHaveLength(1);
  });

  it("rows stored before content_hash only get the hash", async () => {
    await discover([posting()]);
    process_();
    const id = one().id;
    db.update(postings).set({ content_hash: null }).where(eq(postings.id, id)).run();
    await discover([posting({ descriptionText: "Different." })]);
    expect(one().content_hash).not.toBeNull();
    expect(one().updated_at).toBeNull();
    expect(analysisOf(id)).toHaveLength(1);
  });
});
