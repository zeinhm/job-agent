import { isAnswerKey } from "@job-agent/core";
import { describe, expect, it } from "vitest";
import { DEMO_ANSWERS, DEMO_DRY_RUNS, DEMO_POSTINGS } from "./seed-demo.fixtures.ts";

describe("seed-demo uses answer-keys.json", () => {
  it("every demo answer, dry-run field and matched question key is a real bank key", () => {
    const keys = [
      ...DEMO_ANSWERS.map((a) => a.key),
      ...DEMO_DRY_RUNS.flatMap((r) =>
        r.fields.flatMap((f) => (f.key === undefined ? [] : [f.key])),
      ),
      ...(JSON.stringify(DEMO_POSTINGS).match(/"matchedKey":"[^"]+"/g) ?? []).map((s) =>
        s.slice(14, -1),
      ),
    ];
    expect(keys.length).toBeGreaterThan(3);
    for (const k of keys) expect(isAnswerKey(k), k).toBe(true);
  });
});
