import { describe, expect, it } from "vitest";
import { groupPostings, joinLocations, normalizeTitle } from "./group.ts";

const item = (id: string, title: string, company: string, over = {}) => ({
  id,
  title,
  company,
  isAts: false,
  postedAt: "2026-10-05T00:00:00Z" as string | null,
  ...over,
});

describe("groupPostings", () => {
  it("groups same company + title, ignoring case, punctuation and legal suffix", () => {
    const g = groupPostings([
      item("a", "Senior Engineer", "Acme Inc"),
      item("b", "senior  engineer!", "ACME"),
      item("c", "Senior Engineer", "Acme, Inc."),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0]).toHaveLength(3);
  });

  it("keeps the same title at different companies apart", () => {
    const g = groupPostings([item("a", "Engineer", "Acme"), item("b", "Engineer", "Globex")]);
    expect(g).toHaveLength(2);
  });

  it("keeps different titles at the same company apart", () => {
    const g = groupPostings([item("a", "Engineer", "Acme"), item("b", "Designer", "Acme")]);
    expect(g).toHaveLength(2);
  });

  it("puts the ATS posting first, then the newest", () => {
    const g = groupPostings([
      item("old", "Engineer", "Acme", { postedAt: "2026-10-01T00:00:00Z" }),
      item("new", "Engineer", "Acme", { postedAt: "2026-10-06T00:00:00Z" }),
      item("ats", "Engineer", "Acme", { isAts: true, postedAt: null }),
    ]);
    expect(g[0]?.map((x) => x.id)).toEqual(["ats", "new", "old"]);
  });

  it("normalizes titles", () => {
    expect(normalizeTitle("  Sr. Engineer (Remote) ")).toBe("sr engineer remote");
  });
});

describe("joinLocations", () => {
  it("dedupes case-insensitively and sorts", () => {
    expect(joinLocations(["Berlin", "berlin", " Austin ", null, ""])).toBe("Austin; Berlin");
  });
  it("shows 5 then +N more", () => {
    expect(joinLocations(["a", "b", "c", "d", "e"])).toBe("a; b; c; d; e");
    expect(joinLocations(["a", "b", "c", "d", "e", "f", "g"])).toBe("a; b; c; d; e; +2 more");
  });
});
