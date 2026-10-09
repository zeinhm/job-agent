import { eq } from "drizzle-orm";
import { companies, openDb, type AppConfig, type Db } from "@job-agent/core";
import { beforeEach, describe, expect, it } from "vitest";
import { loadPollableCompanies, syncConfigCompanies } from "./companies.ts";

const NOW = new Date("2026-10-08T00:00:00Z");
const config = {
  companies: [
    { name: "Acme Inc", ats: "greenhouse", slug: "acme" },
    { name: "Globex", ats: "lever", slug: "globex" },
  ],
} as AppConfig;

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

const insert = (name: string, over: Partial<typeof companies.$inferInsert> = {}) =>
  db
    .insert(companies)
    .values({
      id: `id-${name}`,
      name,
      normalized_name: name.toLowerCase(),
      created_at: NOW.toISOString(),
      ...over,
    })
    .run();

describe("syncConfigCompanies", () => {
  it("upserts config companies as verified with discovered_via = config", () => {
    syncConfigCompanies(db, config, () => NOW);
    syncConfigCompanies(db, config, () => NOW);
    const rows = db.select().from(companies).all();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.discovered_via === "config" && r.verified === true)).toBe(true);
    expect(rows.find((r) => r.normalized_name === "acme")).toMatchObject({
      ats_type: "greenhouse",
      ats_slug: "acme",
    });
  });

  it("overrides a stored ats/slug for the same company (config wins)", () => {
    insert("Acme", {
      ats_type: "lever",
      ats_slug: "old",
      discovered_via: "search",
      verified: false,
    });
    syncConfigCompanies(db, config, () => NOW);
    const row = db.select().from(companies).where(eq(companies.normalized_name, "acme")).get();
    expect(row).toMatchObject({ ats_type: "greenhouse", ats_slug: "acme", verified: true });
    expect(row?.discovered_via).toBe("config");
  });
});

describe("loadPollableCompanies", () => {
  it("returns only verified companies with ats and slug", () => {
    insert("good", { ats_type: "ashby", ats_slug: "good", verified: true });
    insert("unverified", { ats_type: "ashby", ats_slug: "u", verified: false });
    insert("noats", { verified: true });
    expect(loadPollableCompanies(db).map((c) => c.ats_slug)).toEqual(["good"]);
  });
});
