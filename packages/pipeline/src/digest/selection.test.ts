import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analysis, openDb, type Db } from "@job-agent/core";
import { seedDemo } from "../seed-demo.ts";
import { runDigest } from "./index.ts";
import { selectDay } from "./selection.ts";

const DATE = "2026-03-10";
const GOLDEN = new URL("../../test/fixtures/digest/demo-2026-03-10.md", import.meta.url);

let db: Db;
let dir: string;
beforeEach(() => {
  db = openDb(":memory:");
  dir = mkdtempSync(join(tmpdir(), "digest-sel-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("shared day selection", () => {
  it("digest of the seeded demo DB is byte-identical to the pre-refactor output", () => {
    seedDemo(db, DATE);
    const path = runDigest({
      db,
      date: DATE,
      outDir: dir,
      now: () => new Date("2026-03-10T08:00:00Z"),
      capUsd: 1,
      out: () => {},
    });
    expect(readFileSync(path, "utf8")).toBe(readFileSync(GOLDEN, "utf8"));
  });

  it("selects the sections and the digest lists the same postings", () => {
    seedDemo(db, DATE);
    const day = selectDay(db, DATE, { stamp: false });
    expect(day.top.map((e) => e.title)).toEqual([
      "Senior Backend Engineer",
      "Full-stack Developer",
      "Staff Software Engineer",
      "Platform Engineer",
    ]);
    expect(day.notAFit).toHaveLength(1);
    expect(day.waiting).toHaveLength(2);
    expect(day.suspicious.map((e) => e.title)).toEqual(["Data Entry Assistant (earn fast)"]);
    expect(day.needsALook.map((e) => e.title)).toEqual([
      "Staff Software Engineer",
      "Site Reliability Engineer",
    ]);
  });

  it("does not write when stamp is off, and stamps when it is on", () => {
    seedDemo(db, DATE);
    db.update(analysis).set({ digested_at: null }).run();
    expect(selectDay(db, DATE, { stamp: false }).top).toHaveLength(0);
    expect(
      db
        .select()
        .from(analysis)
        .all()
        .every((a) => a.digested_at === null),
    ).toBe(true);
    expect(selectDay(db, DATE, { stamp: true }).top.length).toBeGreaterThan(0);
  });

  it("gives each entry its structured view", () => {
    seedDemo(db, DATE);
    const top = selectDay(db, DATE, { stamp: false }).top[0];
    expect(top?.view).toMatchObject({
      kind: "top",
      title: "Senior Backend Engineer",
      company: "Northwind Demo Labs",
      fitScore: 88,
      tier: "global_flat",
      applyType: "ats",
      locations: ["Remote, worldwide"],
    });
    expect(top?.view.fitReasons.length).toBeGreaterThan(0);
  });
});
