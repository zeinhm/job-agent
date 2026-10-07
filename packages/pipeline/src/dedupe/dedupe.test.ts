import { beforeEach, describe, expect, it } from "vitest";
import { openDb, postings, type Db, type NewPosting } from "@job-agent/core";
import { dedupePending, normalizeTitle } from "./index.ts";
import { normalizePending } from "../normalize/index.ts";

describe("normalizeTitle", () => {
  it("strips remote/full-time/contract tokens and punctuation, keeps seniority", () => {
    expect(normalizeTitle("Senior Frontend Engineer (Remote)")).toBe("senior frontend engineer");
    expect(normalizeTitle("Senior Frontend Engineer - Remote")).toBe("senior frontend engineer");
    expect(normalizeTitle("Frontend  Engineer, Full-Time")).toBe("frontend engineer");
    expect(normalizeTitle("Frontend Engineer (Contract)")).toBe("frontend engineer");
    expect(normalizeTitle("Senior Frontend Engineer")).not.toBe(
      normalizeTitle("Frontend Engineer"),
    );
  });
});

describe("dedupePending", () => {
  let db: Db;
  let n = 0;
  const day = (d: number) => new Date(Date.UTC(2026, 0, 1 + d)).toISOString();

  function add(source: string, company: string, title: string, firstSeenDay = 0, id?: string) {
    n += 1;
    const row: NewPosting = {
      id: id ?? `p${n}`,
      source,
      external_id: `e${n}`,
      url: `https://example.com/${n}`,
      title,
      company_name: company,
      first_seen_at: day(firstSeenDay),
      last_seen_at: day(firstSeenDay),
    };
    db.insert(postings).values(row).run();
    return row.id;
  }

  function run() {
    normalizePending(db);
    return dedupePending(db);
  }

  function state() {
    return Object.fromEntries(
      db
        .select()
        .from(postings)
        .all()
        .map((p) => [p.id, p.canonical_posting_id]),
    );
  }

  beforeEach(() => {
    db = openDb(":memory:");
    n = 0;
  });

  it("merges Remotive + Greenhouse, Greenhouse canonical", () => {
    const r = add("remotive", "Acme Inc", "Senior Frontend Engineer (Remote)", 0, "r");
    const g = add("greenhouse", "Acme", "Senior Frontend Engineer", 1, "g");
    expect(run()).toBe(2);
    expect(state()).toEqual({ [r]: g, [g]: null });
    const hashes = db
      .select()
      .from(postings)
      .all()
      .map((p) => p.dedupe_hash);
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes[0]).toBe(hashes[1]);
  });

  it("does not merge same-source postings", () => {
    const a = add("greenhouse", "Acme", "Backend Engineer", 0, "a");
    const b = add("greenhouse", "Acme", "Backend Engineer", 0, "b");
    run();
    expect(state()).toEqual({ [a]: null, [b]: null });
  });

  it("does not merge different titles (seniority kept)", () => {
    const a = add("remotive", "Acme", "Senior Frontend Engineer", 0, "a");
    const b = add("greenhouse", "Acme", "Frontend Engineer", 0, "b");
    run();
    expect(state()).toEqual({ [a]: null, [b]: null });
  });

  it("promotes a better-ranked later arrival and re-points members without chains", () => {
    const r = add("remotive", "Acme", "Platform Engineer", 0, "r");
    const h = add("hn", "Acme", "Platform Engineer", 1, "h");
    run();
    expect(state()).toEqual({ [r]: null, [h]: r });

    const a = add("ashby", "Acme", "Platform Engineer", 5, "a");
    run();
    expect(state()).toEqual({ [a]: null, [r]: a, [h]: a });
  });

  it("never merges unknown-company postings but still hashes them", () => {
    const a = add("hn", "Unknown", "Rust Developer", 0, "a");
    const b = add("hn", "Unknown", "Rust Developer", 0, "b");
    const c = add("remotive", "Unknown", "Rust Developer", 0, "c");
    run();
    expect(state()).toEqual({ [a]: null, [b]: null, [c]: null });
    expect(
      db
        .select()
        .from(postings)
        .all()
        .every((p) => p.dedupe_hash !== null),
    ).toBe(true);
  });

  it("does not merge postings 90 days apart, merges within 60", () => {
    const a = add("remotive", "Acme", "Data Engineer", 0, "a");
    const b = add("greenhouse", "Acme", "Data Engineer", 90, "b");
    const c = add("lever", "Other", "Data Engineer", 0, "c");
    const d = add("remoteok", "Other", "Data Engineer", 60, "d");
    run();
    expect(state()).toEqual({ [a]: null, [b]: null, [c]: null, [d]: c });
  });

  it("breaks ties by earliest first_seen_at, then lowest id", () => {
    const x = add("remotive", "Acme", "QA Engineer", 3, "x");
    const y = add("remoteok", "Acme", "QA Engineer", 1, "y");
    run();
    expect(state()).toEqual({ [x]: y, [y]: null });

    const m = add("lever", "Beta", "QA Engineer", 2, "m");
    const k = add("ashby", "Beta", "QA Engineer", 2, "k");
    run();
    expect(state()).toMatchObject({ [m]: k, [k]: null });
  });

  it("is idempotent", () => {
    add("remotive", "Acme", "Senior Frontend Engineer (Remote)", 0);
    add("greenhouse", "Acme", "Senior Frontend Engineer", 1);
    run();
    const before = db.select().from(postings).all();
    expect(run()).toBe(0);
    expect(db.select().from(postings).all()).toEqual(before);
  });

  it("skips postings that are not normalized yet", () => {
    add("remotive", "Acme", "Engineer");
    expect(dedupePending(db)).toBe(0);
  });
});
