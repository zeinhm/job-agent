import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "@job-agent/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordReview } from "../review/record.ts";
import { seedDemo } from "../seed-demo.ts";
import { runDigest } from "./index.ts";
import { selectDay } from "./selection.ts";

const DATE = "2026-03-10";
const NOW = new Date("2026-03-10T05:00:00Z");
const URL_LINE = "http://127.0.0.1:4510/";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "job-agent-reviewed-"));
  db = openDb(":memory:");
  seedDemo(db, DATE);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const digest = () =>
  readFileSync(runDigest({ db, date: DATE, outDir: dir, out: () => {} }), "utf8");

const review = (posting_id: string, action: "interested" | "later" | "ask_ok") =>
  recordReview(db, { posting_id, action }, NOW);

const section = (md: string, heading: string) => {
  const start = md.indexOf(`## ${heading}\n`);
  const next = md.indexOf("\n## ", start + 1);
  return md.slice(start, next < 0 ? undefined : next);
};

describe("digest review state", () => {
  it("is unchanged without review rows: no review line, same bytes as the stored demo digest", () => {
    const md = digest();
    expect(md).not.toContain("Reviewed:");
    expect(md).toBe(
      readFileSync(
        new URL("../../test/fixtures/digest/demo-2026-03-10.md", import.meta.url),
        "utf8",
      ),
    );
  });

  it("drops processed postings from Top matches and Needs a look and adds the review line", () => {
    const before = digest();
    const day = selectDay(db, DATE, { stamp: false });
    const [a, b] = day.top;
    if (a === undefined || b === undefined) throw new Error("demo seed needs two top matches");
    review(a.view.postingId, "interested");
    review(b.view.postingId, "later");

    const after = digest();
    const open = day.top.length + day.waiting.length + day.suspicious.length - 1;
    expect(after.split("\n").slice(0, 3)).toEqual([
      `# Job digest ${DATE}`,
      "",
      `Reviewed: 1 processed, ${open} open — ${URL_LINE}`,
    ]);
    const topAfter = section(after, "Top matches");
    expect(section(before, "Top matches")).toContain(a.title);
    expect(topAfter).not.toContain(`### ${a.title} — ${a.company}`);
    expect(topAfter).toContain(`### ${b.title} — ${b.company}`); // `later` stays
    expect(after).toContain(`- Top matches: ${day.top.length - 1}`);
    expect(section(after, "Needs a look")).not.toContain(`- ${a.title} — ${a.company}:`);
  });

  it("keeps a posting whose only review row is a correction or ask check", () => {
    const first = selectDay(db, DATE, { stamp: false }).top[0];
    if (first === undefined) throw new Error("demo seed needs a top match");
    review(first.view.postingId, "ask_ok");
    const md = digest();
    expect(section(md, "Top matches")).toContain(`### ${first.title} — ${first.company}`);
    expect(md).toMatch(/^Reviewed: 0 processed, \d+ open — /m);
  });
});
