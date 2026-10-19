import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analysis,
  apply_links,
  intel,
  openDb,
  postings,
  source_runs,
  type Db,
} from "@job-agent/core";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../cli.ts";
import { formatSalary, isDigestDate, jakartaDate, runDigest } from "./index.ts";
import { TOP_MATCH_MIN_FIT } from "./rank.ts";

const NOW = new Date("2026-10-07T03:00:00Z");
const DATE = "2026-10-07";

let db: Db;
let dir: string;
let n = 0;

function seed(
  id: string,
  over: {
    source?: string;
    title?: string;
    posted?: string | null;
    decision?: "keep" | "reject";
    flags?: string[];
    reasons?: string[];
    locationClass?: "worldwide" | "apac_ok" | "restricted" | "unclear";
    indonesia?: "not_applicable" | "domestic";
    canonical?: string;
    company?: string;
    location?: string;
    digestedAt?: string | null;
    salaryStatus?: "listed" | "unknown" | "unparsed" | "no_fx";
    min?: number | null;
    max?: number | null;
    analyzedAt?: string;
    applyUrl?: string;
  } = {},
) {
  n += 1;
  db.insert(postings)
    .values({
      id,
      source: over.source ?? "remotive",
      external_id: `e${n}`,
      url: `https://example.com/jobs/${id}`,
      apply_url: over.applyUrl ?? null,
      title: over.title ?? `Job ${id}`,
      company_name: over.company ?? "Acme Inc",
      location_text: over.location ?? "Worldwide",
      posted_at: over.posted === undefined ? "2026-10-05T00:00:00Z" : over.posted,
      first_seen_at: NOW.toISOString(),
      last_seen_at: NOW.toISOString(),
      canonical_posting_id: over.canonical ?? null,
    })
    .run();
  if (over.canonical !== undefined) return;
  db.insert(analysis)
    .values({
      id: `a-${id}`,
      posting_id: id,
      location_class: over.locationClass ?? "worldwide",
      indonesia_rule: over.indonesia ?? "not_applicable",
      salary_status: over.salaryStatus ?? "listed",
      salary_idr_month_min: over.min === undefined ? 25_000_000 : over.min,
      salary_idr_month_max: over.max === undefined ? 30_000_000 : over.max,
      decision: over.decision ?? "keep",
      flags: JSON.stringify(over.flags ?? []),
      reasons: JSON.stringify(over.reasons ?? []),
      analyzed_at: over.analyzedAt ?? "2026-10-07T01:00:00Z",
      digested_at: over.digestedAt ?? null,
    })
    .run();
}

function run(opts: { date?: string; now?: Date; includeUnpaid?: boolean } = {}) {
  const out: string[] = [];
  const path = runDigest({
    db,
    outDir: dir,
    now: () => opts.now ?? NOW,
    ...(opts.date !== undefined ? { date: opts.date } : {}),
    ...(opts.includeUnpaid === true ? { includeUnpaid: true } : {}),
    out: (t) => out.push(t),
  });
  return { path, out: out.join(""), text: readFileSync(path, "utf8") };
}

function run1(
  id: string,
  source: string,
  status: "ok" | "error" | "skipped",
  startedAt: string,
  msg?: string,
  saturated?: number,
) {
  db.insert(source_runs)
    .values({
      id: `r-${id}`,
      source,
      started_at: startedAt,
      finished_at: startedAt,
      status,
      found: 10,
      new: 3,
      error_message: msg ?? null,
      saturated: saturated ?? null,
    })
    .run();
}

function score(id: string, over: Partial<typeof intel.$inferInsert> = {}) {
  db.insert(intel)
    .values({
      id: `i-${id}`,
      posting_id: id,
      status: "done",
      final_decision: "keep",
      scam_score: 0,
      scam_reasons: "[]",
      fit_score: 80,
      fit_reasons: JSON.stringify(["Strong TypeScript match"]),
      tier: "regional",
      ask_idr_month: 35_000_000,
      updated_at: "2026-10-07T02:00:00Z",
      ...over,
    })
    .run();
}

function seedDay() {
  seed("m1", { title: "Older Match", posted: "2026-10-01T00:00:00Z" });
  seed("m2", { title: "Newest Match", posted: "2026-10-06T00:00:00Z" });
  seed("m3", { title: "Undated Match", posted: null });
  seed("f1", {
    title: "Old Flagged",
    flags: ["salary_unknown"],
    salaryStatus: "unknown",
    posted: "2026-10-02T00:00:00Z",
  });
  seed("f2", {
    title: "New Flagged",
    flags: ["location_unclear"],
    locationClass: "unclear",
    posted: "2026-10-06T00:00:00Z",
  });
  seed("r1", { decision: "reject", locationClass: "restricted", reasons: ["location: us only"] });
  seed("r2", {
    decision: "reject",
    reasons: ["location: ok", "salary: max below floor"],
  });
  seed("d1", { source: "himalayas", canonical: "m2" });
  seed("d2", { source: "hn", canonical: "m2" });
}

beforeEach(() => {
  db = openDb(":memory:");
  dir = mkdtempSync(join(tmpdir(), "digest-test-"));
  n = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("formatSalary", () => {
  const base = { status: "listed", idrMonthMin: null, idrMonthMax: null } as const;
  it("formats a range", () => {
    expect(formatSalary({ ...base, idrMonthMin: 25_000_000, idrMonthMax: 30_000_000 })).toBe(
      "IDR 25.0M–30.0M / month",
    );
  });
  it("formats min only", () => {
    expect(formatSalary({ ...base, idrMonthMin: 25_000_000 })).toBe("from IDR 25.0M / month");
  });
  it("formats max only", () => {
    expect(formatSalary({ ...base, idrMonthMax: 30_000_000 })).toBe("up to IDR 30.0M / month");
  });
  it("rounds to one decimal", () => {
    expect(formatSalary({ ...base, idrMonthMin: 24_960_000, idrMonthMax: 30_040_000 })).toBe(
      "IDR 25.0M–30.0M / month",
    );
  });
  it("formats non-listed statuses", () => {
    expect(formatSalary({ ...base, status: "unknown" })).toBe("salary unknown");
    expect(formatSalary({ ...base, status: "unparsed" })).toBe("salary not parsed");
    expect(formatSalary({ ...base, status: "no_fx" })).toBe("no FX rate");
  });
});

describe("dates", () => {
  it("uses Asia/Jakarta for the default date", () => {
    expect(jakartaDate(new Date("2026-10-06T18:00:00Z"))).toBe("2026-10-07");
    expect(jakartaDate(new Date("2026-10-06T16:00:00Z"))).toBe("2026-10-06");
  });
  it("validates the date", () => {
    expect(isDigestDate("2026-10-07")).toBe(true);
    expect(isDigestDate("2026-02-30")).toBe(false);
    expect(isDigestDate("10/07/2026")).toBe(false);
  });
});

describe("runDigest", () => {
  it("lists matches and needs-a-look in order, duplicates only as extra sources", () => {
    seedDay();
    const { text, path, out } = run();
    expect(path).toBe(join(dir, `${DATE}.md`));
    expect(out).toBe(`${path}\n`);

    // No intel yet: every kept posting is listed under Waiting for scoring, newest first.
    const waiting = text.slice(
      text.indexOf("## Waiting for scoring"),
      text.indexOf("## Needs a look"),
    );
    const looks = text.slice(text.indexOf("## Needs a look"), text.indexOf("## Suspicious"));
    expect(waiting.match(/^- .+ — .+ — .+ — https:\/\/\S+$/gm)).toHaveLength(5);
    expect(waiting).not.toContain("###");
    expect(waiting.indexOf("Newest Match")).toBeLessThan(waiting.indexOf("Older Match"));
    expect(waiting.indexOf("Older Match")).toBeLessThan(waiting.indexOf("Undated Match"));
    expect(looks).toContain("- New Flagged — Acme Inc: location_unclear");
    expect(looks).not.toContain("Old Flagged");

    // Duplicates are not separate entries.
    expect(text).not.toContain("Job d1");
    expect(text).toContain("- Kept: 5");
    expect(text).toContain("- Waiting for scoring: 5");
    expect(text).toContain(
      "- Rejected in the last 24h: 2 (location 1, indonesia 0, role 0, salary 1, language 0, unpaid 0)",
    );
    expect(text).not.toContain("Job r1");
  });

  it("shows role_unclear postings under Needs a look and counts role rejects", () => {
    seed("ok", { title: "Senior Frontend Engineer" });
    seed("gen", { title: "Staff Engineer", flags: ["role_unclear"] });
    seed("sales", {
      title: "Sales Manager",
      decision: "reject",
      reasons: ["role: non-engineering"],
    });
    const { text } = run();
    const looks = text.slice(text.indexOf("## Needs a look"), text.indexOf("## Suspicious"));
    expect(looks).toContain("- Staff Engineer — Acme Inc: role_unclear");
    expect(text).toContain(
      "- Rejected in the last 24h: 1 (location 0, indonesia 0, role 1, salary 0, language 0, unpaid 0)",
    );
  });

  it("counts unpaid resolve rejects in the rejected line and keeps them out of the sections", () => {
    seed("ok", { title: "Senior Frontend Engineer" });
    seed("vol", { title: "AI Full Stack Engineer (Volunteer, unpaid)" });
    seed("old", { title: "Old Unpaid Role" });
    const row = (id: string, updated: string) =>
      db
        .insert(intel)
        .values({
          id: `i-${id}`,
          posting_id: id,
          status: "done",
          final_decision: "reject",
          resolved_reasons: JSON.stringify(["unpaid"]),
          updated_at: updated,
        })
        .run();
    row("vol", NOW.toISOString());
    row("old", "2026-10-01T00:00:00Z");
    const { text } = run();
    expect(text).toContain(
      "- Rejected in the last 24h: 1 (location 0, indonesia 0, role 0, salary 0, language 0, unpaid 1)",
    );
    expect(text).not.toContain("Volunteer");
    expect(text).toContain("Senior Frontend Engineer");
  });

  it("lists unpaid rejects in a Volunteer / unpaid section only with includeUnpaid", () => {
    seed("ok", { title: "Senior Frontend Engineer" });
    seed("vol", { title: "Volunteer Web Developer", company: "Charity Org", location: "Remote" });
    seed("old", { title: "Old Unpaid Role" });
    const row = (id: string, updated: string, payType: string) =>
      db
        .insert(intel)
        .values({
          id: `i-${id}`,
          posting_id: id,
          status: "done",
          final_decision: "reject",
          resolved_reasons: JSON.stringify(["unpaid"]),
          extraction: JSON.stringify({ payType }),
          updated_at: updated,
        })
        .run();
    row("vol", NOW.toISOString(), "equity_only");
    row("old", "2026-10-01T00:00:00Z", "unpaid");
    const without = run().text;
    expect(without).not.toContain("Volunteer / unpaid");
    expect(without).not.toContain("Volunteer Web Developer");
    const text = run({ includeUnpaid: true }).text;
    const section = text.slice(text.indexOf("## Volunteer / unpaid"));
    expect(section).toContain("### Volunteer Web Developer — Charity Org");
    expect(section).toContain("- Pay type: equity_only");
    expect(section).toContain("- Location: Remote");
    expect(section).toContain("- Link: https://example.com/jobs/vol");
    expect(section).toContain("- Posted: 2026-10-05");
    expect(section).not.toContain("Old Unpaid Role");
    expect(text.indexOf("## LLM spend")).toBeLessThan(text.indexOf("## Volunteer / unpaid"));
  });

  it("shows None. in the unpaid section when nothing was rejected as unpaid", () => {
    seed("ok", { title: "Senior Frontend Engineer" });
    expect(run({ includeUnpaid: true }).text).toContain("## Volunteer / unpaid\n\nNone.");
  });

  it("links the apply url for ATS canonicals and the posting url otherwise", () => {
    seed("ats", { source: "greenhouse", applyUrl: "https://apply.example.com/ats" });
    seed("api", { source: "remotive", applyUrl: "https://apply.example.com/api" });
    score("ats");
    score("api");
    const { text } = run();
    expect(text).toContain("- Apply: https://apply.example.com/ats (unknown, not resolved yet)");
    expect(text).toContain("- Apply: https://example.com/jobs/api (unknown, not resolved yet)");
    expect(text).not.toContain("apply.example.com/api");
  });

  it.each(["smartrecruiters", "workable", "recruitee"])(
    "links the ATS apply url for a %s posting",
    (source) => {
      seed("ats", { source, applyUrl: "https://apply.example.com/ats" });
      score("ats");
      expect(run().text).toContain(
        "- Apply: https://apply.example.com/ats (unknown, not resolved yet)",
      );
    },
  );

  it("is idempotent and picks up newly kept postings under the same date", () => {
    seedDay();
    const first = run();
    expect(run().text).toBe(first.text);

    seed("late", { title: "Late Match" });
    const second = run();
    expect(second.text).toContain("- Late Match — Acme Inc — ");
    expect(second.text).toContain("- Newest Match — Acme Inc — ");
    expect(
      db.select().from(analysis).where(eq(analysis.posting_id, "late")).get()?.digested_at,
    ).toBe(DATE);
    expect(run().text).toBe(second.text);
  });

  it("groups same company + title across locations into one entry and stamps all", () => {
    seed("g1", { title: "Backend Engineer", location: "Berlin", posted: "2026-10-03T00:00:00Z" });
    seed("g2", {
      title: "Backend Engineer",
      location: "Austin",
      source: "greenhouse",
      applyUrl: "https://apply.example.com/g2",
    });
    seed("g3", { title: "backend engineer", location: "Lisbon", company: "ACME" });
    seed("g4", { title: "Backend Engineer", location: "Lisbon", company: "Globex" });
    for (const id of ["g1", "g2", "g3", "g4"]) score(id);
    const { text } = run();
    expect(text.match(/^### /gm)).toHaveLength(2);
    expect(text).toContain("- Location: worldwide — Austin; Berlin; Lisbon");
    expect(text).toContain("- Apply: https://apply.example.com/g2 (unknown, not resolved yet)");
    expect(text).toContain("- Kept: 2");
    for (const id of ["g1", "g2", "g3", "g4"]) {
      expect(db.select().from(analysis).where(eq(analysis.posting_id, id)).get()?.digested_at).toBe(
        DATE,
      );
    }
    expect(run().text).toBe(text);
  });

  describe("apply route lines", () => {
    function link(id: string, type: string, url: string, foundOn = "remotive") {
      db.insert(apply_links)
        .values({
          id: `l-${id}`,
          posting_id: id,
          apply_url: url,
          apply_type: type as "ats",
          method: "ats_db",
          found_on: foundOn,
          checked_at: "2026-10-07T02:00:00Z",
        })
        .run();
    }
    const topBlock = (text: string, title: string) => {
      const from = text.indexOf(`### ${title}`);
      return text.slice(from, text.indexOf("\n\n", text.indexOf("- Posted:", from)));
    };

    it.each(["ats", "company_form", "signup_required", "unknown"])(
      "a Top match with apply type %s shows Apply and Found on",
      (type) => {
        seed("x", { title: "Role X" });
        score("x");
        link("x", type, "https://boards.example.com/acme/1", "himalayas");
        const block = topBlock(run().text, "Role X");
        expect(block).toContain(`- Apply: https://boards.example.com/acme/1 (${type})`);
        expect(block).toContain("- Found on: himalayas — https://example.com/jobs/x");
        expect(block).not.toContain("- Link:");
        expect(block.split("\n")[0]).toBe("### Role X — Acme Inc");
      },
    );

    it("a Top match without an apply_links row shows the current link as unresolved", () => {
      seed("n", { title: "Role N", source: "greenhouse", applyUrl: "https://apply.example.com/n" });
      score("n");
      const block = topBlock(run().text, "Role N");
      expect(block).toContain("- Apply: https://apply.example.com/n (unknown, not resolved yet)");
      expect(block).toContain("- Found on: greenhouse — https://example.com/jobs/n");
    });

    it("paid_aggregator gets the heading label and ranks by fit, not last", () => {
      seed("paid", { title: "Paid Role" });
      seed("free", { title: "Free Role" });
      score("paid", { fit_score: 80 });
      score("free", { fit_score: 70 });
      link("paid", "paid_aggregator", "https://paid.example.com/p");
      link("free", "ats", "https://boards.example.com/f");
      const { text } = run();
      expect(text).toContain("### Paid Role — Acme Inc (paid-only apply)");
      expect(text).not.toContain("Free Role — Acme Inc (paid-only apply)");
      expect(text).toContain("- Apply: https://paid.example.com/p (paid_aggregator)");
      const top = text.slice(text.indexOf("## Top matches"), text.indexOf("## Scored"));
      expect(top.indexOf("Paid Role")).toBeLessThan(top.indexOf("Free Role"));
    });

    it("not-a-fit and waiting lines show the resolved apply url", () => {
      seed("nf", { title: "Weak Role" });
      score("nf", { fit_score: TOP_MATCH_MIN_FIT - 1 });
      seed("w", { title: "Waiting Role" });
      link("nf", "paid_aggregator", "https://paid.example.com/nf");
      link("w", "company_form", "https://acme.example.com/apply");
      const { text } = run();
      expect(text).toMatch(
        /- Weak Role — Acme Inc \(paid-only apply\) — fit \d+\/100.* — https:\/\/paid.example.com\/nf/,
      );
      expect(text).toMatch(/- Waiting Role — Acme Inc — .* — https:\/\/acme.example.com\/apply/);
    });

    it("a group uses the apply link of the lead member", () => {
      seed("g1", { title: "Group Role", location: "Berlin" });
      seed("g2", { title: "Group Role", location: "Austin" });
      score("g2");
      link("g1", "ats", "https://boards.example.com/other");
      link("g2", "company_form", "https://acme.example.com/lead", "hn");
      const block = topBlock(run().text, "Group Role");
      expect(block).toContain("- Apply: https://acme.example.com/lead (company_form)");
      expect(block).toContain("- Found on: hn — https://example.com/jobs/g2");
      expect(block).not.toContain("boards.example.com/other");
    });
  });

  describe("groups take everything from one member", () => {
    it("takes link, title, salary, fit and why from the fit-scored member, not group[0]", () => {
      // g1 is the ATS member (group[0]) but unscored; g2 is scored with its own salary.
      seed("g1", {
        title: "Data Engineer",
        source: "greenhouse",
        applyUrl: "https://apply.example.com/g1",
        min: 10_000_000,
        max: 11_000_000,
      });
      seed("g2", { title: "data engineer", min: 40_000_000, max: 45_000_000 });
      score("g2");
      const { text } = run();
      const top = text.slice(text.indexOf("## Top matches"), text.indexOf("## Waiting"));
      expect(top).toContain("### data engineer — Acme Inc");
      expect(top).toContain("- Apply: https://example.com/jobs/g2 (unknown, not resolved yet)");
      expect(top).not.toContain("apply.example.com/g1");
      expect(top).toContain("- Fit: 80/100");
      expect(top).toContain("Strong TypeScript match");
      expect(top).toContain("45");
      expect(top).not.toContain("- Salary: IDR 10");
      expect(text).toContain("- Top matches: 1");
    });

    it("a Top match shows the hours it expects, and none when no hours zone is set", () => {
      seed("h1", { title: "Hours Engineer" });
      seed("h2", { title: "No Hours Engineer" });
      seed("h3", { title: "Open Hours Engineer" });
      score("h1", { extraction: JSON.stringify({ hoursZone: "europe", overlapHours: 4 }) });
      score("h2");
      score("h3", { extraction: JSON.stringify({ hoursZone: "americas", overlapHours: null }) });
      const { text } = run();
      const top = text.slice(text.indexOf("## Top matches"), text.indexOf("## Waiting"));
      const block = (title: string) =>
        top.slice(top.indexOf(`### ${title}`)).split("\n### ")[0] ?? "";
      expect(block("Hours Engineer")).toContain("- Hours: overlap 4 h with Europe\n");
      expect(block("No Hours Engineer")).not.toContain("- Hours:");
      expect(block("Open Hours Engineer")).toContain("- Hours: business hours with the Americas");
    });

    it("never puts a group with a suspicious member in Top; shows the suspicious link", () => {
      seed("s1", { title: "Ops Lead" });
      seed("s2", { title: "Ops Lead" });
      score("s1");
      score("s2", {
        final_decision: "suspicious",
        scam_score: 9,
        scam_reasons: JSON.stringify(["asks for a deposit"]),
        fit_score: null,
      });
      const { text } = run();
      const top = text.slice(text.indexOf("## Top matches"), text.indexOf("## Waiting"));
      const susp = text.slice(text.indexOf("## Suspicious"), text.indexOf("## Source health"));
      expect(top).not.toContain("Ops Lead");
      expect(susp).toContain("- Link: https://example.com/jobs/s2");
      expect(susp).toContain("asks for a deposit");
      expect(text).toContain("- Top matches: 0");
      expect(text).toContain("- Suspicious: 1");
    });

    it("does not show a group as Top when the chosen member has no ask", () => {
      seed("w1", { title: "QA Lead" });
      seed("w2", { title: "QA Lead" });
      score("w1", { tier: null, ask_idr_month: null });
      const { text } = run();
      const top = text.slice(text.indexOf("## Top matches"), text.indexOf("## Waiting"));
      const waiting = text.slice(text.indexOf("## Waiting"), text.indexOf("## Needs a look"));
      expect(top).not.toContain("QA Lead");
      expect(waiting).toContain("QA Lead");
      expect(waiting).toContain(" — https://example.com/jobs/w1");
    });

    it("prefers a scored member that has an ask over one that has none", () => {
      seed("a1", { title: "SRE" });
      seed("a2", { title: "SRE" });
      score("a1", { tier: null, ask_idr_month: null });
      score("a2");
      const { text } = run();
      const top = text.slice(text.indexOf("## Top matches"), text.indexOf("## Waiting"));
      expect(top).toContain("- Apply: https://example.com/jobs/a2 (unknown, not resolved yet)");
    });
  });

  describe("shorter format", () => {
    const topOf = (text: string) =>
      text.slice(text.indexOf("## Top matches"), text.indexOf("## Scored, not a fit"));
    const nine = [-8, -7, -6, -5, -4, -3, -1, 0, 2].map(
      (h) => `UTC${h < 0 ? "-" : "+"}${Math.abs(h)}`,
    );

    const extraction = (over: Record<string, unknown> = {}) =>
      JSON.stringify({
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
        roleFamily: "fullstack",
        roleTitle: null,
        contactChannels: [],
        personalEmailDomain: null,
        asksForPaymentOrId: null,
        repoAssessmentEarly: null,
        urgencyLanguage: null,
        vagueDescription: null,
        ...over,
      });

    it("has no Why line anywhere", () => {
      seed("a", { title: "Alpha" });
      score("a");
      expect(run().text).not.toContain("Why:");
    });

    it("compresses 9 UTC offsets into a span", () => {
      seed("z", { title: "Zones", location: nine.join(", ") });
      score("z");
      const text = run().text;
      expect(text).toContain("- Location: worldwide — UTC-8 to UTC+2 (9 zones)\n");
    });

    it("compresses IANA zone names and leaves fewer than 3 offsets alone", () => {
      seed("n", {
        title: "Named",
        location: "America/Los_Angeles, America/New_York, Europe/Berlin",
      });
      score("n");
      seed("f", { title: "Few", location: "UTC-5, UTC+1" });
      score("f");
      const text = run().text;
      expect(text).toContain("worldwide — UTC-8 to UTC+1 (3 zones)");
      expect(text).toContain("worldwide — UTC-5, UTC+1");
    });

    it("does not compress repeated identical offsets", () => {
      seed("r", { title: "Repeat", location: "UTC+1, UTC+1, UTC+1" });
      score("r");
      const text = run().text;
      expect(text).toContain("UTC+1, UTC+1, UTC+1");
      expect(text).not.toContain("1 zones");
    });

    it("cuts a 300-char location to 120 chars", () => {
      seed("l", { title: "Long", location: "x".repeat(300) });
      score("l");
      const line =
        run()
          .text.split("\n")
          .find((l) => l.startsWith("- Location: ")) ?? "";
      const value = line.slice("- Location: ".length);
      expect(value).toHaveLength(120);
      expect(value.endsWith("…")).toBe(true);
    });

    it.each([
      ["employee", "employee"],
      ["contractor", "contractor"],
      ["eor", "EOR"],
      [null, "unknown"],
    ])("shows Type for employment %s", (employment, label) => {
      seed("e", { title: "Typed" });
      score("e", { extraction: extraction({ employment }) });
      expect(topOf(run().text)).toContain(`- Type: ${label}\n`);
    });

    it("shows Type unknown without an extraction", () => {
      seed("e", { title: "Typed" });
      score("e");
      expect(topOf(run().text)).toContain("- Type: unknown\n");
    });

    it("shows Flags: none when location_unclear was settled, and keeps other flags", () => {
      seed("s", { title: "Settled", flags: ["location_unclear", "salary_unknown"] });
      score("s", { extraction: extraction() });
      seed("o", { title: "Open", flags: ["role_unclear"] });
      score("o");
      const blocks = topOf(run().text).split("### ").slice(1);
      const settled = blocks.find((b) => b.startsWith("Settled")) ?? "";
      const open = blocks.find((b) => b.startsWith("Open")) ?? "";
      expect(settled).toContain("- Flags: salary_unknown\n");
      expect(settled).not.toContain("location_unclear");
      expect(open).toContain("- Flags: role_unclear\n");
    });

    it("never lists a scored posting with location_unclear still open as a Top match; it waits in Needs a look", () => {
      seed("o", { title: "Open Location", flags: ["location_unclear"] });
      score("o", { fit_score: 93 });
      const { text } = run();
      expect(topOf(text)).not.toContain("Open Location");
      const waiting = text.slice(
        text.indexOf("## Waiting for scoring"),
        text.indexOf("## Needs a look"),
      );
      const looks = text.slice(text.indexOf("## Needs a look"), text.indexOf("## Suspicious"));
      expect(waiting).toContain(
        "Open Location — Acme Inc — location still unclear after the description",
      );
      expect(looks).toContain("Open Location — Acme Inc: location_unclear");
    });

    it("lists waiting entries as single lines with status and link", () => {
      seed("w", { title: "Wait", company: "Acme" });
      const text = run().text;
      const waiting = text.slice(text.indexOf("## Waiting"), text.indexOf("## Needs a look"));
      expect(waiting).toContain("- Wait — Acme — not enriched yet — https://example.com/jobs/w\n");
      expect(waiting).not.toContain("- Status:");
    });
  });

  it("caps joined locations at 5 with +N more", () => {
    for (const c of "abcdefg") {
      seed(`l${c}`, { title: "Same", location: `City ${c}` });
      score(`l${c}`);
    }
    const { text } = run();
    expect(text).toContain("City a; City b; City c; City d; City e; +2 more");
  });

  it("does not show a posting stamped on an earlier day", () => {
    seed("old", { title: "Yesterday Match", digestedAt: "2026-10-06" });
    seed("new", { title: "Today Match" });
    // Scored on an earlier day: done, nothing left to wait for.
    db.insert(intel)
      .values({
        id: "i-old",
        posting_id: "old",
        status: "done",
        final_decision: "keep",
        fit_score: 70,
        updated_at: "2026-10-06T01:00:00Z",
      })
      .run();
    const { text } = run();
    expect(text).toContain("Today Match");
    expect(text).not.toContain("Yesterday Match");
  });

  it("stamps with the --date value", () => {
    seed("x");
    run({ date: "2026-10-09" });
    expect(db.select().from(analysis).get()?.digested_at).toBe("2026-10-09");
  });

  it("reports source errors and sources without an ok run in 24h", () => {
    run1("1", "greenhouse", "ok", "2026-10-07T01:00:00Z");
    run1("2", "remotive", "ok", "2026-10-06T20:00:00Z");
    run1("3", "remotive", "error", "2026-10-07T02:00:00Z", "HTTP 503\nfrom remotive");
    run1("4", "hn", "ok", "2026-10-01T00:00:00Z");
    const { text } = run();
    const health = text.slice(text.indexOf("## Source health"));
    expect(health).toContain("- **greenhouse**: ok, found 10, new 3\n");
    expect(health).toContain(
      "- **remotive**: error, found 10, new 3, error: HTTP 503 from remotive\n",
    );
    expect(health).toContain("- **hn**: no run in the last 24h — NO SUCCESSFUL RUN");
    expect(health).not.toMatch(/remotive.*NO SUCCESSFUL RUN/);
  });

  it("shows saturated N right after new M for a paged source, 0 included; other rows unchanged", () => {
    run1("1", "greenhouse", "ok", "2026-10-07T01:00:00Z");
    run1("2", "linkedin", "ok", "2026-10-07T01:00:00Z", undefined, 1);
    run1("3", "indeed", "ok", "2026-10-07T01:00:00Z", undefined, 0);
    const { text } = run();
    expect(text).toContain("- **linkedin**: ok, found 10, new 3, saturated 1 —");
    expect(text).toContain("- **indeed**: ok, found 10, new 3, saturated 0 —");
    expect(text).toContain("- **greenhouse**: ok, found 10, new 3\n");
  });

  it("ignores skipped runs when picking the latest run, and labels ok-run notes as warnings", () => {
    run1("1", "greenhouse", "ok", "2026-10-07T01:00:00Z", "1 board not found: gone");
    run1("2", "greenhouse", "skipped", "2026-10-07T02:00:00Z");
    const { text } = run();
    expect(text).toContain(
      "- **greenhouse**: ok, found 10, new 3, warning: 1 board not found: gone\n",
    );
    expect(text).not.toContain("skipped");
  });

  it("marks a source whose only recent runs failed", () => {
    run1("1", "remotive", "error", "2026-10-07T02:00:00Z", "boom");
    expect(run().text).toContain("error: boom — NO SUCCESSFUL RUN");
  });

  it("writes an empty day with the source health section", () => {
    run1("1", "greenhouse", "ok", "2026-10-07T01:00:00Z");
    const { text } = run();
    expect(text).toContain("None scored yet.");
    expect(text).not.toContain("### ");
    expect(text).toContain("- Kept: 0");
    expect(text).toContain("## Source health");
    expect(text).toContain("- **greenhouse**: ok");
  });

  it("rejects an invalid date", () => {
    expect(() => run({ date: "nope" })).toThrow(/Invalid date/);
  });
});

describe("Top matches threshold", () => {
  function score(id: string, over: Partial<typeof intel.$inferInsert> = {}) {
    db.insert(intel)
      .values({
        id: `i-${id}`,
        posting_id: id,
        status: "done",
        final_decision: "keep",
        scam_score: 0,
        scam_reasons: "[]",
        fit_score: 80,
        fit_reasons: JSON.stringify(["Strong TypeScript match", "Second reason"]),
        tier: "regional",
        ask_idr_month: 20_000_000,
        updated_at: "2026-10-07T02:00:00Z",
        ...over,
      })
      .run();
  }
  const part = (text: string, from: string, to: string) =>
    text.slice(text.indexOf(from), text.indexOf(to));

  it("uses 60 as the threshold", () => {
    expect(TOP_MATCH_MIN_FIT).toBe(60);
  });

  it("fit 60 is a Top match, fit 59 goes to Scored, not a fit", () => {
    seed("b60", { title: "Boundary Sixty" });
    score("b60", { fit_score: 60 });
    seed("b59", { title: "Boundary Fifty Nine" });
    score("b59", { fit_score: 59 });
    const { text } = run();
    const top = part(text, "## Top matches", "## Scored, not a fit");
    const low = part(text, "## Scored, not a fit", "## Waiting");
    expect(top).toContain("### Boundary Sixty — Acme Inc");
    expect(top).not.toContain("Boundary Fifty Nine");
    expect(low).toContain("Boundary Fifty Nine");
    expect(low).not.toContain("Boundary Sixty");
    expect(low).not.toContain("###");
  });

  it("prints a compact line with title, company, fit, first reason and link", () => {
    seed("c1", { title: "Weak Fit" });
    score("c1", { fit_score: 40 });
    const { text } = run();
    expect(text).toContain(
      "- Weak Fit — Acme Inc — fit 40/100 — Strong TypeScript match — https://example.com/jobs/c1\n",
    );
    expect(text).not.toContain("Second reason");
  });

  it("prints no empty separator when there are no fit reasons", () => {
    seed("c2", { title: "No Reasons" });
    score("c2", { fit_score: 30, fit_reasons: "[]" });
    const { text } = run();
    expect(text).toContain("- No Reasons — Acme Inc — fit 30/100 — https://example.com/jobs/c2\n");
  });

  it("sorts by fit descending, then posted date descending", () => {
    seed("o1", { title: "Fit 50 Old", posted: "2026-10-01T00:00:00Z" });
    score("o1", { fit_score: 50 });
    seed("o2", { title: "Fit 50 New", posted: "2026-10-06T00:00:00Z" });
    score("o2", { fit_score: 50 });
    seed("o3", { title: "Fit 55", posted: "2026-10-02T00:00:00Z" });
    score("o3", { fit_score: 55 });
    seed("o4", { title: "Fit 20", posted: "2026-10-06T00:00:00Z" });
    score("o4", { fit_score: 20 });
    const low = part(run().text, "## Scored, not a fit", "## Waiting");
    const order = ["Fit 55", "Fit 50 New", "Fit 50 Old", "Fit 20"].map((t) => low.indexOf(t));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((x) => x >= 0)).toBe(true);
  });

  it("prints None. when nothing is below the threshold", () => {
    seed("n1", { title: "Great" });
    score("n1");
    const { text } = run();
    expect(part(text, "## Scored, not a fit", "## Waiting")).toBe(
      "## Scored, not a fit\n\nNone.\n\n",
    );
    expect(text).toContain("- Scored, not a fit: 0");
  });

  it("counts top, low-fit, waiting and suspicious correctly", () => {
    seed("t1", { title: "Top One" });
    score("t1", { fit_score: 85 });
    seed("l1", { title: "Low One" });
    score("l1", { fit_score: 45 });
    seed("l2", { title: "Low Two" });
    score("l2", { fit_score: 10 });
    seed("w1", { title: "Waiting One" });
    seed("w2", { title: "Fx Wait", salaryStatus: "no_fx" });
    score("w2", { status: "fx_wait", tier: null, fit_score: 90 });
    seed("s1", { title: "Scam One" });
    score("s1", { final_decision: "suspicious", scam_score: 80, fit_score: null });
    const { text } = run();
    expect(text).toContain("- Top matches: 1\n");
    expect(text).toContain("- Scored, not a fit: 2\n");
    expect(text).toContain("- Waiting for scoring: 2\n");
    expect(text).toContain("- Suspicious: 1\n");
    expect(text).toContain("- Kept: 5\n");
    expect(part(text, "## Waiting for scoring", "## Needs a look")).toContain("Fx Wait");
    expect(part(text, "## Suspicious", "## Source health")).toContain("Scam One");
  });

  it("does not list a low fit under Needs a look", () => {
    seed("u1", { title: "Low Unclear", flags: ["location_unclear"], locationClass: "unclear" });
    score("u1", { fit_score: 30 });
    const { text } = run();
    expect(part(text, "## Needs a look", "## Suspicious")).not.toContain("Low Unclear");
    expect(part(text, "## Scored, not a fit", "## Waiting")).toContain("Low Unclear");
  });
});

describe("cli digest", () => {
  it("fails on an invalid date without writing", async () => {
    const prev = process.env["JOB_AGENT_DB"];
    process.env["JOB_AGENT_DB"] = join(dir, "t.db");
    const err: string[] = [];
    try {
      const code = await main(["digest", "--date", "bad"], {
        out: () => {},
        err: (t) => err.push(t),
      });
      expect(code).toBe(1);
      expect(err.join("")).toContain("Invalid date");
    } finally {
      if (prev === undefined) delete process.env["JOB_AGENT_DB"];
      else process.env["JOB_AGENT_DB"] = prev;
    }
  });
});
