import { eq } from "drizzle-orm";
import { companies, openDb, type Db } from "@job-agent/core";
import { beforeEach, describe, expect, it } from "vitest";
import type { Extraction } from "./extract.ts";
import { payPolicyFor, recordPostingPolicy } from "./registry.ts";

let db: Db;

function addCompany(over: Partial<typeof companies.$inferInsert> = {}) {
  db.insert(companies)
    .values({
      id: "c1",
      name: "Acme",
      normalized_name: "acme",
      created_at: "2026-10-01T00:00:00Z",
      ...over,
    })
    .run();
}

const ex = (over: Partial<Extraction>): Extraction =>
  ({ payPolicy: null, listedSalaryScope: null, ...over }) as Extraction;
const post = (id = "p1") => ({ id, companyId: "c1" });
const row = () => db.select().from(companies).where(eq(companies.id, "c1")).get();

beforeEach(() => {
  db = openDb(":memory:");
});

describe("pay-policy registry", () => {
  it("first posting stating flat pay sets the policy with its source", () => {
    addCompany();
    expect(payPolicyFor(db, "c1")).toEqual({ policy: "unknown", source: null });
    const reasons = recordPostingPolicy(db, post("p1"), ex({ payPolicy: "location_agnostic" }));
    expect(reasons).toEqual([]);
    expect(row()?.pay_policy).toBe("location_agnostic");
    expect(row()?.pay_policy_source).toBe("posting:p1");
    expect(payPolicyFor(db, "c1")).toEqual({ policy: "location_agnostic", source: "posting:p1" });
  });

  it("stores location_adjusted too, and a later posting does not overwrite it", () => {
    addCompany({ pay_policy: "unknown" });
    recordPostingPolicy(db, post("p1"), ex({ payPolicy: "location_adjusted" }));
    recordPostingPolicy(db, post("p2"), ex({ payPolicy: "location_agnostic" }));
    expect(payPolicyFor(db, "c1")).toEqual({ policy: "location_adjusted", source: "posting:p1" });
  });

  it.each(["manual", "careers:https://example.com/careers"])(
    "never overwrites source %s",
    (source) => {
      addCompany({ pay_policy: "location_adjusted", pay_policy_source: source });
      recordPostingPolicy(db, post(), ex({ payPolicy: "location_agnostic" }));
      expect(payPolicyFor(db, "c1")).toEqual({ policy: "location_adjusted", source });
    },
  );

  it("never overwrites a protected source even when its policy is unknown", () => {
    addCompany({ pay_policy: "unknown", pay_policy_source: "careers:https://example.com/careers" });
    recordPostingPolicy(db, post(), ex({ payPolicy: "location_agnostic" }));
    expect(row()?.pay_policy).toBe("unknown");
  });

  it("a US legal-note range does not set location_agnostic", () => {
    addCompany();
    const reasons = recordPostingPolicy(
      db,
      post(),
      ex({ payPolicy: "location_agnostic", listedSalaryScope: "us_only_or_legal_note" }),
    );
    expect(payPolicyFor(db, "c1").policy).toBe("unknown");
    expect(row()?.pay_policy_source).toBeNull();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/US pay-transparency/);
  });

  it("records a conflict as a reason line without overwriting", () => {
    addCompany({ pay_policy: "location_agnostic", pay_policy_source: "manual" });
    const reasons = recordPostingPolicy(db, post("p9"), ex({ payPolicy: "location_adjusted" }));
    expect(reasons).toEqual([
      "pay policy conflict: posting says location_adjusted, registry keeps location_agnostic (source manual)",
    ]);
    expect(row()?.pay_policy).toBe("location_agnostic");
  });

  it("agreeing posting adds no reason; posting without a policy or company does nothing", () => {
    addCompany({ pay_policy: "location_agnostic", pay_policy_source: "posting:p1" });
    expect(recordPostingPolicy(db, post(), ex({ payPolicy: "location_agnostic" }))).toEqual([]);
    expect(recordPostingPolicy(db, post(), ex({ payPolicy: null }))).toEqual([]);
    expect(
      recordPostingPolicy(db, { id: "p", companyId: null }, ex({ payPolicy: "location_adjusted" })),
    ).toEqual([]);
    expect(payPolicyFor(db, null)).toEqual({ policy: "unknown", source: null });
  });
});
