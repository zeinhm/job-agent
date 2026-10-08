import { companies, openDb, postings, type Db, type NewPosting } from "@job-agent/core";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { titlesMatch, verifyAgainstAts } from "./verify.ts";

const NOW = new Date("2026-10-09T05:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

let db: Db;

function addCompany(over: Partial<typeof companies.$inferInsert> = {}) {
  db.insert(companies)
    .values({
      id: "c1",
      name: "Acme Inc",
      normalized_name: "acme",
      ats_type: "greenhouse",
      ats_slug: "acme",
      created_at: NOW.toISOString(),
      ...over,
    })
    .run();
}

function addPosting(id: string, over: Partial<NewPosting> = {}) {
  db.insert(postings)
    .values({
      id,
      source: "remotive",
      external_id: id,
      url: `https://example.com/${id}`,
      title: "Senior Frontend Engineer",
      company_id: "c1",
      company_name: "Acme Inc",
      first_seen_at: hoursAgo(1),
      last_seen_at: hoursAgo(1),
      ...over,
    })
    .run();
  const row = db.select().from(postings).where(eq(postings.id, id)).get();
  if (!row) throw new Error("posting not inserted");
  return row;
}

beforeEach(() => {
  db = openDb(":memory:");
});

describe("titlesMatch", () => {
  it("ignores case, punctuation and parenthetical location", () => {
    expect(titlesMatch("Senior Frontend Engineer (Remote)", "senior frontend engineer")).toBe(true);
    expect(titlesMatch("Sr. Frontend Engineer", "Senior Frontend Engineer")).toBe(false);
    expect(titlesMatch("Senior Frontend Engineer", "Senior Backend Engineer")).toBe(false);
  });
});

describe("verifyAgainstAts", () => {
  it("a posting from an ATS adapter is verified", () => {
    addCompany();
    expect(verifyAgainstAts(db, addPosting("p", { source: "greenhouse" }), NOW)).toBe("verified");
  });

  it("same role on the company's ATS (last 7 days) verifies a board posting", () => {
    addCompany();
    addPosting("ats", { source: "greenhouse", last_seen_at: hoursAgo(24 * 6) });
    const p = addPosting("p", { title: "Senior Frontend Engineer (Remote)" });
    expect(verifyAgainstAts(db, p, NOW)).toBe("verified");
  });

  it("an ATS posting last seen 8 days ago does not verify", () => {
    addCompany();
    addPosting("ats", { source: "greenhouse", last_seen_at: hoursAgo(24 * 8) });
    expect(verifyAgainstAts(db, addPosting("p"), NOW)).toBe("unknown");
  });

  it("board read today but no matching title -> missing", () => {
    addCompany();
    addPosting("ats", { source: "greenhouse", title: "Account Executive" });
    expect(verifyAgainstAts(db, addPosting("p"), NOW)).toBe("missing");
  });

  it("board not read in the last 24 h -> unknown, not missing", () => {
    addCompany();
    addPosting("ats", {
      source: "greenhouse",
      title: "Account Executive",
      last_seen_at: hoursAgo(48),
    });
    expect(verifyAgainstAts(db, addPosting("p"), NOW)).toBe("unknown");
  });

  it("company without a configured ATS -> unknown", () => {
    addCompany({ ats_type: null, ats_slug: null });
    expect(verifyAgainstAts(db, addPosting("p"), NOW)).toBe("unknown");
  });

  it("apply URL on the configured board verifies; another slug on the same host does not", () => {
    addCompany();
    const ok = addPosting("ok", { apply_url: "https://boards.greenhouse.io/acme/jobs/1" });
    const other = addPosting("other", {
      title: "Something Else",
      apply_url: "https://boards.greenhouse.io/acme-careers/jobs/1",
    });
    expect(verifyAgainstAts(db, ok, NOW)).toBe("verified");
    expect(verifyAgainstAts(db, other, NOW)).toBe("unknown");
  });

  it("no company row -> unknown", () => {
    expect(verifyAgainstAts(db, addPosting("p", { company_id: null }), NOW)).toBe("unknown");
  });
});
