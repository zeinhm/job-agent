import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  analysis,
  answer_bank,
  apply_links,
  APPLY_TYPES,
  companies,
  intel,
  openDb,
  posting_questions,
  postings,
} from "@job-agent/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli.ts";
import { runDigest } from "./digest/index.ts";
import { NonDemoDbError, seedDemo } from "./seed-demo.ts";

const DATE = "2026-03-10";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) } };
}

afterEach(() => vi.unstubAllEnvs());

function sectionBody(md: string, heading: string): string {
  const start = md.indexOf(`## ${heading}\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = md.slice(start + heading.length + 4);
  const next = rest.indexOf("\n## ");
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

describe("seed-demo data", () => {
  it("fills every digest section and covers each apply type", () => {
    const dir = mkdtempSync(join(tmpdir(), "job-agent-seed-"));
    try {
      const db = openDb(":memory:");
      seedDemo(db, DATE);
      const path = runDigest({ db, date: DATE, outDir: dir, capUsd: 1, out: () => {} });
      const md = readFileSync(path, "utf8");
      for (const heading of ["Top matches", "Needs a look", "Suspicious", "Waiting for scoring"]) {
        const body = sectionBody(md, heading);
        expect(body, heading).not.toBe("");
        expect(body, heading).not.toMatch(/^(None\.|None scored yet\.)$/);
      }
      const types = db
        .select()
        .from(apply_links)
        .all()
        .map((l) => l.apply_type);
      expect(new Set(types)).toEqual(new Set(APPLY_TYPES));
      expect(db.select().from(posting_questions).all().length).toBeGreaterThan(0);
      expect(
        db
          .select()
          .from(intel)
          .all()
          .some((i) => i.scam_reasons !== "[]"),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses fake data only", () => {
    const db = openDb(":memory:");
    seedDemo(db, DATE);
    for (const p of db.select().from(postings).all()) expect(p.url).toContain(".example.com/");
  });

  it("is idempotent for a date and adds a new day for another date", () => {
    const db = openDb(":memory:");
    const counts = () => [
      db.select().from(postings).all().length,
      db.select().from(analysis).all().length,
      db.select().from(intel).all().length,
      db.select().from(apply_links).all().length,
      db.select().from(posting_questions).all().length,
    ];
    const first = seedDemo(db, DATE);
    expect(first.postings).toBeGreaterThan(0);
    const before = counts();
    const second = seedDemo(db, DATE);
    expect(second).toEqual({ postings: 0, questions: 0 });
    expect(counts()).toEqual(before);
    expect(seedDemo(db, "2026-03-11").postings).toBe(first.postings);
  });
});

describe("seed-demo command", () => {
  it("seeds a scratch DB and prints counts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "job-agent-seed-"));
    try {
      vi.stubEnv("JOB_AGENT_DB", join(dir, "smoke.db"));
      const c = capture();
      expect(await main(["seed-demo", "--date", DATE], c.io)).toBe(0);
      expect(c.out.join("")).toContain(`seed-demo ${DATE}: added`);
      const c2 = capture();
      expect(await main(["seed-demo", "--date", DATE], c2.io)).toBe(0);
      expect(c2.out.join("")).toContain("added 0 postings, 0 questions");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a bad date with exit 1", async () => {
    vi.stubEnv("JOB_AGENT_DB", ":memory:");
    const c = capture();
    expect(await main(["seed-demo", "--date", "2026-13-40"], c.io)).toBe(1);
  });

  const refused: [string, string | undefined][] = [
    ["data/job-agent.db", "data/job-agent.db"],
    ["a path under data/", "data/tmp/x.db"],
    ["an absolute path under the repo's data/", resolve("data", "nested", "x.db")],
    ["no JOB_AGENT_DB (default)", undefined],
  ];
  for (const kind of [
    "file symlink",
    "directory symlink",
    "file in a new subdir of a symlinked dir",
  ]) {
    it(`refuses with exit 2 and creates nothing: ${kind} into data/`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "job-agent-seed-"));
      const target = resolve("data", `seed-demo-test-${process.pid}`);
      try {
        let db: string;
        if (kind === "file symlink") {
          symlinkSync(join(target, "x.db"), join(dir, "link.db"));
          db = join(dir, "link.db");
        } else {
          symlinkSync(target, join(dir, "linkdir"));
          db =
            kind === "directory symlink"
              ? join(dir, "linkdir", "x.db")
              : join(dir, "linkdir", "sub", "x.db");
        }
        vi.stubEnv("JOB_AGENT_DB", db);
        const c = capture();
        expect(await main(["seed-demo"], c.io)).toBe(2);
        expect(c.err.join("")).toMatch(/^seed-demo: refusing to write a database under data\//);
        expect(existsSync(target)).toBe(false);
        expect(existsSync(join(dir, "link.db"))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("a symlink to a scratch dir is still allowed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "job-agent-seed-"));
    try {
      mkdirSync(join(dir, "real"));
      symlinkSync(join(dir, "real"), join(dir, "link"));
      vi.stubEnv("JOB_AGENT_DB", join(dir, "link", "smoke.db"));
      expect(await main(["seed-demo", "--date", DATE], capture().io)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a DB holding a non-demo posting: exit 1, one stderr line, nothing written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "job-agent-seed-"));
    try {
      const path = join(dir, "smoke.db");
      const db = openDb(path);
      db.insert(postings)
        .values({
          id: "real-1",
          source: "remotive",
          external_id: "1",
          url: "https://remotive.example.test/1",
          title: "Engineer",
          company_name: "Acme",
          first_seen_at: "2026-03-01T00:00:00.000Z",
          last_seen_at: "2026-03-01T00:00:00.000Z",
        })
        .run();
      const counts = () =>
        [postings, analysis, intel, apply_links, posting_questions, companies, answer_bank].map(
          (t) => db.select().from(t).all().length,
        );
      const before = counts();
      db.$client.close();
      vi.stubEnv("JOB_AGENT_DB", path);
      const c = capture();
      expect(await main(["seed-demo", "--date", DATE], c.io)).toBe(1);
      expect(c.out.join("")).toBe("");
      expect(c.err.join("")).toMatch(
        /^seed-demo: refusing to write, the database holds 1 non-demo posting\(s\)[^\n]*\n$/,
      );
      const again = openDb(path);
      expect(
        [postings, analysis, intel, apply_links, posting_questions, companies, answer_bank].map(
          (t) => again.select().from(t).all().length,
        ),
      ).toEqual(before);
      again.$client.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("seedDemo itself throws on a non-demo posting and writes nothing", () => {
    const db = openDb(":memory:");
    db.insert(postings)
      .values({
        id: "real-1",
        source: "remotive",
        external_id: "1",
        url: "https://remotive.example.test/1",
        title: "Engineer",
        company_name: "Acme",
        first_seen_at: "2026-03-01T00:00:00.000Z",
        last_seen_at: "2026-03-01T00:00:00.000Z",
      })
      .run();
    expect(() => seedDemo(db, DATE)).toThrow(NonDemoDbError);
    expect(db.select().from(postings).all()).toHaveLength(1);
    expect(db.select().from(companies).all()).toHaveLength(0);
  });

  for (const [name, value] of refused) {
    it(`refuses with exit 2: ${name}`, async () => {
      vi.stubEnv("JOB_AGENT_DB", value);
      const c = capture();
      expect(await main(["seed-demo"], c.io)).toBe(2);
      expect(c.err.join("")).toMatch(/^seed-demo: refusing to write /);
      expect(c.out.join("")).toBe("");
    });
  }
});
