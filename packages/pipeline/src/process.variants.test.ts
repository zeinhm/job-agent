import { eq } from "drizzle-orm";
import { analysis, fx_rates, openDb, postings, type Db, type NewPosting } from "@job-agent/core";
import { beforeEach, describe, expect, it } from "vitest";
import { runProcess } from "./process.ts";

const NOW = new Date("2026-10-07T03:00:00Z");
let db: Db;
let n = 0;

function offer(id: string, country: string, text = "Lead our product work. Remote, async.") {
  n += 1;
  const row: NewPosting = {
    id,
    source: "recruitee",
    external_id: `e${n}`,
    url: `https://acme.recruitee.com/o/${id}`,
    title: "Product Engineering Lead",
    company_name: "Acme",
    location_text: "Remote job",
    country,
    description_text: text,
    content_hash: `hash-${text}`,
    first_seen_at: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
    last_seen_at: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
  };
  db.insert(postings).values(row).run();
}

function process() {
  return runProcess({
    db,
    floorIdrMonth: 10_000_000,
    now: () => NOW,
    out: () => {},
    err: () => {},
  });
}

const analysed = () => db.select().from(analysis).all();

beforeEach(() => {
  db = openDb(":memory:");
  n = 0;
  db.insert(fx_rates)
    .values({
      id: "fx1",
      date: "2026-10-06",
      base: "USD",
      quote: "IDR",
      rate: "16000",
      source: "test",
      fetched_at: NOW.toISOString(),
    })
    .run();
});

describe("runProcess with per-country variants", () => {
  it("analyses one posting for the whole group, not one per variant", () => {
    for (const [id, c] of [
      ["a", "United Kingdom"],
      ["b", "India"],
      ["c", "Spain"],
    ] as const) {
      offer(id, c);
    }
    expect(process()).toBe(0);
    expect(analysed().map((a) => a.posting_id)).toEqual(["a"]);
  });

  it("runs the location rules on the union of the countries", () => {
    offer("a", "United Kingdom");
    offer("b", "Spain");
    process();
    const row = analysed()[0];
    expect(row?.location_class).toBe("restricted");
    expect(row?.location_reason).toContain("United Kingdom");

    // An Indonesia variant widens the union: no longer restricted.
    db.delete(analysis).run();
    offer("c", "Indonesia");
    process();
    expect(analysed()[0]?.location_class).toBe("apac_ok");
    expect(db.select().from(postings).where(eq(postings.id, "a")).get()?.apply_url).toBe(
      "https://acme.recruitee.com/o/c",
    );
  });

  it("different text stays separate postings, each analysed", () => {
    offer("a", "United Kingdom", "Text one. Remote.");
    offer("b", "India", "Text two. Remote.");
    process();
    expect(
      analysed()
        .map((a) => a.posting_id)
        .sort(),
    ).toEqual(["a", "b"]);
  });
});
