import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, postings, type Db, type RawPosting, type SourceAdapter } from "@job-agent/core";
import { contentHash, runDiscover } from "./discover.ts";

let db: Db;

const raw = (extra: Partial<RawPosting> = {}): RawPosting => ({
  source: "recruitee",
  externalId: "2778836",
  url: "https://acme.recruitee.com/o/product-lead-uk",
  title: "Product Lead",
  company: "Acme",
  descriptionText: "Same text.",
  locationText: "Remote job",
  ...extra,
});

async function discover(items: RawPosting[]) {
  const adapter: SourceAdapter = {
    name: "recruitee",
    minIntervalMinutes: 0,
    fetch: async () => items,
  };
  await runDiscover({ db, adapters: [adapter], force: true, out: () => {} });
}

const stored = () => db.select().from(postings).where(eq(postings.external_id, "2778836")).get();

beforeEach(() => {
  db = openDb(":memory:");
});

describe("per-offer country", () => {
  it("is stored with the posting and kept out of the content hash", async () => {
    expect(contentHash(raw({ country: "United Kingdom" }))).toBe(
      contentHash(raw({ country: "India" })),
    );
    await discover([raw({ country: "United Kingdom" })]);
    expect(stored()?.country).toBe("United Kingdom");
  });

  it("is filled in for a posting stored before the column existed, without a refresh", async () => {
    await discover([raw()]);
    expect(stored()?.country).toBeNull();
    const before = stored();
    await discover([raw({ country: "United Kingdom" })]);
    expect(stored()?.country).toBe("United Kingdom");
    expect(stored()?.updated_at).toBe(before?.updated_at ?? null);
    expect(stored()?.normalized_at).toBe(before?.normalized_at ?? null);
  });
});
