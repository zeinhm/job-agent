import { describe, expect, it } from "vitest";
import { compareRanked, rankScore, salaryBonusApplies } from "./rank.ts";

const base = { remainingUnclearFlags: 0, listedMaxIdrMonth: null, askIdrMonth: null };

describe("rankScore", () => {
  it("is the fit score when nothing else applies", () => {
    expect(rankScore({ ...base, fitScore: 77 })).toBe(77);
  });
  it("ranks fit 80 with 1 unclear flag below fit 75 with none", () => {
    const flagged = rankScore({ ...base, fitScore: 80, remainingUnclearFlags: 1 });
    const clean = rankScore({ ...base, fitScore: 75 });
    expect(flagged).toBe(70);
    expect(flagged).toBeLessThan(clean);
  });
  it("takes 10 per unclear flag", () => {
    expect(rankScore({ ...base, fitScore: 90, remainingUnclearFlags: 3 })).toBe(60);
  });
  it("adds 5 only when the listed max is at or above the ask", () => {
    const at = { ...base, fitScore: 70, listedMaxIdrMonth: 30_000_000, askIdrMonth: 30_000_000 };
    expect(rankScore(at)).toBe(75);
    expect(rankScore({ ...at, listedMaxIdrMonth: 40_000_000 })).toBe(75);
    expect(rankScore({ ...at, listedMaxIdrMonth: 29_999_999 })).toBe(70);
  });
  it("gives no bonus without a listed max or without an ask", () => {
    expect(salaryBonusApplies(null, 30_000_000)).toBe(false);
    expect(salaryBonusApplies(30_000_000, null)).toBe(false);
    expect(salaryBonusApplies(null, null)).toBe(false);
  });
});

describe("compareRanked", () => {
  it("sorts by rank desc, then posted_at desc, nulls last", () => {
    const items = [
      { id: "low", rank: 60, postedAt: "2026-10-09" },
      { id: "old", rank: 80, postedAt: "2026-10-01" },
      { id: "none", rank: 80, postedAt: null },
      { id: "new", rank: 80, postedAt: "2026-10-05" },
    ];
    expect(items.sort(compareRanked).map((x) => x.id)).toEqual(["new", "old", "none", "low"]);
  });
});
