import { eq } from "drizzle-orm";
import {
  analysis,
  companies,
  fx_rates,
  intel,
  llm_calls,
  openDb,
  postings,
  reviews,
  type Db,
  type SalaryConfig,
} from "@job-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeTier } from "../enrich.ts";
import { ExtractionSchema, type Extraction } from "../intel/extract.ts";
import { recordPostingPolicy } from "../intel/registry.ts";
import { runReprocess } from "../reprocess.ts";
import { recordReview, ReviewRejectedError, type ReviewInput } from "./record.ts";

const NOW = new Date("2026-10-07T03:00:00Z");
const OWNER_SOURCE = "owner:2026-10-07";
const IDR_PER_USD = 16_000;

// Fake numbers; the indonesia ask sits under the floor on purpose (floor case).
const SALARY: SalaryConfig = {
  floor_idr_month: 10_000_000,
  position_in_listed_range: 0.5,
  tiers: {
    indonesia: { ask_idr_month: 8_000_000 },
    regional: { ask_idr_month: 20_000_000 },
    global_adjusted: { ask_idr_month: 30_000_000 },
    global_flat: { ask_usd_year: 60_000 },
  },
  unknown_policy: "ask",
  text_field_answer: "negotiable",
  review_salary_answers: true,
};

const BASE: Extraction = ExtractionSchema.parse({
  listedSalary: null,
  listedSalaryScope: null,
  hiringScope: null,
  regions: [],
  remoteRegions: [],
  allowedCountries: [],
  indonesiaExplicit: null,
  companyHq: null,
  companyType: null,
  payPolicy: null,
  employment: null,
  eorProvider: null,
  seniority: null,
  roleFamily: null,
  contactChannels: [],
  personalEmailDomain: null,
  asksForPaymentOrId: null,
  repoAssessmentEarly: null,
  urgencyLanguage: null,
  vagueDescription: null,
});

let db: Db;
let n = 0;

function addCompany(id: string, over: Partial<typeof companies.$inferInsert> = {}) {
  db.insert(companies)
    .values({
      id,
      name: `Company ${id}`,
      normalized_name: `company ${id}`,
      pay_policy: "unknown",
      created_at: "2026-10-01T00:00:00Z",
      ...over,
    })
    .run();
}

/** A posting with an intel row that still carries the old (unknown-policy) tier and ask. */
function addPosting(
  id: string,
  companyId: string | null,
  x: Partial<Extraction> = {},
  over: Partial<typeof intel.$inferInsert> = {},
) {
  n += 1;
  const at = new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString();
  db.insert(postings)
    .values({
      id,
      source: "test",
      external_id: id,
      url: `https://example.com/${id}`,
      title: "Senior Frontend Engineer",
      company_name: `Company ${companyId ?? "none"}`,
      company_id: companyId,
      location_text: "Worldwide",
      remote: true,
      description_text: "Build things with React.",
      first_seen_at: at,
      last_seen_at: at,
      normalized_at: NOW.toISOString(),
    })
    .run();
  db.insert(analysis)
    .values({
      id: `a-${id}`,
      posting_id: id,
      location_class: "worldwide",
      indonesia_rule: "not_applicable",
      salary_status: "unknown",
      decision: "keep",
      flags: "[]",
      reasons: "[]",
      analyzed_at: "2026-10-02T00:00:00.000Z",
    })
    .run();
  db.insert(intel)
    .values({
      id: `i-${id}`,
      posting_id: id,
      status: "done",
      extraction: JSON.stringify({ ...BASE, ...x }),
      final_decision: "keep",
      resolved_reasons: "[]",
      tier: "regional",
      ask_idr_month: 20_000_000,
      ask_usd_year: 15_000,
      ask_text: "negotiable",
      ask_reason: "old",
      scam_score: 5,
      fit_score: 80,
      updated_at: "2026-10-02T00:00:00.000Z",
      ...over,
    })
    .run();
}

const intelOf = (id: string) => db.select().from(intel).where(eq(intel.posting_id, id)).get();
const companyOf = (id: string) => db.select().from(companies).where(eq(companies.id, id)).get();
const ask = (id: string) => {
  const r = intelOf(id);
  return { tier: r?.tier, ask_idr_month: r?.ask_idr_month, ask_usd_year: r?.ask_usd_year };
};
const mark = (
  postingId: string,
  pay_policy: "location_agnostic" | "location_adjusted",
  salary = SALARY,
) =>
  recordReview(
    db,
    { posting_id: postingId, action: "pay_policy", pay_policy } as ReviewInput,
    NOW,
    {
      salary: () => salary,
    },
  );

const US_NOTE = {
  listedSalary: { min: 100_000, max: 150_000, currency: "USD", period: "year" },
  listedSalaryScope: "us_only_or_legal_note",
} as const;
const LISTED = {
  listedSalary: { min: 3_000, max: 5_000, currency: "USD", period: "month" },
  listedSalaryScope: null,
} as const;

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  db = openDb(":memory:");
  n = 0;
  db.insert(fx_rates)
    .values({
      id: "fx1",
      date: "2026-10-07",
      base: "USD",
      quote: "IDR",
      rate: String(IDR_PER_USD),
      source: "test",
      fetched_at: NOW.toISOString(),
    })
    .run();
  fetchSpy = vi.fn(() => Promise.reject(new Error("network call")));
  vi.stubGlobal("fetch", fetchSpy);
  addCompany("c1");
  addCompany("c2");
  // c1: two postings that need a number, one listed range, one US legal note, one floor case, one rejected row.
  addPosting("p-plain", "c1");
  addPosting("p-listed", "c1", LISTED);
  addPosting("p-us", "c1", US_NOTE);
  addPosting("p-id", "c1", { allowedCountries: ["ID"] });
  addPosting("p-rejected", "c1", {}, { final_decision: "reject" });
  addPosting("p-other", "c2");
});
afterEach(() => vi.unstubAllGlobals());

describe("owner pay-policy mark", () => {
  it("location_agnostic: sets the registry, recomputes every kept row of the company", () => {
    const before = ask("p-plain");
    expect(before).toEqual({ tier: "regional", ask_idr_month: 20_000_000, ask_usd_year: 15_000 });

    expect(mark("p-plain", "location_agnostic")?.review.action).toBe("pay_policy");

    expect(companyOf("c1")).toMatchObject({
      pay_policy: "location_agnostic",
      pay_policy_source: OWNER_SOURCE,
      pay_policy_checked_at: NOW.toISOString(),
    });
    // 60000 USD / 12 x 16000 = 80,000,000 IDR
    expect(ask("p-plain")).toEqual({
      tier: "global_flat",
      ask_idr_month: 80_000_000,
      ask_usd_year: 60_000,
    });
    // Listed 3000-5000 USD/month = 48M-80M IDR, position 0.5 -> 64M.
    expect(ask("p-listed")).toEqual({
      tier: "global_flat",
      ask_idr_month: 64_000_000,
      ask_usd_year: 48_000,
    });
    expect(intelOf("p-plain")?.ask_reason).toContain("pay policy from owner 2026-10-07");
    expect(intelOf("p-plain")?.updated_at).toBe(NOW.toISOString());
    // The review row snapshots what the tool said before the mark.
    expect(db.select().from(reviews).get()).toMatchObject({
      tier: "regional",
      pay_policy: "location_agnostic",
    });
  });

  it("location_adjusted: tier comes from the extraction, not the flat ask", () => {
    mark("p-listed", "location_adjusted");
    expect(companyOf("c1")?.pay_policy).toBe("location_adjusted");
    // No listed-agnostic shortcut: a listed range alone does not make the ask flat.
    expect(ask("p-listed")).toEqual({
      tier: "global_adjusted",
      ask_idr_month: 30_000_000,
      ask_usd_year: 22_500,
    });
    expect(intelOf("p-listed")?.ask_reason).toContain("branch=adjusted");
    expect(intelOf("p-listed")?.ask_reason).toContain("pay policy from owner 2026-10-07");
  });

  it("a US legal-note range still takes the unknown path, whatever the owner says", () => {
    mark("p-us", "location_agnostic");
    expect(ask("p-us")).toEqual({
      tier: "regional",
      ask_idr_month: 20_000_000,
      ask_usd_year: 15_000,
    });
    expect(intelOf("p-us")?.ask_reason).toContain("branch=us_legal_note_unknown");
    expect(intelOf("p-us")?.ask_text).toBe("negotiable");
  });

  it("the floor always applies", () => {
    mark("p-id", "location_adjusted");
    // indonesia ask 8M is under the 10M floor
    expect(ask("p-id")).toEqual({
      tier: "indonesia",
      ask_idr_month: 10_000_000,
      ask_usd_year: 7_500,
    });
    expect(intelOf("p-id")?.ask_reason).toContain("raised to floor");

    const high = { ...SALARY, floor_idr_month: 90_000_000 };
    mark("p-plain", "location_agnostic", high);
    expect(intelOf("p-plain")?.ask_idr_month).toBe(90_000_000);
  });

  it("leaves rejected rows and other companies alone", () => {
    const rejected = intelOf("p-rejected");
    const other = intelOf("p-other");
    mark("p-plain", "location_agnostic");
    expect(intelOf("p-rejected")).toEqual(rejected);
    expect(intelOf("p-other")).toEqual(other);
    expect(companyOf("c2")?.pay_policy).toBe("unknown");
  });

  it("makes no network or LLM call", () => {
    mark("p-plain", "location_agnostic");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.select().from(llm_calls).all()).toHaveLength(0);
  });

  it("works through a duplicate posting id (canonical posting's company)", () => {
    addPosting("p-dup", null);
    db.update(postings)
      .set({ canonical_posting_id: "p-plain" })
      .where(eq(postings.id, "p-dup"))
      .run();
    mark("p-dup", "location_agnostic");
    expect(companyOf("c1")?.pay_policy).toBe("location_agnostic");
  });

  it("rejects a posting without a company row and stores nothing", () => {
    addPosting("p-nocompany", null);
    expect(() => mark("p-nocompany", "location_agnostic")).toThrow(ReviewRejectedError);
    expect(db.select().from(reviews).all()).toHaveLength(0);
  });

  it("another mark replaces the earlier owner mark and recomputes again", () => {
    mark("p-plain", "location_agnostic");
    mark("p-plain", "location_adjusted");
    expect(companyOf("c1")?.pay_policy).toBe("location_adjusted");
    expect(ask("p-plain").tier).toBe("global_adjusted");
  });
});

describe("the owner policy survives later runs", () => {
  it("a posting that states the opposite policy does not overwrite it and does not change the tier", () => {
    mark("p-plain", "location_agnostic");
    const stored = ask("p-plain");
    const reasons = recordPostingPolicy(
      db,
      { id: "p-new", companyId: "c1" },
      { ...BASE, payPolicy: "location_adjusted" },
    );
    expect(reasons.join(" ")).toContain("pay policy conflict");
    expect(companyOf("c1")).toMatchObject({
      pay_policy: "location_agnostic",
      pay_policy_source: OWNER_SOURCE,
    });
    const row = intelOf("p-plain");
    const posting = db.select().from(postings).where(eq(postings.id, "p-plain")).get();
    if (posting === undefined) throw new Error("seed missing");
    const recomputed = computeTier(db, posting, row?.extraction as string, SALARY, NOW);
    expect(recomputed).toMatchObject({ tier: stored.tier, ask_idr_month: stored.ask_idr_month });
  });

  it("process --reprocess keeps the owner policy and the stored ask", () => {
    mark("p-plain", "location_agnostic");
    const flat = ask("p-plain");
    expect(flat.tier).toBe("global_flat");
    // Make the stored ask stale: reprocess must bring it back through the owner policy, not the unknown path.
    db.update(intel)
      .set({ tier: "regional", ask_idr_month: 20_000_000, ask_usd_year: 15_000 })
      .where(eq(intel.posting_id, "p-plain"))
      .run();
    const out: string[] = [];
    const code = runReprocess({
      db,
      salary: SALARY,
      floorIdrMonth: SALARY.floor_idr_month,
      now: () => NOW,
      out: (t) => out.push(t),
      err: () => {},
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("reprocessed 6 postings");
    expect(companyOf("c1")).toMatchObject({
      pay_policy: "location_agnostic",
      pay_policy_source: OWNER_SOURCE,
    });
    expect(ask("p-plain")).toEqual(flat);
    expect(ask("p-listed").tier).toBe("global_flat");
    expect(ask("p-us").tier).toBe("regional");
  });
});
