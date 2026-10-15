import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { intel, openDb, postings, type Db } from "@job-agent/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordReview, type ReviewInput } from "../review/record.ts";
import { seedDemo } from "../seed-demo.ts";
import { FitSetSchema } from "./fit.ts";
import { buildReviewSet, isForbiddenOutDir, runExportReviews } from "./export-reviews.ts";

const DATE = "2026-03-10";
const NOW = new Date("2026-03-10T09:30:00.000Z");
const SECRET = "SECRET-POSTING-TEXT";

let db: Db;
let root: string;
let ids: string[];
beforeEach(() => {
  db = openDb(":memory:");
  seedDemo(db, DATE);
  root = mkdtempSync(join(tmpdir(), "export-reviews-"));
  mkdirSync(join(root, "data"));
  for (let n = 0; n < 6; n++) {
    db.insert(postings)
      .values({
        id: `extra-${n}`,
        source: "remoteok",
        external_id: `extra-${n}`,
        url: `https://extra${n}.example.com/job`,
        title: "Fake Engineer",
        company_name: "Extra Example Co",
        description_text: "Fake description.",
        first_seen_at: NOW.toISOString(),
        last_seen_at: NOW.toISOString(),
      })
      .run();
  }
  ids = db
    .select({ id: postings.id })
    .from(postings)
    .all()
    .map((r) => r.id)
    .sort();
});
afterEach(() => {
  db.$client.close();
  rmSync(root, { recursive: true, force: true });
});

let minute = 0;
const review = (id: string | undefined, input: Omit<ReviewInput, "posting_id">, at = NOW) => {
  if (id === undefined) throw new Error("not enough seeded postings");
  recordReview(db, { posting_id: id, ...input }, new Date(at.getTime() + minute++ * 60_000));
};

function run(args: string[]) {
  let out = "";
  let err = "";
  const code = runExportReviews({
    args,
    db,
    repoRoot: root,
    now: () => NOW,
    out: (t) => (out += t),
    err: (t) => (err += t),
  });
  return { code, out, err };
}

describe("buildReviewSet", () => {
  it("maps interested/applied to high, role/stack/seniority to low, and skips the rest", () => {
    review(ids[0], { action: "interested" });
    review(ids[1], { action: "applied_manually" });
    review(ids[2], { action: "not_interested", reason: "role" });
    review(ids[3], { action: "not_interested", reason: "stack" });
    review(ids[4], { action: "not_interested", reason: "seniority" });
    review(ids[5], { action: "not_interested", reason: "salary" });
    review(ids[6], { action: "not_interested", reason: "location" });
    review(ids[7], { action: "later" });
    review(ids[8], { action: "scam" });
    const { set, counts } = buildReviewSet(db);
    const band = Object.fromEntries(set.cases.map((c) => [c.id, c.expectedBand]));
    expect(band).toEqual({
      [ids[0] ?? ""]: "high",
      [ids[1] ?? ""]: "high",
      [ids[2] ?? ""]: "low",
      [ids[3] ?? ""]: "low",
      [ids[4] ?? ""]: "low",
    });
    expect(counts).toEqual({ high: 2, low: 3, skippedReason: 2, skippedNoText: 0 });
  });

  it("uses the newest status action and ignores extra rows such as ask checks", () => {
    review(ids[0], { action: "not_interested", reason: "role" });
    review(ids[0], { action: "interested" });
    review(ids[0], { action: "ask_too_high" });
    review(ids[1], { action: "interested" });
    review(ids[1], { action: "not_interested", reason: "company" });
    const { set, counts } = buildReviewSet(db);
    expect(set.cases.map((c) => [c.id, c.expectedBand])).toEqual([[ids[0], "high"]]);
    expect(counts.skippedReason).toBe(1);
  });

  it("carries the posting text and the stored extraction needed for a run", () => {
    const id = ids[0] ?? "";
    db.update(postings).set({ description_text: SECRET }).where(eq(postings.id, id)).run();
    db.delete(intel).where(eq(intel.posting_id, id)).run();
    db.insert(intel)
      .values({
        id: "intel-x",
        posting_id: id,
        status: "done",
        extraction: JSON.stringify({
          listedSalary: null,
          listedSalaryScope: null,
          hiringScope: "worldwide",
          regions: [],
          remoteRegions: [],
          allowedCountries: [],
          indonesiaExplicit: null,
          companyHq: null,
          companyType: "product",
          payPolicy: null,
          employment: null,
          eorProvider: null,
          seniority: "senior",
          contactChannels: [],
          personalEmailDomain: null,
          asksForPaymentOrId: null,
          repoAssessmentEarly: null,
          urgencyLanguage: null,
          vagueDescription: null,
        }),
        updated_at: NOW.toISOString(),
      })
      .run();
    review(id, { action: "interested" });
    const [c] = buildReviewSet(db).set.cases;
    expect(c?.description).toBe(SECRET);
    expect(c?.extraction).toMatchObject({ seniority: "senior", companyType: "product" });
    expect(FitSetSchema.safeParse(buildReviewSet(db).set).success).toBe(true);
  });

  it("skips a reviewed posting without description text and counts it", () => {
    const id = ids[0] ?? "";
    db.update(postings).set({ description_text: null }).where(eq(postings.id, id)).run();
    review(id, { action: "interested" });
    expect(buildReviewSet(db).counts).toEqual({
      high: 0,
      low: 0,
      skippedReason: 0,
      skippedNoText: 1,
    });
  });

  it("--since keeps only reviews from that Asia/Jakarta day on", () => {
    review(ids[0], { action: "interested" }, new Date("2026-03-01T05:00:00Z"));
    review(ids[1], { action: "interested" }, new Date("2026-03-10T05:00:00Z"));
    const { set } = buildReviewSet(db, "2026-03-05");
    expect(set.cases.map((c) => c.id)).toEqual([ids[1]]);
  });
});

describe("runExportReviews", () => {
  it("writes data/eval/reviews-<date>.json and prints only the path and counts", () => {
    const id = ids[0] ?? "";
    db.update(postings).set({ description_text: SECRET }).where(eq(postings.id, id)).run();
    review(id, { action: "interested" });
    review(ids[1], { action: "not_interested", reason: "stack" });
    review(ids[2], { action: "not_interested", reason: "salary" });
    const r = run([]);
    const path = join(root, "data/eval/reviews-2026-03-10.json");
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(r.out).toBe(
      `eval:export-reviews: wrote ${path}\n  cases 2 (high 1, low 1), skipped 1 by reason, 0 without posting text\n`,
    );
    expect(r.out).not.toContain(SECRET);
    const written = FitSetSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(written.cases).toHaveLength(2);
    expect(written.cases.find((c) => c.id === id)?.description).toBe(SECRET);
  });

  it("refuses to write inside the repo outside data/, and writes nothing", () => {
    review(ids[0], { action: "interested" });
    for (const dir of [join(root, "docs"), join(root, "fixtures/eval"), root]) {
      const r = run(["--out-dir", dir]);
      expect(r.code).toBe(1);
      expect(r.err).toBe(
        "eval:export-reviews: refusing to write inside the repository outside data/\n",
      );
      expect(existsSync(join(dir, "reviews-2026-03-10.json"))).toBe(false);
    }
    expect(existsSync(join(root, "docs"))).toBe(false);
  });

  it("allows an output dir outside the repo and one inside data/", () => {
    review(ids[0], { action: "interested" });
    const elsewhere = mkdtempSync(join(tmpdir(), "export-elsewhere-"));
    try {
      expect(run(["--out-dir", elsewhere]).code).toBe(0);
      expect(existsSync(join(elsewhere, "reviews-2026-03-10.json"))).toBe(true);
      expect(run(["--out-dir", join(root, "data/other")]).code).toBe(0);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("is not fooled by a symlink or `..` that points into the repo", () => {
    review(ids[0], { action: "interested" });
    const outside = mkdtempSync(join(tmpdir(), "export-link-"));
    try {
      symlinkSync(join(root, "docs-target"), join(outside, "link"));
      mkdirSync(join(root, "docs-target"));
      expect(isForbiddenOutDir(root, join(outside, "link"))).toBe(true);
      expect(isForbiddenOutDir(root, join(root, "data", "..", "docs"))).toBe(true);
      expect(run(["--out-dir", join(outside, "link")]).code).toBe(1);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("exits 1 with nothing written when no review is usable", () => {
    review(ids[0], { action: "not_interested", reason: "salary" });
    const r = run([]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^eval:export-reviews: no usable reviews/);
    expect(existsSync(join(root, "data/eval"))).toBe(false);
  });

  it("rejects a bad --since and unknown flags; --help documents the next step", () => {
    expect(run(["--since", "yesterday"]).code).toBe(1);
    expect(run(["--bogus"]).code).toBe(1);
    const help = run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("eval:fit --set data/eval/reviews-<date>.json --live");
  });
});
