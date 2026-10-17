import { isAnswerKey } from "@job-agent/core";
import { describe, expect, it } from "vitest";
import { PROFILE_KEYS } from "./fill-plan.ts";

describe("fill-plan standard fields use answer-keys.json", () => {
  it("every standard field key is a real bank key, or null when the bank has none", () => {
    for (const [field, key] of Object.entries(PROFILE_KEYS)) {
      if (key !== null) expect(isAnswerKey(key), `${field} -> ${key}`).toBe(true);
    }
  });

  it("the bank has no cover-letter key, so that field has none", () => {
    expect(PROFILE_KEYS.cover_letter).toBeNull();
  });
});
