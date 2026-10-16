import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { companies, openDb, postings, type Db } from "@job-agent/core";
import { renormalizeCompanies } from "./merge-companies.ts";

let db: Db;
const warn = vi.fn();

beforeEach(() => {
  db = openDb(":memory:");
  warn.mockReset();
});

function addCompany(
  id: string,
  name: string,
  oldKey: string,
  extra: Partial<typeof companies.$inferInsert> = {},
) {
  db.insert(companies)
    .values({ id, name, normalized_name: oldKey, created_at: "2026-10-01T00:00:00.000Z", ...extra })
    .run();
}

function addPosting(id: string, companyId: string, name: string) {
  db.insert(postings)
    .values({
      id,
      source: "remotive",
      external_id: id,
      url: `https://example.test/${id}`,
      title: "Engineer",
      company_id: companyId,
      company_name: name,
      first_seen_at: "2026-10-01T00:00:00.000Z",
      last_seen_at: "2026-10-01T00:00:00.000Z",
    })
    .run();
}

const row = (id: string) => db.select().from(companies).where(eq(companies.id, id)).get();
const keys = () =>
  db
    .select({ id: companies.id, key: companies.normalized_name })
    .from(companies)
    .all()
    .sort((a, b) => a.id.localeCompare(b.id));

describe("renormalizeCompanies", () => {
  it("merges 'Tether.io' into the row with the ATS board and repoints postings", () => {
    addCompany("c-io", "Tether.io", "tetherio", { domain: "tether.example" });
    addCompany("c-ops", "Tether Operations Limited", "tether operations", {
      ats_type: "recruitee",
      ats_slug: "tether",
      created_at: "2026-10-02T00:00:00.000Z",
    });
    addPosting("p1", "c-io", "Tether.io");
    addPosting("p2", "c-ops", "Tether Operations Limited");

    const r = renormalizeCompanies(db, { warn });

    expect(r).toEqual({ renamed: 1, merged: 1, kept: 0 });
    expect(keys()).toEqual([{ id: "c-ops", key: "tether" }]);
    // The winner (board) gains the loser's domain and keeps its board.
    expect(row("c-ops")).toMatchObject({
      ats_type: "recruitee",
      ats_slug: "tether",
      domain: "tether.example",
    });
    for (const id of ["p1", "p2"]) {
      expect(db.select().from(postings).where(eq(postings.id, id)).get()?.company_id).toBe("c-ops");
    }
    expect(warn).not.toHaveBeenCalled();
    // A second run changes nothing.
    expect(renormalizeCompanies(db, { warn })).toEqual({ renamed: 0, merged: 0, kept: 0 });
  });

  it("lets an owner pay-policy mark win and carries the other row's board over", () => {
    addCompany("c-board", "Acme Ltd", "acme", {
      ats_type: "greenhouse",
      ats_slug: "acme",
      ats_checked_at: "2026-10-05T00:00:00.000Z",
    });
    addCompany("c-owner", "Acme.com", "acmecom", {
      pay_policy: "location_agnostic",
      pay_policy_source: "owner:2026-10-10",
      pay_policy_checked_at: "2026-10-10T00:00:00.000Z",
      created_at: "2026-10-03T00:00:00.000Z",
    });
    addPosting("p1", "c-board", "Acme Ltd");

    renormalizeCompanies(db, { warn });

    expect(keys()).toEqual([{ id: "c-owner", key: "acme" }]);
    expect(row("c-owner")).toMatchObject({
      pay_policy: "location_agnostic",
      pay_policy_source: "owner:2026-10-10",
      ats_type: "greenhouse",
      ats_slug: "acme",
      ats_checked_at: "2026-10-05T00:00:00.000Z",
    });
    expect(db.select().from(postings).get()?.company_id).toBe("c-owner");
  });

  it("does not merge rows whose owner pay-policy marks conflict; it keeps both and warns once", () => {
    addCompany("c-a", "Acme Ltd", "acme", {
      pay_policy: "location_agnostic",
      pay_policy_source: "owner:2026-10-10",
    });
    addCompany("c-b", "Acme.com", "acmecom", {
      pay_policy: "location_adjusted",
      pay_policy_source: "owner:2026-10-11",
    });
    addPosting("p1", "c-a", "Acme Ltd");
    addPosting("p2", "c-b", "Acme.com");

    const r = renormalizeCompanies(db, { warn });

    expect(r).toEqual({ renamed: 0, merged: 0, kept: 2 });
    expect(keys()).toEqual([
      { id: "c-a", key: "acme" },
      { id: "c-b", key: "acmecom" },
    ]);
    expect(row("c-a")?.pay_policy).toBe("location_agnostic");
    expect(row("c-b")?.pay_policy).toBe("location_adjusted");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/conflicting owner pay-policy marks/);
    expect(db.select().from(postings).where(eq(postings.id, "p2")).get()?.company_id).toBe("c-b");
  });

  it("merges rows whose owner marks agree", () => {
    addCompany("c-a", "Acme Ltd", "acme", {
      pay_policy: "location_agnostic",
      pay_policy_source: "owner:2026-10-10",
    });
    addCompany("c-b", "Acme.com", "acmecom", {
      pay_policy: "location_agnostic",
      pay_policy_source: "owner:2026-10-11",
      created_at: "2026-10-02T00:00:00.000Z",
    });
    renormalizeCompanies(db, { warn });
    expect(keys()).toEqual([{ id: "c-a", key: "acme" }]);
    expect(row("c-a")?.pay_policy_source).toBe("owner:2026-10-10");
  });

  it("freezes an unmarked row whose new key would collide with a kept conflicting row", () => {
    addCompany("c-a", "Acme Ltd", "acme", {
      pay_policy: "location_agnostic",
      pay_policy_source: "owner:2026-10-10",
    });
    addCompany("c-b", "Acme.com", "acmecom", {
      pay_policy: "location_adjusted",
      pay_policy_source: "owner:2026-10-11",
    });
    addCompany("c-c", "Acme Technologies", "acme technologies");

    renormalizeCompanies(db, { warn });

    expect(keys()).toEqual([
      { id: "c-a", key: "acme" },
      { id: "c-b", key: "acmecom" },
      { id: "c-c", key: "acme technologies" },
    ]);
  });

  it("renames a row without merging when its key is unique", () => {
    addCompany("c-x", "Zed Technologies Inc", "zed technologies");
    const r = renormalizeCompanies(db, { warn });
    expect(r).toEqual({ renamed: 1, merged: 0, kept: 0 });
    expect(row("c-x")?.normalized_name).toBe("zed");
  });
});
