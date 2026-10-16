import { beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { analysis, openDb, reviews, type Db } from "@job-agent/core";
import { seedDemo } from "../seed-demo.ts";
import { getQueue } from "./queue.ts";
import { addDays, computeDayStats, doneWhenLine, formatStats, getStats } from "./stats.ts";

const DATE = "2026-03-10";
let db: Db;
let ids: string[];
let n: number;

beforeEach(() => {
  db = openDb(":memory:");
  seedDemo(db, DATE);
  const q = getQueue(db, DATE);
  ids = [...q.sections.top, ...q.sections.suspicious].map((i) => i.postingId);
  n = 0;
});

// Jakarta is UTC+7: 03:00Z is 10:00 on the day.
function review(
  posting: string,
  action: (typeof reviews.$inferInsert)["action"],
  at: string,
  extra: Partial<typeof reviews.$inferInsert> = {},
): void {
  db.insert(reviews)
    .values({
      id: `r${n++}`,
      posting_id: posting,
      action,
      reviewed_at: at,
      review_day: at.slice(0, 10),
      ...extra,
    })
    .run();
}

const id = (i: number): string => ids[i] as string;

describe("computeDayStats", () => {
  it("has 5 matches and nothing else on a day without reviews", () => {
    expect(ids).toHaveLength(5);
    const s = computeDayStats(db, DATE);
    expect(s).toMatchObject({
      matches: 5,
      processed: 0,
      open: 5,
      firstReviewAt: null,
      lastReviewAt: null,
      elapsedMinutes: 0,
      medianSecondsPerPosting: null,
      actions: {},
      reasons: {},
      doneWhenMet: false,
    });
    expect(doneWhenLine(s)).toBe("done-when: 0 min for 5 matches (not met)");
  });

  it("computes every field from fixed timestamps", () => {
    review(id(0), "interested", "2026-03-10T03:00:00.000Z");
    review(id(1), "ask_ok", "2026-03-10T03:00:20.000Z", { tier: "indonesia" });
    review(id(1), "not_interested", "2026-03-10T03:01:00.000Z", { reason: "role" }); // gap 40 s
    review(id(2), "later", "2026-03-10T03:02:00.000Z");
    review(id(3), "not_interested", "2026-03-10T03:05:00.000Z", { reason: "role" }); // gap 180 s
    review(id(4), "applied_manually", "2026-03-10T03:12:00.000Z"); // gap 420 s
    review(id(0), "ask_too_high", "2026-03-10T03:15:00.000Z", { tier: "global_flat" });
    const s = computeDayStats(db, DATE);
    expect(s.matches).toBe(5);
    expect(s.processed).toBe(4);
    expect(s.open).toBe(1);
    expect(s.firstReviewAt).toBe("2026-03-10T03:00:00.000Z");
    expect(s.lastReviewAt).toBe("2026-03-10T03:15:00.000Z");
    expect(s.elapsedMinutes).toBe(15);
    expect(s.medianSecondsPerPosting).toBe(180);
    expect(s.actions).toEqual({
      interested: 1,
      ask_ok: 1,
      not_interested: 2,
      later: 1,
      applied_manually: 1,
      ask_too_high: 1,
    });
    expect(s.reasons).toEqual({ role: 2 });
    expect(s.askChecks.indonesia).toEqual({
      ok: 1,
      too_high: 0,
      too_low: 0,
      total: 1,
      enough: false,
    });
    expect(s.askChecks.global_flat).toMatchObject({ too_high: 1, total: 1 });
    expect(s.askChecks.regional.total).toBe(0);
    expect(s.askChecks.target).toBe(20);
    expect(s.doneWhenMet).toBe(false); // one posting is still open
  });

  it("is met when all matches are processed within 30 minutes", () => {
    ids.forEach((p, i) =>
      review(p, "interested", `2026-03-10T03:${String(i * 5).padStart(2, "0")}:00.000Z`),
    );
    const s = computeDayStats(db, DATE);
    expect(s).toMatchObject({ processed: 5, open: 0, elapsedMinutes: 20, doneWhenMet: true });
    expect(doneWhenLine(s)).toBe("done-when: 20 min for 5 matches (met)");
  });

  it("boundary: exactly 30 minutes is met, 30.5 is not", () => {
    ids.forEach((p, i) => review(p, "interested", `2026-03-10T03:0${i}:00.000Z`));
    review(id(0), "ask_ok", "2026-03-10T03:30:00.000Z");
    expect(computeDayStats(db, DATE)).toMatchObject({ elapsedMinutes: 30, doneWhenMet: true });
    review(id(0), "ask_ok", "2026-03-10T03:30:30.000Z");
    const s = computeDayStats(db, DATE);
    expect(s.elapsedMinutes).toBe(30.5);
    expect(s.doneWhenMet).toBe(false);
    expect(doneWhenLine(s)).toBe("done-when: 30.5 min for 5 matches (not met)");
  });

  it("not met when slow even though all are processed", () => {
    ids.forEach((p, i) => review(p, "interested", `2026-03-10T0${3 + i}:00:00.000Z`));
    const s = computeDayStats(db, DATE);
    expect(s).toMatchObject({ processed: 5, elapsedMinutes: 240, doneWhenMet: false });
  });

  it("counts a posting once even with several processing actions", () => {
    review(id(0), "interested", "2026-03-10T03:00:00.000Z");
    review(id(0), "not_interested", "2026-03-10T03:01:00.000Z", { reason: "stack" });
    const s = computeDayStats(db, DATE);
    expect(s.processed).toBe(1);
    expect(s.medianSecondsPerPosting).toBeNull(); // 2nd action of a posting is a change of mind, not a new gap
  });

  it("counts a reviewed posting that left Top matches as a match and as processed", () => {
    review(id(0), "interested", "2026-03-10T03:00:00.000Z");
    review(id(1), "not_interested", "2026-03-10T03:01:00.000Z", { reason: "role" });
    // Both leave the queue after the review (as the owner saw on a live day).
    db.update(analysis)
      .set({ decision: "reject" })
      .where(inArray(analysis.posting_id, [id(0), id(1)]))
      .run();
    const listed = getQueue(db, DATE).sections.top.map((i) => i.postingId);
    expect(listed).not.toContain(id(0));
    expect(listed).not.toContain(id(1));
    const s = computeDayStats(db, DATE);
    expect(s).toMatchObject({ matches: 5, processed: 2, open: 3 });
  });

  it("a reviewed posting that left Top and was never listed again is not double counted", () => {
    review(id(0), "interested", "2026-03-10T03:00:00.000Z");
    review(id(0), "later", "2026-03-10T03:02:00.000Z");
    db.update(analysis)
      .set({ decision: "reject" })
      .where(eq(analysis.posting_id, id(0)))
      .run();
    const s = computeDayStats(db, DATE);
    expect(s).toMatchObject({ matches: 5, processed: 0, open: 5 });
  });

  it("ignores reviews of other days for timing and actions; ask checks accumulate", () => {
    review(id(0), "ask_ok", "2026-03-08T03:00:00.000Z", { tier: "regional" });
    review(id(0), "interested", "2026-03-10T03:00:00.000Z");
    review(id(1), "ask_ok", "2026-03-11T03:00:00.000Z", { tier: "regional" });
    const s = computeDayStats(db, DATE);
    expect(s.actions).toEqual({ interested: 1 });
    expect(s.elapsedMinutes).toBe(0);
    expect(s.askChecks.regional.total).toBe(1); // 03-08 counts, 03-11 is after the date
  });

  it("flags a tier as enough at 20 checks", () => {
    for (let i = 0; i < 20; i++)
      review(id(0), i % 2 === 0 ? "ask_ok" : "ask_too_low", "2026-03-09T03:00:00.000Z", {
        tier: "regional",
      });
    expect(computeDayStats(db, DATE).askChecks.regional).toEqual({
      ok: 10,
      too_high: 0,
      too_low: 10,
      total: 20,
      enough: true,
    });
  });

  it("median of an even number of gaps averages the middle two", () => {
    review(id(0), "interested", "2026-03-10T03:00:00.000Z");
    review(id(1), "interested", "2026-03-10T03:00:10.000Z");
    review(id(2), "interested", "2026-03-10T03:00:40.000Z");
    expect(computeDayStats(db, DATE).medianSecondsPerPosting).toBe(20);
  });
});

describe("getStats and formatStats", () => {
  it("returns the 7 days ending at the date, oldest first", () => {
    review(id(0), "interested", "2026-03-10T03:00:00.000Z");
    const s = getStats(db, DATE);
    expect(s.week.map((w) => w.date)).toEqual([
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
    ]);
    expect(s.week[6]).toMatchObject({ matches: 5, processed: 1, open: 4, doneWhenMet: false });
    expect(s.week[0]).toMatchObject({ matches: 0, doneWhenMet: false });
  });

  it("addDays crosses month borders", () => {
    expect(addDays("2026-03-02", -6)).toBe("2026-02-24");
  });

  it("prints counts and times only, with the done-when line last", () => {
    review(id(0), "interested", "2026-03-10T03:00:00.000Z", { note: "SECRET NOTE" });
    const text = formatStats(computeDayStats(db, DATE));
    expect(text).toContain("matches: 5, processed: 1, open: 4");
    expect(text).toContain("  indonesia: ok 0, too_high 0, too_low 0, total 0/20");
    expect(text).not.toContain("SECRET NOTE");
    expect(text).not.toContain("Northwind");
    expect(text.trimEnd().split("\n").at(-1)).toBe("done-when: 0 min for 5 matches (not met)");
  });
});
