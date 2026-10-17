import { eq } from "drizzle-orm";
import {
  answer_bank,
  choice_mappings,
  intel,
  openDb,
  postings,
  reviews,
  unknown_questions,
  type Db,
} from "@job-agent/core";
import { beforeEach, describe, expect, it } from "vitest";
import { mappingId } from "./choice-coverage.ts";
import { loadFillContext, recordUncoveredLabels } from "./fill-plan-db.ts";
import { planFill, type FormField } from "./fill-plan.ts";
import { optionsHash } from "./dry-runs-store.ts";
import { normalizeQuestion } from "./match.ts";

let db: Db;
const T = "2026-10-13T00:00:00.000Z";

beforeEach(() => {
  db = openDb(":memory:");
  db.insert(postings)
    .values({
      id: "p1",
      source: "greenhouse",
      external_id: "p1",
      url: "https://example.test/jobs/p1",
      title: "Engineer",
      company_name: "Acme",
      first_seen_at: T,
      last_seen_at: T,
      normalized_at: T,
    })
    .run();
});

const field = (label: string, field_type = "text", options: string[] | null = null): FormField => ({
  label,
  field_type,
  required: true,
  options,
  ats: { type: "greenhouse", id: label },
});

function addAnswer(key: string, question: string, answer: string, approved = true) {
  db.insert(answer_bank)
    .values({
      id: key,
      key,
      group: key.split(".")[0] ?? "g",
      question,
      answer,
      approved,
      source: "config",
      updated_at: T,
    })
    .run();
}

function addIntel(over: Partial<typeof intel.$inferInsert> = {}) {
  db.insert(intel)
    .values({ id: "i1", posting_id: "p1", status: "done", updated_at: T, ...over })
    .run();
}

function addReview(id: string, action: "scam" | "not_scam", at: string) {
  db.insert(reviews)
    .values({ id, posting_id: "p1", action, reviewed_at: at, review_day: at.slice(0, 10) })
    .run();
}

describe("loadFillContext", () => {
  it("reads answers, approved mappings and the tier ask; the plan fills from them", () => {
    addAnswer("contact.email", "Email", "jane.doe@example.test");
    addAnswer("experience.years_nodejs_backend", "Which tools do you use?", "Git", true);
    addAnswer("pay.old", "Old pay", "1", false);
    addIntel({ ask_idr_month: 30_000_000, ask_usd_year: 24_000, ask_text: "around 30M IDR" });
    const options = ["Git", "Docker"];
    db.insert(choice_mappings)
      .values({
        id: "m1",
        answer_key: "experience.years_nodejs_backend",
        normalized_label: normalizeQuestion("Which tools do you use?"),
        options_hash: optionsHash(options),
        options: JSON.stringify(options),
        chosen: JSON.stringify(["Docker"]),
        approved: true,
        updated_at: T,
      })
      .run();
    // An unapproved mapping is not loaded.
    db.insert(choice_mappings)
      .values({
        id: "m2",
        answer_key: "experience.years_nodejs_backend",
        normalized_label: "other",
        options_hash: "h",
        options: "[]",
        chosen: "[]",
        approved: false,
        updated_at: T,
      })
      .run();
    const ctx = loadFillContext(db, "p1");
    expect(ctx.scamFlagged).toBe(false);
    expect(ctx.ask).toEqual({
      askIdrMonth: 30_000_000,
      askUsdYear: 24_000,
      askText: "around 30M IDR",
    });
    expect(ctx.choiceMappings.size).toBe(1);
    expect(
      ctx.choiceMappings.get(
        mappingId("experience.years_nodejs_backend", "Which tools do you use?", options),
      ),
    ).toEqual(["Docker"]);
    const plan = planFill({
      ...ctx,
      fields: [
        field("Email"),
        field("Which tools do you use?", "multi_choice", options),
        field("Salary", "number"),
      ],
    });
    expect(plan).toMatchObject({ kind: "fill", status: "filled" });
  });

  it("no intel row or no ask -> ask null", () => {
    expect(loadFillContext(db, "p1").ask).toBeNull();
    addIntel({ ask_text: "text only" });
    expect(loadFillContext(db, "p1").ask).toBeNull();
  });

  it("scam: intel suspicious or newest scam/not_scam review is scam", () => {
    expect(loadFillContext(db, "p1").scamFlagged).toBe(false);
    addReview("r1", "scam", "2026-10-13T01:00:00.000Z");
    expect(loadFillContext(db, "p1").scamFlagged).toBe(true);
    addReview("r2", "not_scam", "2026-10-13T02:00:00.000Z");
    expect(loadFillContext(db, "p1").scamFlagged).toBe(false);
    addReview("r3", "scam", "2026-10-13T03:00:00.000Z");
    expect(loadFillContext(db, "p1").scamFlagged).toBe(true);
  });

  it("intel suspicious stays flagged even after not_scam", () => {
    addIntel({ final_decision: "suspicious" });
    addReview("r1", "not_scam", "2026-10-13T02:00:00.000Z");
    expect(loadFillContext(db, "p1").scamFlagged).toBe(true);
    expect(db.select().from(intel).where(eq(intel.posting_id, "p1")).get()?.final_decision).toBe(
      "suspicious",
    );
  });
});

describe("recordUncoveredLabels", () => {
  const planOf = () =>
    planFill({
      ...loadFillContext(db, "p1"),
      fields: [
        field("Favourite colour?"),
        field("Favourite colour"),
        field("Email"),
        field("Expected salary", "number"),
      ],
    });

  it("upserts only unmatched labels, once per wording, status untouched", () => {
    const plan = planOf();
    expect(recordUncoveredLabels(db, plan, new Date(T))).toBe(1);
    const rows = db.select().from(unknown_questions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      normalized_label: "favourite colour",
      label: "Favourite colour?",
      status: "open",
      posting_count: 1,
      first_seen_at: T,
    });
    // Second call: no new row, last seen moves forward, a decided status stays.
    db.update(unknown_questions).set({ status: "dismissed" }).run();
    expect(recordUncoveredLabels(db, plan, new Date("2026-10-14T00:00:00.000Z"))).toBe(0);
    const again = db.select().from(unknown_questions).all();
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({
      status: "dismissed",
      first_seen_at: T,
      last_seen_at: "2026-10-14T00:00:00.000Z",
    });
  });

  it("a stop plan records nothing", () => {
    const stop = planFill({ ...loadFillContext(db, "p1"), fields: [field("Sign", "signature")] });
    expect(recordUncoveredLabels(db, stop)).toBe(0);
    expect(db.select().from(unknown_questions).all()).toHaveLength(0);
  });
});
