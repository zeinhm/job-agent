import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analysis,
  answer_bank,
  apply_links,
  dry_runs,
  intel,
  openDb,
  openDbReadonly,
  posting_questions,
  postings,
  reviews,
  type Db,
} from "@job-agent/core";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isDryRunCandidate } from "@job-agent/apply";
import { main } from "./cli.ts";
import {
  compareCandidates,
  isOperatorCandidate,
  listOperatorCandidates,
  type OperatorCandidate,
} from "./dry-run-candidates.ts";

/** Every fake personal value carries a marker; none may reach stdout or stderr. */
const MV = "QZVALUE8";
const MN = "QZNOTE8";
const MB = "QZBAD8";
const MARKERS = [MV, MN, MB];

const T0 = "2026-10-10T10:00:00.000Z";

let dir: string;
let dbPath: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dry-run-candidates-"));
  dbPath = join(dir, "scratch.db");
  db = openDb(dbPath);
  process.env["JOB_AGENT_DB"] = dbPath;
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env["JOB_AGENT_DB"];
});

async function candidates(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(["dry-run-candidates", ...args], {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  return { code, out: out.join(""), err: err.join("") };
}

function expectValueFree(r: { out: string; err: string }) {
  for (const m of MARKERS) {
    expect(r.out).not.toContain(m);
    expect(r.err).not.toContain(m);
  }
}

const URLS = {
  greenhouse: (n: string) => `https://boards.greenhouse.io/fakeco/jobs/${n}`,
  lever: (n: string) => `https://jobs.lever.co/fakeco/aaaa${n}-bbbb`,
  ashby: (n: string) =>
    `https://jobs.ashbyhq.com/fakeco/${n.padStart(8, "0")}-0000-4000-8000-000000000000`,
};

interface Opts {
  ats?: "greenhouse" | "lever" | "ashby";
  url?: string;
  title?: string;
  decision?: "keep" | "reject";
  canonical?: string | null;
  firstSeen?: string;
  /** Default `keep`; null stores no intel row at all. */
  intelDecision?: "keep" | "reject" | "suspicious" | null;
}

/** A posting that passes the rule; `Opts` breaks it one way. */
function addPosting(id: string, o: Opts = {}) {
  const ats = o.ats ?? "greenhouse";
  const num = id.replace(/\D/g, "") || "1";
  db.insert(postings)
    .values({
      id,
      source: ats,
      external_id: id,
      url: o.url ?? URLS[ats](num),
      title: o.title ?? `Fake title ${id}`,
      company_name: "Fake Co",
      description_text: `Fake description ${MV}`,
      canonical_posting_id: o.canonical ?? null,
      first_seen_at: o.firstSeen ?? T0,
      last_seen_at: o.firstSeen ?? T0,
    })
    .run();
  db.insert(analysis)
    .values({
      id: `a-${id}`,
      posting_id: id,
      location_class: "worldwide",
      indonesia_rule: "not_applicable",
      salary_status: "unknown",
      decision: o.decision ?? "keep",
      analyzed_at: T0,
    })
    .run();
  if (o.intelDecision !== null) {
    db.insert(intel)
      .values({
        id: `i-${id}`,
        posting_id: id,
        status: "done",
        final_decision: o.intelDecision ?? "keep",
        updated_at: T0,
      })
      .run();
  }
}

let qn = 0;
/** `n` stored questions on a posting: `covered` of them have an approved answer, the rest have none. */
function addQuestions(id: string, ats: string, n: number, covered = 0) {
  for (let i = 0; i < n; i++) {
    qn++;
    const label =
      i < covered
        ? "How many years of TypeScript experience do you have?"
        : `Unmatched question ${qn} zzq`;
    // Same wording on several postings is fine: the unique key is (posting, question id).
    db.insert(posting_questions)
      .values({
        id: `q-${qn}`,
        posting_id: id,
        ats_type: ats,
        question_id: `f${i}`,
        label: i < covered ? `${label}` : label,
        required: true,
        type: "text",
        normalized_label: label.toLowerCase(),
        fetched_at: T0,
      })
      .run();
  }
}

function addAnswers() {
  db.insert(answer_bank)
    .values({
      id: "ans-1",
      key: "experience.years_typescript",
      group: "experience",
      question: "How many years of TypeScript experience do you have?",
      answer: `7 ${MV}`,
      type: "text",
      approved: true,
      source: "config",
      updated_at: T0,
    })
    .run();
}

function review(posting: string, action: string, at: string, reason: string | null = null) {
  db.insert(reviews)
    .values({
      id: `r-${posting}-${at}-${action}`,
      posting_id: posting,
      action: action as "interested",
      reason: reason as "role" | null,
      note: `${MN} note`,
      reviewed_at: at,
      review_day: at.slice(0, 10),
    })
    .run();
}

const ids = () => listOperatorCandidates(db).map((c) => c.postingId);

describe("the candidate rule", () => {
  beforeEach(() => {
    addAnswers();
  });

  it("accepts a kept canonical posting with a Greenhouse, Lever or Ashby job link", () => {
    addPosting("g1");
    addQuestions("g1", "greenhouse", 2, 1);
    addPosting("l1", { ats: "lever" });
    addPosting("a1", { ats: "ashby" });
    expect(ids().sort()).toEqual(["a1", "g1", "l1"]);
    expect(isOperatorCandidate(db, "g1")).toBe(true);
    expect(isOperatorCandidate(db, "missing")).toBe(false);
  });

  it("agrees with operator-dry-run's gate: a kept posting with no intel row is in neither", () => {
    addPosting("noi", { intelDecision: null });
    addQuestions("noi", "greenhouse", 1, 1);
    addPosting("ok");
    addQuestions("ok", "greenhouse", 1, 1);
    expect(isDryRunCandidate(db, "noi")).toBe(false);
    expect(isOperatorCandidate(db, "noi")).toBe(false);
    expect(ids()).toEqual(["ok"]);
    // The list is never wider than the gate.
    for (const c of listOperatorCandidates(db))
      expect(isDryRunCandidate(db, c.postingId)).toBe(true);
  });

  it.each([
    [
      "rejected by the analysis (location, language, role rules)",
      (id: string) => addPosting(id, { decision: "reject" }),
    ],
    [
      "rejected by the intel resolve step",
      (id: string) => addPosting(id, { intelDecision: "reject" }),
    ],
    ["suspicious verdict", (id: string) => addPosting(id, { intelDecision: "suspicious" })],
    [
      "scam review",
      (id: string) => {
        addPosting(id);
        review(id, "scam", "2026-10-11T10:00:00.000Z");
      },
    ],
    [
      "not_interested",
      (id: string) => {
        addPosting(id);
        review(id, "not_interested", "2026-10-11T10:00:00.000Z", "role");
      },
    ],
    [
      "applied",
      (id: string) => {
        addPosting(id);
        review(id, "applied_manually", "2026-10-11T10:00:00.000Z");
      },
    ],
    ["a duplicate (not canonical)", (id: string) => addPosting(id, { canonical: "ok1" })],
    ["no ATS link", (id: string) => addPosting(id, { url: "https://fake.example/jobs/1" })],
    [
      "a board link, not a job link",
      (id: string) => addPosting(id, { url: "https://boards.greenhouse.io/fakeco" }),
    ],
    [
      "another ATS (Workable)",
      (id: string) => addPosting(id, { url: "https://apply.workable.com/fakeco/j/ABC123/" }),
    ],
    [
      "a Lever link without a posting id",
      (id: string) => addPosting(id, { ats: "lever", url: "https://jobs.lever.co/fakeco" }),
    ],
    ["a Greenhouse posting without stored questions", (id: string) => addPosting(id)],
  ])("excludes: %s", (_name, make) => {
    addPosting("ok1");
    addQuestions("ok1", "greenhouse", 1, 1);
    make("bad1");
    if (_name !== "a Greenhouse posting without stored questions")
      addQuestions("bad1", "greenhouse", 1, 1);
    expect(ids()).toEqual(["ok1"]);
    expect(isOperatorCandidate(db, "bad1")).toBe(false);
  });

  it("uses the apply_links row before the posting's own link, and the newest status review only", () => {
    // The stored apply link is a company form: not a candidate even though the posting url is Greenhouse.
    addPosting("moved");
    addQuestions("moved", "greenhouse", 1);
    db.insert(apply_links)
      .values({
        id: "al1",
        posting_id: "moved",
        apply_url: "https://careers.fake.example/apply",
        apply_type: "company_form",
        method: "owner",
        found_on: "greenhouse",
        checked_at: T0,
      })
      .run();
    // not_interested, then reopened: a candidate again. `later` and a scam-unrelated note change nothing.
    addPosting("back");
    addQuestions("back", "greenhouse", 1);
    review("back", "not_interested", "2026-10-11T10:00:00.000Z", "role");
    review("back", "reopen", "2026-10-12T10:00:00.000Z");
    addPosting("later");
    addQuestions("later", "greenhouse", 1);
    review("later", "later", "2026-10-11T10:00:00.000Z");
    // applied after a not_interested: still excluded.
    addPosting("done");
    addQuestions("done", "greenhouse", 1);
    review("done", "not_interested", "2026-10-11T10:00:00.000Z", "role");
    review("done", "applied_manually", "2026-10-12T10:00:00.000Z");
    // not_scam does not hide a not_interested that is still the newest status.
    expect(ids().sort()).toEqual(["back", "later"]);
  });

  it("an owner not_scam review does not clear an intel suspicious verdict, and a later scam review excludes", () => {
    addPosting("s1", { intelDecision: "suspicious" });
    addQuestions("s1", "greenhouse", 1);
    review("s1", "not_scam", "2026-10-11T10:00:00.000Z");
    addPosting("s2");
    addQuestions("s2", "greenhouse", 1);
    review("s2", "not_scam", "2026-10-11T10:00:00.000Z");
    review("s2", "scam", "2026-10-12T10:00:00.000Z");
    expect(ids()).toEqual([]);
  });
});

describe("the order", () => {
  beforeEach(() => {
    addAnswers();
  });

  it("Greenhouse and Lever before Ashby, then fewest missing, then newest; unknown counts after known ones", () => {
    // Greenhouse: 3 missing, newest.
    addPosting("g-3", { firstSeen: "2026-10-12T00:00:00.000Z" });
    addQuestions("g-3", "greenhouse", 3);
    // Greenhouse: 1 missing, older.
    addPosting("g-1-old", { firstSeen: "2026-10-01T00:00:00.000Z" });
    addQuestions("g-1-old", "greenhouse", 2, 1);
    // Greenhouse: 1 missing, newer than g-1-old.
    addPosting("g-1-new", { firstSeen: "2026-10-05T00:00:00.000Z" });
    addQuestions("g-1-new", "greenhouse", 2, 1);
    // Lever, full fill.
    addPosting("l-0", { ats: "lever", firstSeen: "2026-10-02T00:00:00.000Z" });
    addQuestions("l-0", "lever", 2, 2);
    // Lever before a first run: no stored questions, after every known count among Greenhouse / Lever.
    addPosting("l-unknown", { ats: "lever", firstSeen: "2026-10-12T00:00:00.000Z" });
    // Ashby is last even with 0 missing; its unknown one after its known one.
    addPosting("a-0", { ats: "ashby", firstSeen: "2026-10-01T00:00:00.000Z" });
    addQuestions("a-0", "ashby", 1, 1);
    addPosting("a-unknown", { ats: "ashby", firstSeen: "2026-10-12T00:00:00.000Z" });
    expect(ids()).toEqual(["l-0", "g-1-new", "g-1-old", "g-3", "l-unknown", "a-0", "a-unknown"]);
  });

  it("breaks a full tie by id", () => {
    const base: OperatorCandidate = {
      postingId: "b",
      ats: "lever",
      title: "t",
      questions: 1,
      missing: 0,
      lastRun: null,
      firstSeenAt: T0,
    };
    expect(
      [
        { ...base, postingId: "b" },
        { ...base, postingId: "a" },
      ]
        .sort(compareCandidates)
        .map((c) => c.postingId),
    ).toEqual(["a", "b"]);
  });

  it("counts a choice question as missing until its mapping is approved, and a salary question without a tier ask", () => {
    addPosting("m1");
    db.insert(posting_questions)
      .values([
        {
          id: "qs1",
          posting_id: "m1",
          ats_type: "greenhouse",
          question_id: "s1",
          label: "Expected salary in USD per year",
          required: true,
          type: "number",
          normalized_label: "expected salary in usd per year",
          fetched_at: T0,
        },
      ])
      .run();
    expect(listOperatorCandidates(db).map((c) => [c.postingId, c.questions, c.missing])).toEqual([
      ["m1", 1, 1],
    ]);
    db.update(intel)
      .set({ ask_idr_month: 1, ask_usd_year: 50000 })
      .where(eq(intel.posting_id, "m1"))
      .run();
    expect(listOperatorCandidates(db).map((c) => c.missing)).toEqual([0]);
  });

  it("shows the newest real run's status, ignoring fixture runs", () => {
    addPosting("r1");
    addQuestions("r1", "greenhouse", 1, 1);
    const run = (id: string, at: string, status: "filled" | "stopped", fixture: boolean) =>
      db
        .insert(dry_runs)
        .values({
          id,
          posting_id: "r1",
          ats_type: "greenhouse",
          started_at: at,
          finished_at: at,
          status,
          fixture,
        })
        .run();
    run("d1", "2026-10-11T00:00:00.000Z", "filled", false);
    run("d2", "2026-10-12T00:00:00.000Z", "stopped", false);
    run("d3", "2026-10-13T00:00:00.000Z", "filled", true);
    expect(listOperatorCandidates(db)[0]?.lastRun).toBe("stopped");
  });
});

describe("dry-run-candidates", () => {
  beforeEach(() => {
    addAnswers();
  });

  it("prints one value-free line per posting and honours --limit (default 20)", async () => {
    addPosting("g1", { title: `Engineer ${MN.slice(0, 0)}One` });
    addQuestions("g1", "greenhouse", 3, 2);
    addPosting("l1", { ats: "lever" });
    addPosting("a1", { ats: "ashby" });
    db.insert(dry_runs)
      .values({
        id: "d1",
        posting_id: "g1",
        ats_type: "greenhouse",
        started_at: T0,
        finished_at: T0,
        status: "needs_input",
        review_note: MN,
      })
      .run();
    const r = await candidates();
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(r.out).toBe(
      [
        'posting="g1" ats=greenhouse title="Engineer One" questions=3 missing=1 last=needs_input',
        'posting="l1" ats=lever title="Fake title l1" questions=? missing=? last=-',
        'posting="a1" ats=ashby title="Fake title a1" questions=? missing=? last=-',
        "",
      ].join("\n"),
    );
    expectValueFree(r);
    const one = await candidates("--limit", "1");
    expect(one.out.trimEnd().split("\n")).toHaveLength(1);
    expect(one.out).toContain('posting="g1"');
  });

  it("sanitises a title: a newline cannot forge a second line, control characters go, length is cut", async () => {
    addPosting("g1", { title: 'Dev\nposting="forged" ats=lever‮\u0007 ' + "x".repeat(400) });
    addQuestions("g1", "greenhouse", 1, 1);
    const r = await candidates();
    expect(r.out.trimEnd().split("\n")).toHaveLength(1);
    expect(r.out).not.toContain("‮");
    expect(r.out.length).toBeLessThan(400);
  });

  it("an empty database prints a fixed line, exit 0", async () => {
    const r = await candidates();
    expect(r).toEqual({ code: 0, out: "dry-run-candidates: no candidates\n", err: "" });
  });

  it("refuses bad arguments with fixed text and never echoes them", async () => {
    for (const args of [
      ["--limit", "0"],
      ["--limit", "201"],
      ["--limit", "abc"],
      ["--limit", `${MB}`],
      ["--limit"],
      ["extra"],
      [`--${MB}`],
      ["--limit", "1", MB],
    ]) {
      const r = await candidates(...args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.out).toBe("");
      expect(r.err).toMatch(/^dry-run-candidates: refused: invalid arguments\nUsage: /);
      expectValueFree(r);
    }
  });

  it("a missing database is refused, not created", async () => {
    process.env["JOB_AGENT_DB"] = join(dir, "nope.db");
    const r = await candidates();
    expect(r).toEqual({
      code: 1,
      out: "",
      err: "dry-run-candidates: refused: database not found\n",
    });
    expect(() => readFileSync(join(dir, "nope.db"))).toThrow();
  });

  it("a corrupt row prints one fixed error line and no partial list", async () => {
    addPosting("g1");
    addQuestions("g1", "greenhouse", 1, 1);
    addPosting("g2");
    addQuestions("g2", "greenhouse", 1, 1);
    db.run(
      sql`insert into reviews (id, posting_id, action, reviewed_at, review_day, note) values ('bad', 'g2', ${MB}, ${T0}, '2026-10-10', ${MN})`,
    );
    const r = await candidates();
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/^dry-run-candidates: error ZodError at \S+:\d+\n$/);
    expectValueFree(r);
  });

  it("is read-only: the database file is byte-identical afterwards, and a read-only handle works", async () => {
    addPosting("g1");
    addQuestions("g1", "greenhouse", 2, 1);
    addPosting("l1", { ats: "lever" });
    db.$client.pragma("wal_checkpoint(TRUNCATE)");
    const digest = () => createHash("sha256").update(readFileSync(dbPath)).digest("hex");
    const before = digest();
    const r = await candidates();
    expect(r.code).toBe(0);
    expect(digest()).toBe(before);
    const ro = openDbReadonly(dbPath);
    try {
      expect(listOperatorCandidates(ro)).toHaveLength(2);
      expect(isOperatorCandidate(ro, "g1")).toBe(true);
      expect(() =>
        ro.update(postings).set({ title: "x" }).where(eq(postings.id, "g1")).run(),
      ).toThrow();
    } finally {
      ro.$client.close();
    }
  });

  it("prints no personal value or free text: answers, notes, descriptions, options never appear", async () => {
    addPosting("g1");
    addQuestions("g1", "greenhouse", 2, 1);
    db.insert(posting_questions)
      .values({
        id: "qc",
        posting_id: "g1",
        ats_type: "greenhouse",
        question_id: "choice",
        label: `Pick one ${MV}`,
        required: true,
        type: "choice",
        options: JSON.stringify([`${MV} a`, `${MV} b`]),
        normalized_label: `pick one ${MV}`.toLowerCase(),
        fetched_at: T0,
      })
      .run();
    review("g1", "interested", "2026-10-11T10:00:00.000Z");
    const r = await candidates();
    expect(r.code).toBe(0);
    expect(r.out).toContain("questions=3 missing=2");
    expectValueFree(r);
  });
});
