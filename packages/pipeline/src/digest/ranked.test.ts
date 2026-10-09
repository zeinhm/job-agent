import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analysis, intel, llm_calls, openDb, postings, type Db } from "@job-agent/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDigest } from "./index.ts";

const NOW = new Date("2026-10-07T03:00:00Z");
const DATE = "2026-10-07";

let db: Db;
let dir: string;

interface Seed {
  title: string;
  flags?: string[];
  posted?: string;
  max?: number | null;
  intel?: Partial<typeof intel.$inferInsert> | null;
}

/** Fake persona data only. */
function seed(id: string, o: Seed) {
  db.insert(postings)
    .values({
      id,
      source: "remotive",
      external_id: `e-${id}`,
      url: `https://example.com/jobs/${id}`,
      title: o.title,
      company_name: `Company ${id}`,
      location_text: "Worldwide",
      posted_at: o.posted ?? "2026-10-05T00:00:00Z",
      first_seen_at: NOW.toISOString(),
      last_seen_at: NOW.toISOString(),
    })
    .run();
  db.insert(analysis)
    .values({
      id: `a-${id}`,
      posting_id: id,
      location_class: "worldwide",
      indonesia_rule: "not_applicable",
      salary_status: "listed",
      salary_idr_month_min: 20_000_000,
      salary_idr_month_max: o.max === undefined ? 30_000_000 : o.max,
      decision: "keep",
      flags: JSON.stringify(o.flags ?? []),
      reasons: "[]",
      analyzed_at: "2026-10-07T01:00:00Z",
    })
    .run();
  if (o.intel === null) return;
  db.insert(intel)
    .values({
      id: `i-${id}`,
      posting_id: id,
      status: "done",
      final_decision: "keep",
      scam_score: 0,
      scam_reasons: "[]",
      fit_score: 75,
      fit_reasons: JSON.stringify(["Strong React and TypeScript match"]),
      tier: "regional",
      ask_idr_month: 35_000_000,
      ask_usd_year: null,
      ask_text: null,
      updated_at: "2026-10-07T02:00:00Z",
      ...o.intel,
    })
    .run();
}

function call(id: string, model: string, cost: string, status: "ok" | "error" = "ok", day = DATE) {
  db.insert(llm_calls)
    .values({
      id,
      day,
      model,
      purpose: model.includes("haiku") ? "extract" : "fit",
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_tokens: 0,
      cost_usd: cost,
      status,
      created_at: NOW.toISOString(),
    })
    .run();
}

function run(capUsd = 1): string {
  const path = runDigest({ db, outDir: dir, now: () => NOW, capUsd, out: () => {} });
  return readFileSync(path, "utf8");
}

const sectionOf = (text: string, name: string) => {
  const start = text.indexOf(`## ${name}`);
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next === -1 ? undefined : next);
};

beforeEach(() => {
  db = openDb(":memory:");
  dir = mkdtempSync(join(tmpdir(), "ranked-digest-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ranked digest", () => {
  it("ranks fit 80 with an unresolved flag below fit 75 with none", () => {
    seed("flagged", {
      title: "Flagged Eighty",
      flags: ["role_unclear"],
      intel: { fit_score: 80 },
    });
    seed("clean", { title: "Clean Seventy-Five", intel: { fit_score: 75 } });
    const top = sectionOf(run(), "Top matches");
    expect(top.indexOf("Clean Seventy-Five")).toBeGreaterThan(-1);
    expect(top.indexOf("Clean Seventy-Five")).toBeLessThan(top.indexOf("Flagged Eighty"));
    expect(top).toContain("(rank 70)");
    expect(top).toContain("role_unclear still open (-10)");
  });

  it("adds the salary bonus only when the listed max reaches the ask", () => {
    seed("covers", {
      title: "Covers Ask",
      max: 30_000_000,
      intel: { fit_score: 70, ask_idr_month: 28_000_000 },
    });
    seed("short", { title: "Short Of Ask", max: 25_000_000, intel: { fit_score: 70 } });
    seed("nomax", { title: "No Max", max: null, intel: { fit_score: 70 } });
    const top = sectionOf(run(), "Top matches");
    const entry = (t: string) => top.slice(top.indexOf(`### ${t}`)).split("\n### ")[0] ?? "";
    expect(entry("Covers Ask")).toContain("(rank 75)");
    expect(entry("Covers Ask")).toContain("listed max covers the ask (+5)");
    expect(entry("Short Of Ask")).toContain("(rank 70)");
    expect(entry("Short Of Ask")).not.toContain("covers the ask");
    expect(entry("No Max")).toContain("(rank 70)");
  });

  it("settles unclear flags from the extraction instead of penalizing them", () => {
    const extraction = {
      listedSalary: null,
      listedSalaryScope: null,
      hiringScope: "worldwide",
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
    };
    seed("settled", {
      title: "Settled Location",
      flags: ["location_unclear"],
      intel: { fit_score: 80, extraction: JSON.stringify(extraction) },
    });
    const text = run();
    expect(sectionOf(text, "Top matches")).toContain("(rank 80)");
    expect(sectionOf(text, "Needs a look")).not.toContain("Settled Location");
  });

  it("gives every top match fit score, reasons, tier and ask, and a why line", () => {
    seed("t1", {
      title: "Senior Frontend Engineer",
      max: 30_000_000,
      intel: {
        fit_score: 82,
        fit_reasons: JSON.stringify(["React and TypeScript lead roles", "Next.js in the stack"]),
        tier: "global_adjusted",
        ask_idr_month: 28_000_000,
        ask_usd_year: 21_000,
        scam_score: 15,
        scam_reasons: JSON.stringify(["Recruiter uses a free email domain"]),
      },
    });
    const top = sectionOf(run(), "Top matches");
    expect(top).toContain("### Senior Frontend Engineer — Company t1");
    expect(top).toContain(
      "- Fit: 82/100 (rank 87) — React and TypeScript lead roles; Next.js in the stack",
    );
    expect(top).toContain("- Tier / ask: global_adjusted — IDR 28.0M / month | USD 21,000 / year");
    expect(top).toContain("- Scam score: 15 — Recruiter uses a free email domain");
    expect(top).toContain("- Salary: IDR 20.0M–30.0M / month");
    expect(top).toContain("- Link: https://example.com/jobs/t1");
    const why = top.split("\n").find((l) => l.startsWith("- Why: "));
    expect(why).toBe(
      "- Why: fit 82 — React and TypeScript lead roles; Next.js in the stack — tier global_adjusted, ask IDR 28.0M / month | USD 21,000 / year — listed max covers the ask (+5) — scam score 15",
    );
  });

  it("shows the role reason resolved from facts in the Why line", () => {
    seed("res", {
      title: "Resolved Role",
      intel: {
        fit_score: 70,
        resolved_reasons: JSON.stringify([
          "Location: the posting hires worldwide.",
          "Role: engineering role at senior level.",
        ]),
      },
    });
    const top = sectionOf(run(), "Top matches");
    const why = top.split("\n").find((l) => l.startsWith("- Why: "));
    expect(why).toContain("Role: engineering role at senior level");
    expect(why).not.toContain("matches the target");
    expect(why).not.toContain("worldwide");
  });

  it("shows the ask text when the policy is unknown", () => {
    seed("txt", {
      title: "Text Ask",
      intel: { tier: null, ask_idr_month: null, ask_text: "Open to discussion" },
    });
    expect(sectionOf(run(), "Top matches")).toContain(
      "- Tier / ask: no tier — text answer: Open to discussion",
    );
  });

  it("lists suspicious postings only under Suspicious with score and top reasons", () => {
    seed("s1", {
      title: "Too Good Role",
      intel: {
        final_decision: "suspicious",
        scam_score: 85,
        scam_reasons: JSON.stringify(["asks for payment", "telegram only", "urgent", "fourth"]),
        fit_score: null,
      },
    });
    const text = run();
    const sus = sectionOf(text, "Suspicious");
    expect(sus).toContain("### Too Good Role — Company s1");
    expect(sus).toContain("- Scam score: 85");
    expect(sus).toContain("- Reason: asks for payment");
    expect(sus).toContain("- Reason: urgent");
    expect(sus).not.toContain("fourth");
    expect(text.split("Too Good Role")).toHaveLength(2);
    expect(sectionOf(text, "Top matches")).not.toContain("Too Good Role");
    expect(sectionOf(text, "Waiting for scoring")).not.toContain("Too Good Role");
  });

  it("lists postings without intel under Waiting for scoring (no key, no intel)", () => {
    seed("n1", { title: "No Intel Yet", intel: null });
    seed("n2", { title: "Budget Wait", intel: { status: "budget_wait", fit_score: null } });
    seed("n3", { title: "Failed One", intel: { status: "failed", fit_score: null } });
    seed("n4", { title: "No Cv", intel: { fit_score: null } });
    const text = run();
    const waiting = sectionOf(text, "Waiting for scoring");
    for (const t of ["No Intel Yet", "Budget Wait", "Failed One", "No Cv"]) {
      expect(waiting).toContain(`### ${t}`);
    }
    expect(waiting).toContain("- Status: not enriched yet");
    expect(waiting).toContain("- Status: waiting for the daily LLM budget");
    expect(waiting).toContain("- Status: no fit score");
    expect(sectionOf(text, "Top matches")).toContain("None scored yet.");
  });

  it("drops postings the resolve stage rejected", () => {
    seed("rj", { title: "Resolved Away", intel: { final_decision: "reject", fit_score: null } });
    expect(run()).not.toContain("Resolved Away");
  });

  it("keeps an unscored posting from an earlier day in the digest and shows it once scored", () => {
    seed("old", {
      title: "Carried Over",
      intel: { status: "budget_wait", fit_score: null, updated_at: "2026-10-06T02:00:00Z" },
    });
    seed("never", { title: "Never Enriched", intel: null });
    db.update(analysis).set({ digested_at: "2026-10-05" }).run();
    const first = run();
    expect(sectionOf(first, "Waiting for scoring")).toContain("Carried Over");
    expect(first).not.toContain("Never Enriched");

    db.update(intel)
      .set({
        status: "done",
        final_decision: "keep",
        fit_score: 66,
        fit_reasons: "[]",
        updated_at: "2026-10-07T02:00:00Z",
      })
      .run();
    const text = run();
    expect(sectionOf(text, "Top matches")).toContain("Carried Over");
    expect(sectionOf(text, "Waiting for scoring")).not.toContain("Carried Over");
  });

  it("shows today's LLM spend against the cap and calls per model", () => {
    call("c1", "claude-haiku-5-5", "0.0100");
    call("c2", "claude-haiku-5-5", "0.0200", "error");
    call("c3", "claude-sonnet-5-5", "0.0500");
    call("c4", "claude-sonnet-5-5", "0.9000", "ok", "2026-10-06");
    const spend = sectionOf(run(), "LLM spend");
    expect(spend).toContain("- 2026-10-07: $0.0800 of $1.00 cap");
    expect(spend).toContain("- claude-haiku-5-5: 2 calls, $0.0300 (1 failed)");
    expect(spend).toContain("- claude-sonnet-5-5: 1 call, $0.0500");
  });

  it("shows zero spend when no calls were made", () => {
    const spend = sectionOf(run(0.5), "LLM spend");
    expect(spend).toContain("- 2026-10-07: $0.0000 of $0.50 cap");
    expect(spend).toContain("- No LLM calls.");
  });

  it("lists every section in order", () => {
    const text = run();
    const order = [
      "## Top matches",
      "## Waiting for scoring",
      "## Needs a look",
      "## Suspicious",
      "## Source health",
      "## LLM spend",
    ].map((h) => text.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("lists a posting waiting for an FX rate under Waiting, never under Top matches", () => {
    seed("w", {
      title: "Waits For Rate",
      intel: { status: "fx_wait", tier: null, ask_idr_month: null },
    });
    seed("legacy", {
      title: "Legacy Skipped",
      intel: {
        tier: null,
        ask_idr_month: null,
        resolved_reasons: JSON.stringify(["tier skipped: no IDR FX rate stored"]),
      },
    });
    const text = run();
    const top = sectionOf(text, "Top matches");
    const waiting = sectionOf(text, "Waiting for scoring");
    expect(top).not.toContain("Waits For Rate");
    expect(top).not.toContain("Legacy Skipped");
    expect(waiting).toContain("Waits For Rate");
    expect(waiting).toContain("Legacy Skipped");
    expect(waiting).toContain("waiting for an FX rate: run fx");
  });
});
