import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb, postings, reviews, type Db } from "@job-agent/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runExportReviews } from "./export-reviews.ts";
import { FitSetSchema } from "./fit.ts";

const NOW = new Date("2026-10-16T03:00:00Z");
const SECRET = "SECRET-POSTING-TEXT";

let db: Db;
let root: string;
let tmp: string;
beforeEach(() => {
  db = openDb(":memory:");
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "eval-export-"))); // macOS: /var is a link to /private/var
  root = join(tmp, "repo");
  mkdirSync(join(root, "data"), { recursive: true });
});
afterEach(() => {
  db.$client.close();
  rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
function seedPosting(id: string, description: string | null = `${SECRET} ${id}`): void {
  db.insert(postings)
    .values({
      id,
      source: "remoteok",
      external_id: id,
      url: `https://jobs.example.com/${id}`,
      title: `Title ${id}`,
      company_name: `Company ${id}`,
      description_text: description,
      location_text: "Remote",
      salary_text: null,
      first_seen_at: "2026-10-01T00:00:00.000Z",
      last_seen_at: "2026-10-01T00:00:00.000Z",
    })
    .run();
}
function review(
  posting_id: string,
  action: "interested" | "applied_manually" | "not_interested" | "later" | "reopen" | "scam",
  reason: (typeof reviews.$inferInsert)["reason"] = null,
  reviewed_at = "2026-10-10T05:00:00.000Z",
): void {
  seq += 1;
  db.insert(reviews)
    .values({
      id: `r${seq}`,
      posting_id,
      action,
      reason,
      reviewed_at,
      review_day: reviewed_at.slice(0, 10),
    })
    .run();
}

function run(args: string[] = [], repoRoot = root) {
  let out = "";
  let err = "";
  const code = runExportReviews({
    args,
    openDb: () => db,
    repoRoot,
    cwd: tmp,
    now: () => NOW,
    out: (t) => (out += t),
    err: (t) => (err += t),
  });
  return { code, out, err };
}

function seedMixed(): void {
  for (const id of ["a", "b", "c", "d", "e", "f", "g", "h", "i"]) seedPosting(id);
  review("a", "interested");
  review("b", "applied_manually");
  review("c", "not_interested", "role");
  review("d", "not_interested", "stack");
  review("e", "not_interested", "seniority");
  review("f", "not_interested", "salary"); // skipped: says nothing about fit
  review("g", "later"); // skipped: still open
  review("h", "interested");
  review("h", "reopen"); // skipped: open again
  review("i", "interested");
  review("i", "not_interested", "location", "2026-10-11T05:00:00.000Z"); // newest status wins: skipped
}

describe("eval:export-reviews", () => {
  it("maps reviews to bands, skips other reasons, and prints only the path and counts", () => {
    seedMixed();
    const outDir = join(tmp, "out");
    const r = run(["--out-dir", outDir]);
    const path = join(outDir, "reviews-2026-10-16.json");
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      `${path}\neval:export-reviews: 5 cases (high 2, low 3), skipped 2, without posting text 0\n`,
    );
    expect(r.out + r.err).not.toContain(SECRET);

    const set = FitSetSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(set.persona).toBe("owner");
    expect(Object.fromEntries(set.cases.map((c) => [c.id, c.expected]))).toEqual({
      a: "high",
      b: "high",
      c: "low",
      d: "low",
      e: "low",
    });
    const a = set.cases.find((c) => c.id === "a");
    expect(a).toMatchObject({
      title: "Title a",
      company: "Company a",
      location: "Remote",
      description: `${SECRET} a`,
    });
  });

  it("--since keeps only decisions made on or after the date (Jakarta day)", () => {
    seedPosting("old");
    seedPosting("new");
    review("old", "interested", null, "2026-10-01T05:00:00.000Z");
    review("new", "interested", null, "2026-10-12T05:00:00.000Z");
    const outDir = join(tmp, "out");
    const r = run(["--since", "2026-10-10", "--out-dir", outDir]);
    expect(r.code).toBe(0);
    const set = FitSetSchema.parse(
      JSON.parse(readFileSync(join(outDir, "reviews-2026-10-16.json"), "utf8")),
    );
    expect(set.cases.map((c) => c.id)).toEqual(["new"]);
  });

  it("rejects an invalid --since", () => {
    const r = run(["--since", "yesterday"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/invalid --since/);
  });

  it("counts reviewed postings without text and leaves them out", () => {
    seedPosting("t");
    seedPosting("empty", "  ");
    seedPosting("none", null);
    review("t", "interested");
    review("empty", "interested");
    review("none", "not_interested", "role");
    const r = run(["--out-dir", join(tmp, "out")]);
    expect(r.out).toContain("1 cases (high 1, low 0), skipped 0, without posting text 2");
  });

  it("exits 1 and writes nothing when no review qualifies", () => {
    seedPosting("x");
    review("x", "not_interested", "salary");
    const outDir = join(tmp, "out");
    const r = run(["--out-dir", outDir]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no usable reviews/);
    expect(() => readFileSync(join(outDir, "reviews-2026-10-16.json"))).toThrow();
  });

  it("defaults to <repo>/data/eval", () => {
    seedMixed();
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out.split("\n")[0]).toBe(join(root, "data", "eval", "reviews-2026-10-16.json"));
  });

  it("writes under data/ inside the repo but refuses anywhere else inside it", () => {
    seedMixed();
    expect(run(["--out-dir", join(root, "data", "custom")]).code).toBe(0);

    for (const bad of [
      root,
      join(root, "docs"),
      join(root, "fixtures", "eval"),
      join(root, "data", "..", "src"),
    ]) {
      const r = run(["--out-dir", bad]);
      expect(r.code).toBe(1);
      expect(r.err).toBe("eval:export-reviews: refusing to write inside the repo outside data/\n");
      expect(r.out).toBe("");
    }
    // A relative path resolves against cwd, here the repo's parent: "repo/docs" is inside the repo.
    expect(run(["--out-dir", "repo/docs"]).code).toBe(1);
  });

  it("refuses a symlink in data/ that points to the repo outside data/", () => {
    seedMixed();
    mkdirSync(join(root, "docs"));
    symlinkSync(join(root, "docs"), join(root, "data", "link"));
    const r = run(["--out-dir", join(root, "data", "link")]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/refusing to write inside the repo/);
  });

  it("prints help", () => {
    const r = run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("eval:fit --set data/eval/reviews-<date>.json --live");
  });

  it("is not confused by a repo path that is a prefix of the out dir's parent", () => {
    seedMixed();
    const sibling = `${resolve(root)}-other`;
    expect(run(["--out-dir", sibling]).code).toBe(0);
    rmSync(sibling, { recursive: true, force: true });
  });
});
