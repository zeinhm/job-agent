import { beforeEach, describe, expect, it } from "vitest";
import { openDb, postings, reviews, type Db } from "@job-agent/core";
import { seedDemo } from "../seed-demo.ts";
import { getPostingDetail, getQueue } from "./queue.ts";
import { canonicalPostingId, recordReview, ReviewInputSchema } from "./record.ts";

const DATE = "2026-03-10";
const TOP = `demo-${DATE}-top-ats`;
const DUP = `demo-${DATE}-top-ats-dup`;
const NOW = new Date("2026-03-10T09:30:00.000Z");

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
  seedDemo(db, DATE);
  db.insert(postings)
    .values({
      id: DUP,
      source: "remoteok",
      external_id: "dup-1",
      url: "https://dup.example.com/jobs/1",
      title: "Senior Backend Engineer",
      company_name: "Northwind Demo Labs",
      first_seen_at: "2026-03-10T03:00:00.000Z",
      last_seen_at: "2026-03-10T03:00:00.000Z",
      canonical_posting_id: TOP,
    })
    .run();
});

describe("ReviewInputSchema", () => {
  const ok = (v: unknown) => ReviewInputSchema.safeParse(v).success;

  it("accepts each action with its fields", () => {
    expect(ok({ posting_id: "p", action: "interested" })).toBe(true);
    expect(ok({ posting_id: "p", action: "not_interested", reason: "role" })).toBe(true);
    expect(ok({ posting_id: "p", action: "not_interested", reason: "other", note: "n" })).toBe(
      true,
    );
    expect(ok({ posting_id: "p", action: "wrong_apply_link" })).toBe(true);
    expect(
      ok({ posting_id: "p", action: "wrong_apply_link", apply_url: "https://a.example.com/x" }),
    ).toBe(true);
    expect(ok({ posting_id: "p", action: "pay_policy", pay_policy: "location_agnostic" })).toBe(
      true,
    );
    expect(ok({ posting_id: "p", action: "ask_too_high", note: "n" })).toBe(true);
  });

  it("not_interested needs a reason, and `other` needs a note", () => {
    expect(ok({ posting_id: "p", action: "not_interested" })).toBe(false);
    expect(ok({ posting_id: "p", action: "not_interested", reason: "other" })).toBe(false);
    expect(ok({ posting_id: "p", action: "not_interested", reason: "other", note: "  " })).toBe(
      false,
    );
    expect(ok({ posting_id: "p", action: "not_interested", reason: "nope" })).toBe(false);
  });

  it("rejects fields that do not belong to the action", () => {
    expect(ok({ posting_id: "p", action: "interested", reason: "role" })).toBe(false);
    expect(ok({ posting_id: "p", action: "interested", apply_url: "https://a.example.com" })).toBe(
      false,
    );
    expect(ok({ posting_id: "p", action: "interested", pay_policy: "location_agnostic" })).toBe(
      false,
    );
    expect(ok({ posting_id: "p", action: "pay_policy" })).toBe(false);
    expect(ok({ posting_id: "p", action: "pay_policy", pay_policy: "unknown" })).toBe(false);
  });

  it("rejects unknown actions, extra keys, non-http URLs and a missing id", () => {
    expect(ok({ posting_id: "p", action: "apply" })).toBe(false);
    expect(ok({ posting_id: "p", action: "interested", extra: 1 })).toBe(false);
    expect(
      ok({ posting_id: "p", action: "wrong_apply_link", apply_url: "javascript:alert(1)" }),
    ).toBe(false);
    expect(ok({ posting_id: "p", action: "wrong_apply_link", apply_url: "not a url" })).toBe(false);
    expect(ok({ action: "interested" })).toBe(false);
    expect(ok({ posting_id: "", action: "interested" })).toBe(false);
  });
});

describe("canonicalPostingId", () => {
  it("maps a duplicate to its canonical posting, and null for an unknown id", () => {
    expect(canonicalPostingId(db, DUP)).toBe(TOP);
    expect(canonicalPostingId(db, TOP)).toBe(TOP);
    expect(canonicalPostingId(db, "nope")).toBeNull();
  });
});

describe("recordReview", () => {
  it("stores the snapshot columns and returns the new state", () => {
    const res = recordReview(db, { posting_id: TOP, action: "interested" }, NOW);
    expect(res?.state).toEqual({
      status: "interested",
      reason: null,
      reviewedAt: NOW.toISOString(),
      processed: true,
    });
    const row = db.select().from(reviews).get();
    expect(row).toMatchObject({
      posting_id: TOP,
      action: "interested",
      reviewed_at: NOW.toISOString(),
      review_day: "2026-03-10",
      fit_score: 88,
      final_decision: "keep",
      tier: "global_flat",
      apply_type: "ats",
    });
  });

  it("uses the Asia/Jakarta day for review_day", () => {
    recordReview(db, { posting_id: TOP, action: "later" }, new Date("2026-03-10T20:00:00.000Z"));
    expect(db.select().from(reviews).get()?.review_day).toBe("2026-03-11");
  });

  it("maps a non-canonical id to the canonical posting", () => {
    recordReview(db, { posting_id: DUP, action: "applied_manually" }, NOW);
    expect(db.select().from(reviews).get()?.posting_id).toBe(TOP);
  });

  it("returns null and writes nothing for an unknown posting", () => {
    expect(recordReview(db, { posting_id: "nope", action: "interested" }, NOW)).toBeNull();
    expect(db.select().from(reviews).all()).toHaveLength(0);
  });

  it("keeps the state across extra rows and appends history", () => {
    recordReview(db, { posting_id: TOP, action: "later" }, new Date("2026-03-10T01:00:00.000Z"));
    recordReview(db, { posting_id: TOP, action: "scam" }, new Date("2026-03-10T02:00:00.000Z"));
    const res = recordReview(
      db,
      { posting_id: TOP, action: "ask_too_low", note: "n" },
      new Date("2026-03-10T03:00:00.000Z"),
    );
    expect(res?.state).toMatchObject({ status: "later", processed: false });
    expect(db.select().from(reviews).all()).toHaveLength(3);
  });

  it("orders rows recorded in the same millisecond by insertion", () => {
    recordReview(db, { posting_id: TOP, action: "interested" }, NOW);
    const res = recordReview(
      db,
      { posting_id: TOP, action: "not_interested", reason: "role" },
      NOW,
    );
    expect(res?.state.status).toBe("not_interested");
  });
});

describe("queue and detail with reviews", () => {
  it("shows the current review state per row", () => {
    recordReview(db, { posting_id: TOP, action: "not_interested", reason: "stack" }, NOW);
    const q = getQueue(db, DATE);
    expect(q.sections.top[0]).toMatchObject({
      postingId: TOP,
      review: { status: "not_interested", reason: "stack", processed: true },
    });
    expect(q.sections.top[1]?.review.status).toBe("open");
  });

  it("detail maps a duplicate to the canonical posting and lists history newest first", () => {
    recordReview(
      db,
      { posting_id: DUP, action: "interested" },
      new Date("2026-03-10T01:00:00.000Z"),
    );
    recordReview(db, { posting_id: TOP, action: "later" }, new Date("2026-03-10T02:00:00.000Z"));
    const d = getPostingDetail(db, DUP);
    expect(d?.postingId).toBe(TOP);
    expect(d?.history.map((h) => h.action)).toEqual(["later", "interested"]);
    expect(d?.review.status).toBe("later");
    expect(typeof d?.descriptionText).toBe("string");
    expect(d?.reasons.fit.length).toBeGreaterThan(0);
  });

  it("detail is null for an unknown id", () => {
    expect(getPostingDetail(db, "nope")).toBeNull();
  });
});
