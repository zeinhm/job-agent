import { isAnswerKey } from "@job-agent/core";
import { describe, expect, it } from "vitest";
import { COVER_LETTER_TEXT_KEY, PROFILE_KEYS } from "./fill-plan.ts";

describe("fill-plan standard fields use answer-keys.json", () => {
  it("every standard field key is a real bank key, or null when the bank has none", () => {
    for (const [field, key] of Object.entries(PROFILE_KEYS)) {
      if (key !== null) expect(isAnswerKey(key), `${field} -> ${key}`).toBe(true);
    }
  });

  it("a cover letter FILE has no bank key; its text and the additional information use real keys", () => {
    expect(PROFILE_KEYS.cover_letter).toBeNull();
    expect(isAnswerKey(COVER_LETTER_TEXT_KEY)).toBe(true);
    expect(PROFILE_KEYS.additional_info).toBe("misc.contractor_note");
  });
});
