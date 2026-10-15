import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testInjectTimeAndSleep,
  analysis,
  apply_links,
  companies,
  log,
  openDb,
  postings,
  type Db,
} from "@job-agent/core";
import { runDigest } from "../digest/index.ts";
import { normalizeCompanyName } from "../normalize/index.ts";
import { getPostingDetail, getQueue } from "../review/queue.ts";
import { recordReview, ReviewInputSchema } from "../review/record.ts";
import { seedDemo } from "../seed-demo.ts";
import { runResolveApply } from "./index.ts";
import { OWNER_WRONG_REASON } from "./owner.ts";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

const T0 = new Date("2026-10-14T00:00:00.000Z");
const day = (n: number) => n * 24 * 60 * 60 * 1000;
const BOARD_URL = "https://boards.example-ats.test/acme/jobs/1";

let db: Db;
let clock: Date;
beforeEach(() => {
  db = openDb(":memory:");
  clock = T0;
  let t = 0;
  __testInjectTimeAndSleep(
    () => new Date(t),
    async (ms) => {
      t += ms;
    },
  );
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
  db.$client.close();
});

/** A kept posting of a company with a stored Greenhouse board that lists the posting's title. */
function seedPosting(): string {
  const companyId = randomUUID();
  db.insert(companies)
    .values({
      id: companyId,
      name: "Acme Labs",
      normalized_name: normalizeCompanyName("Acme Labs"),
      ats_type: "greenhouse",
      ats_slug: "acme",
      verified: true,
      created_at: T0.toISOString(),
    })
    .run();
  const id = "p-owner";
  db.insert(postings)
    .values({
      id,
      source: "remotive",
      external_id: id,
      url: "https://remotive.example.test/jobs/1",
      title: "Frontend Engineer",
      company_id: companyId,
      company_name: "Acme Labs",
      first_seen_at: "2026-10-13T00:00:00.000Z",
      last_seen_at: "2026-10-13T00:00:00.000Z",
      normalized_at: "2026-10-13T00:00:00.000Z",
    })
    .run();
  db.insert(analysis)
    .values({
      id: `a-${id}`,
      posting_id: id,
      location_class: "worldwide",
      indonesia_rule: "not_applicable",
      salary_status: "unknown",
      decision: "keep",
      analyzed_at: "2026-10-13T00:00:00.000Z",
    })
    .run();
  return id;
}

function boardGivesLink() {
  server.use(
    http.get("https://boards-api.greenhouse.io/v1/boards/acme/jobs", () =>
      HttpResponse.json({
        jobs: [{ id: 1, title: "Frontend Engineer", absolute_url: BOARD_URL }],
      }),
    ),
  );
}

async function resolveApply(): Promise<string> {
  const out: string[] = [];
  await runResolveApply({ db, now: () => clock, out: (t) => out.push(t) });
  return out.join("");
}

const link = (postingId: string) =>
  db.select().from(apply_links).where(eq(apply_links.posting_id, postingId)).get();

const review = (postingId: string, apply_url?: string) =>
  recordReview(
    db,
    ReviewInputSchema.parse({
      posting_id: postingId,
      action: "wrong_apply_link",
      ...(apply_url !== undefined ? { apply_url } : {}),
    }),
    clock,
  );

describe("wrong_apply_link with a URL", () => {
  it("stores an owner row with the decided type, reason and time", async () => {
    boardGivesLink();
    const p = seedPosting();
    await resolveApply();
    expect(link(p)).toMatchObject({ apply_url: BOARD_URL, method: "ats_board" });

    clock = new Date("2026-10-15T08:00:00.000Z");
    review(p, "https://jobs.lever.co/acme/1234");
    expect(link(p)).toMatchObject({
      apply_url: "https://jobs.lever.co/acme/1234",
      apply_type: "ats",
      method: "owner",
      ats_type: "lever",
      reason: "owner correction 2026-10-15",
      checked_at: "2026-10-15T08:00:00.000Z",
    });
  });

  it("inserts a row when none exists, and decides a paid-only host as paid_aggregator", () => {
    const p = seedPosting();
    review(p, "https://www.example-form.test/apply");
    expect(link(p)).toMatchObject({ method: "owner", found_on: "remotive" });
    review(p, "https://www.flexjobs.com/jobs/1");
    expect(link(p)?.apply_type).toBe("paid_aggregator");
  });

  it("applies the correction to the canonical posting of a duplicate", () => {
    const p = seedPosting();
    db.insert(postings)
      .values({
        id: "p-dup",
        source: "himalayas",
        external_id: "dup",
        url: "https://himalayas.example.test/jobs/1",
        title: "Frontend Engineer",
        company_name: "Acme Labs",
        first_seen_at: "2026-10-13T00:00:00.000Z",
        last_seen_at: "2026-10-13T00:00:00.000Z",
        canonical_posting_id: p,
      })
      .run();
    review("p-dup", "https://jobs.lever.co/acme/1");
    expect(link(p)?.method).toBe("owner");
    expect(link("p-dup")).toBeUndefined();
  });

  it("rejects a non-http(s) URL before anything is stored", () => {
    for (const bad of ["javascript:alert(1)", "ftp://a.example.com/x", "not a url"]) {
      expect(
        ReviewInputSchema.safeParse({
          posting_id: "p",
          action: "wrong_apply_link",
          apply_url: bad,
        }).success,
      ).toBe(false);
    }
  });
});

describe("resolve-apply and owner rows", () => {
  it("never overwrites an owner row, even long after and with a board that gives another link", async () => {
    boardGivesLink();
    const p = seedPosting();
    review(p, "https://jobs.lever.co/acme/1234");
    const before = link(p);

    clock = new Date(T0.getTime() + day(30));
    const out = await resolveApply();
    expect(out).toMatch(/checked 0,/);
    expect(link(p)).toEqual(before);
    expect(link(p)?.apply_url).not.toBe(BOARD_URL);
  });

  it("skips an owner row stored as unknown after the recheck window", async () => {
    const p = seedPosting();
    db.update(companies).set({ domain: "acme.example" }).run();
    review(p, "https://elsewhere.example/apply"); // not the company domain: type unknown
    expect(link(p)).toMatchObject({ method: "owner", apply_type: "unknown" });
    clock = new Date(T0.getTime() + day(30));
    expect(await resolveApply()).toMatch(/checked 0,/);
    expect(link(p)?.method).toBe("owner");
  });
});

describe("wrong_apply_link without a URL", () => {
  it("resets the row, re-resolves once, and keeps the same URL as unknown 'owner marked wrong'", async () => {
    boardGivesLink();
    const p = seedPosting();
    await resolveApply();
    expect(link(p)).toMatchObject({ apply_url: BOARD_URL, apply_type: "ats" });

    review(p);
    expect(link(p)).toMatchObject({
      apply_url: BOARD_URL,
      apply_type: "unknown",
      method: "source",
      reason: OWNER_WRONG_REASON,
    });

    const out = await resolveApply(); // same day: the reset row is due at once
    expect(out).toMatch(/checked 1,/);
    expect(link(p)).toMatchObject({
      apply_url: BOARD_URL,
      apply_type: "unknown",
      method: "source",
      reason: OWNER_WRONG_REASON,
      checked_at: T0.toISOString(),
    });
    expect(link(p)?.ats_type).toBeNull();

    // Once only: it is not taken again until the usual 7 days.
    expect(await resolveApply()).toMatch(/checked 0,/);
  });

  it("stores a different URL normally when the re-resolve finds one", async () => {
    boardGivesLink();
    const p = seedPosting();
    db.insert(apply_links)
      .values({
        id: "old",
        posting_id: p,
        apply_url: "https://jobs.lever.co/acme/old",
        apply_type: "ats",
        method: "careers_page",
        found_on: "remotive",
        checked_at: "2026-10-01T00:00:00.000Z",
      })
      .run();
    review(p);
    await resolveApply();
    expect(link(p)).toMatchObject({ apply_url: BOARD_URL, apply_type: "ats", method: "ats_board" });
    expect(link(p)?.reason).toBeNull();
  });

  it("does nothing to links when no row exists", () => {
    const p = seedPosting();
    review(p);
    expect(link(p)).toBeUndefined();
  });
});

describe("digest and queue show the corrected link", () => {
  it("queue, posting detail and digest carry the owner URL and type", () => {
    const date = "2026-03-10";
    seedDemo(db, date);
    const top = getQueue(db, date).sections.top[0];
    const id = top?.postingId ?? "";
    expect(top?.applyUrl).not.toBe("https://jobs.lever.co/demo/777");
    recordReview(
      db,
      ReviewInputSchema.parse({
        posting_id: id,
        action: "wrong_apply_link",
        apply_url: "https://jobs.lever.co/demo/777",
      }),
      new Date("2026-03-10T09:30:00.000Z"),
    );
    const item = getQueue(db, date).sections.top.find((i) => i.postingId === id);
    expect(item).toMatchObject({ applyUrl: "https://jobs.lever.co/demo/777", applyType: "ats" });
    expect(getPostingDetail(db, id)).toMatchObject({
      applyUrl: "https://jobs.lever.co/demo/777",
      applyType: "ats",
    });
    const outDir = mkdtempSync(join(tmpdir(), "owner-digest-"));
    runDigest({ db, date, outDir, out: () => undefined });
    expect(readFileSync(join(outDir, `${date}.md`), "utf8")).toContain(
      "- Apply: https://jobs.lever.co/demo/777 (ats)",
    );
  });
});
