import { openDb, analysis, postings } from "@job-agent/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("./filters/location.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./filters/location.ts")>();
  return {
    ...actual,
    classifyLocation: (input: Parameters<typeof actual.classifyLocation>[0]) => {
      if (input.locationText === "EXPLODE") throw new Error("filter exploded");
      return actual.classifyLocation(input);
    },
  };
});

const { runProcess } = await import("./process.ts");

describe("runProcess failure isolation", () => {
  it("logs the failing posting, analyses the others and returns 1", () => {
    const db = openDb(":memory:");
    const t = "2026-10-01T00:00:00.000Z";
    for (const [id, company, loc] of [
      ["bad", "Badco", "EXPLODE"],
      ["good", "Goodco", "Worldwide"],
    ] as const) {
      db.insert(postings)
        .values({
          id,
          source: "remotive",
          external_id: id,
          url: `https://example.com/${id}`,
          title: "Engineer",
          company_name: company,
          location_text: loc,
          remote: true,
          first_seen_at: t,
          last_seen_at: t,
        })
        .run();
    }
    const out: string[] = [];
    const err: string[] = [];
    const code = runProcess({
      db,
      floorIdrMonth: 10_000_000,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("posting bad failed: filter exploded");
    expect(
      db
        .select()
        .from(analysis)
        .all()
        .map((a) => a.posting_id),
    ).toEqual(["good"]);
    expect(out.join("")).toContain("processed 1, kept 1");
    expect(out.join("")).toContain("failed 1");
  });
});
