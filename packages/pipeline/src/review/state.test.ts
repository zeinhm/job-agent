import { describe, expect, it } from "vitest";
import { reviewState } from "./state.ts";

const row = (action: string, at: string, reason: string | null = null) => ({
  action,
  reason,
  reviewed_at: `2026-03-10T${at}:00.000Z`,
});

describe("reviewState", () => {
  it("is open with no rows", () => {
    expect(reviewState([])).toEqual({
      status: "open",
      reason: null,
      reviewedAt: null,
      processed: false,
    });
  });

  it.each(["interested", "applied_manually", "not_interested"] as const)(
    "%s is processed",
    (action) => {
      const s = reviewState([row(action, "01:00", action === "not_interested" ? "role" : null)]);
      expect(s.status).toBe(action);
      expect(s.processed).toBe(true);
      expect(s.reviewedAt).toBe("2026-03-10T01:00:00.000Z");
    },
  );

  it("keeps the reason of not_interested only", () => {
    expect(reviewState([row("not_interested", "01:00", "salary")]).reason).toBe("salary");
    expect(reviewState([row("interested", "01:00", "salary")]).reason).toBeNull();
  });

  it("later stays open", () => {
    const s = reviewState([row("later", "01:00")]);
    expect(s).toMatchObject({ status: "later", processed: false });
  });

  it("the newest status action wins", () => {
    expect(
      reviewState([row("interested", "01:00"), row("not_interested", "02:00", "role")]).status,
    ).toBe("not_interested");
    expect(
      reviewState([row("not_interested", "01:00", "role"), row("later", "02:00")]),
    ).toMatchObject({
      status: "later",
      processed: false,
    });
  });

  it.each([
    "wrong_apply_link",
    "pay_policy",
    "scam",
    "not_scam",
    "ask_ok",
    "ask_too_high",
    "ask_too_low",
  ])("%s is an extra row and does not change the state", (action) => {
    expect(reviewState([row("interested", "01:00"), row(action, "02:00")])).toMatchObject({
      status: "interested",
      processed: true,
      reviewedAt: "2026-03-10T01:00:00.000Z",
    });
    expect(reviewState([row(action, "01:00")]).status).toBe("open");
  });
});
