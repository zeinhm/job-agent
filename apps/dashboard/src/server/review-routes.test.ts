import { beforeEach, describe, expect, it } from "vitest";
import { openDb, reviews, type Db, type SalaryConfig } from "@job-agent/core";
import { seedDemo } from "@job-agent/pipeline/seed-demo";
import { getStats } from "@job-agent/pipeline/review";
import { createApp } from "./app.ts";

const PORT = 4510;
const HOST = `127.0.0.1:${PORT}`;
const DATE = "2026-03-10";
const TOP = `demo-${DATE}-top-ats`;
const NOW = new Date("2026-03-10T09:30:00.000Z");

let db: Db;
let logs: string[];
beforeEach(() => {
  db = openDb(":memory:");
  seedDemo(db, DATE);
  logs = [];
});

// Fake salary config (the dashboard reads the owner's salary.yaml; tests never do).
const SALARY: SalaryConfig = {
  floor_idr_month: 10_000_000,
  position_in_listed_range: 0.5,
  tiers: {
    indonesia: { ask_idr_month: 12_000_000 },
    regional: { ask_idr_month: 20_000_000 },
    global_adjusted: { ask_idr_month: 30_000_000 },
    global_flat: { ask_usd_year: 60_000 },
  },
  unknown_policy: "ask",
  text_field_answer: "negotiable",
  review_salary_answers: true,
};
const app = () =>
  createApp(db, {
    port: PORT,
    now: () => NOW,
    salary: () => SALARY,
    logError: (l) => logs.push(l),
  });
const get = (path: string) => app().request(`http://x${path}`, { headers: { Host: HOST } });
const post = (body: unknown, raw = false) =>
  app().request("http://x/api/reviews", {
    method: "POST",
    headers: { Host: HOST, "Content-Type": "application/json", Origin: `http://${HOST}` },
    body: raw ? (body as string) : JSON.stringify(body),
  });

describe("GET /api/queue", () => {
  it("returns the sections with the fields the dashboard shows", async () => {
    const res = await get(`/api/queue?date=${DATE}`);
    expect(res.status).toBe(200);
    const q = (await res.json()) as {
      date: string;
      sections: Record<string, Record<string, unknown>[]>;
    };
    expect(q.date).toBe(DATE);
    expect(Object.keys(q.sections)).toEqual(["top", "needs_a_look", "suspicious", "waiting"]);
    expect(q.sections["top"]).toHaveLength(4);
    expect(q.sections["needs_a_look"]).toHaveLength(2);
    expect(q.sections["suspicious"]).toHaveLength(1);
    expect(q.sections["waiting"]).toHaveLength(2);
    expect(q.sections["top"]?.[0]).toEqual({
      postingId: TOP,
      kind: "top",
      title: "Senior Backend Engineer",
      company: "Northwind Demo Labs",
      locations: ["Remote, worldwide"],
      locationClass: "worldwide",
      fitScore: 88,
      fitReasons: expect.any(Array),
      flags: [],
      tier: "global_flat",
      ask: "IDR 88.0M / month | USD 66,000 / year",
      askText: null,
      listedSalary: "IDR 60.0M–80.0M / month",
      scamScore: expect.anything(),
      scamReason: null,
      applyUrl: "https://northwind-demo.example.com/jobs/top-ats",
      applyType: "ats",
      postedAt: expect.any(String),
      firstSeenAt: expect.any(String),
      sources: ["greenhouse"],
      review: { status: "open", reason: null, reviewedAt: null, processed: false },
    });
    expect(q.sections["suspicious"]?.[0]).toMatchObject({ scamScore: 85 });
    expect(q.sections["suspicious"]?.[0]?.["scamReason"]).toBe("asks for a payment before hiring");
  });

  it("defaults to today in Asia/Jakarta", async () => {
    const q = (await (await get("/api/queue")).json()) as { date: string };
    expect(q.date).toBe("2026-03-10");
  });

  it("is empty for a day with no matches", async () => {
    const q = (await (await get("/api/queue?date=2026-01-01")).json()) as {
      sections: Record<string, unknown[]>;
    };
    expect(Object.values(q.sections).flat()).toEqual([]);
  });

  it("400s a bad or unknown query without echoing values", async () => {
    for (const qs of ["date=2026-13-40", "date=yesterday", "date=", "x=1"]) {
      const res = await get(`/api/queue?${qs}`);
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).not.toContain("yesterday");
    }
  });

  it("does not write anything", async () => {
    await get(`/api/queue?date=${DATE}`);
    expect(db.select().from(reviews).all()).toHaveLength(0);
  });
});

describe("GET /api/postings/:id", () => {
  it("adds description, all reasons and review history", async () => {
    await post({ posting_id: TOP, action: "later" });
    const res = await get(`/api/postings/${TOP}`);
    expect(res.status).toBe(200);
    const d = (await res.json()) as Record<string, unknown>;
    expect(d).toMatchObject({
      postingId: TOP,
      title: "Senior Backend Engineer",
      review: { status: "later", processed: false },
    });
    expect(typeof d["descriptionText"]).toBe("string");
    expect(Object.keys(d["reasons"] as object)).toEqual(["fit", "scam", "resolved", "rules"]);
    expect((d["history"] as { action: string }[]).map((h) => h.action)).toEqual(["later"]);
  });

  it("404s an unknown posting", async () => {
    expect((await get("/api/postings/nope")).status).toBe(404);
  });
});

describe("POST /api/reviews", () => {
  it("records a review and returns the row and the new state (201)", async () => {
    const res = await post({ posting_id: TOP, action: "interested" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      review: { posting_id: string; fit_score: number };
      state: unknown;
    };
    expect(body.review).toMatchObject({ posting_id: TOP, action: "interested", fit_score: 88 });
    expect(body.state).toEqual({
      status: "interested",
      reason: null,
      reviewedAt: NOW.toISOString(),
      processed: true,
    });
    const q = (await (await get(`/api/queue?date=${DATE}`)).json()) as {
      sections: { top: { review: { status: string } }[] };
    };
    expect(q.sections.top[0]?.review.status).toBe("interested");
  });

  it("not_interested with a reason, wrong_apply_link with a URL, pay_policy", async () => {
    expect((await post({ posting_id: TOP, action: "not_interested", reason: "role" })).status).toBe(
      201,
    );
    expect(
      (
        await post({
          posting_id: TOP,
          action: "wrong_apply_link",
          apply_url: "https://ok.example.com/apply",
        })
      ).status,
    ).toBe(201);
    expect(
      (await post({ posting_id: TOP, action: "pay_policy", pay_policy: "location_adjusted" }))
        .status,
    ).toBe(201);
    const rows = db.select().from(reviews).all();
    expect(rows.map((r) => r.action).sort()).toEqual([
      "not_interested",
      "pay_policy",
      "wrong_apply_link",
    ]);
  });

  it("pay_policy sets the company's registry row with an owner source", async () => {
    const res = await post({
      posting_id: TOP,
      action: "pay_policy",
      pay_policy: "location_agnostic",
    });
    expect(res.status).toBe(201);
    const company = db.$client
      .prepare("select c.* from companies c join postings p on p.company_id = c.id where p.id = ?")
      .get(TOP);
    expect(company).toMatchObject({
      pay_policy: "location_agnostic",
      pay_policy_source: "owner:2026-03-10",
      pay_policy_checked_at: NOW.toISOString(),
    });
  });

  it("pay_policy on a posting without a company is a 400 and stores nothing", async () => {
    db.$client.prepare("update postings set company_id = null where id = ?").run(TOP);
    const res = await post({
      posting_id: TOP,
      action: "pay_policy",
      pay_policy: "location_agnostic",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "posting has no company" });
    expect(db.select().from(reviews).all()).toHaveLength(0);
  });

  it("maps a non-canonical id to the canonical posting", async () => {
    const { postings } = await import("@job-agent/core");
    db.insert(postings)
      .values({
        id: "dup-1",
        source: "remoteok",
        external_id: "d1",
        url: "https://dup.example.com/1",
        title: "Senior Backend Engineer",
        company_name: "Northwind Demo Labs",
        first_seen_at: "2026-03-10T03:00:00.000Z",
        last_seen_at: "2026-03-10T03:00:00.000Z",
        canonical_posting_id: TOP,
      })
      .run();
    const res = await post({ posting_id: "dup-1", action: "interested" });
    expect(((await res.json()) as { review: { posting_id: string } }).review.posting_id).toBe(TOP);
  });

  it("400s validation failures with paths only", async () => {
    const bad: unknown[] = [
      { posting_id: TOP, action: "not_interested" },
      { posting_id: TOP, action: "not_interested", reason: "other" },
      { posting_id: TOP, action: "pay_policy" },
      { posting_id: TOP, action: "interested", reason: "role" },
      { posting_id: TOP, action: "wrong_apply_link", apply_url: "javascript:alert(1)" },
      { posting_id: TOP, action: "bogus" },
      { posting_id: TOP, action: "interested", extra: "SECRET-VALUE" },
      { action: "interested" },
      [],
    ];
    for (const b of bad) {
      const res = await post(b);
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).not.toMatch(/SECRET-VALUE|javascript/);
    }
    expect(db.select().from(reviews).all()).toHaveLength(0);
  });

  it("names the failing field", async () => {
    const res = await post({ posting_id: TOP, action: "not_interested", reason: "other" });
    expect(await res.json()).toEqual({ error: "invalid request", issues: [{ path: "note" }] });
  });

  it("400s a body that is not JSON", async () => {
    expect((await post("{nope", true)).status).toBe(400);
  });

  it("404s an unknown posting", async () => {
    expect((await post({ posting_id: "nope", action: "interested" })).status).toBe(404);
  });

  it("keeps the mutation guard: a cross-origin POST is 403", async () => {
    const res = await app().request("http://x/api/reviews", {
      method: "POST",
      headers: { Host: HOST, "Content-Type": "application/json", Origin: "http://evil.example" },
      body: JSON.stringify({ posting_id: TOP, action: "interested" }),
    });
    expect(res.status).toBe(403);
    expect(db.select().from(reviews).all()).toHaveLength(0);
  });
});

describe("GET /api/stats", () => {
  it("matches the stats function for the date, with the last 7 days", async () => {
    await post({ posting_id: TOP, action: "interested" });
    await post({ posting_id: TOP, action: "ask_ok" });
    const res = await get(`/api/stats?date=${DATE}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { week: { date: string }[] };
    expect(body).toEqual(JSON.parse(JSON.stringify(getStats(db, DATE))));
    expect(body).toMatchObject({
      date: DATE,
      matches: 5,
      processed: 1,
      open: 4,
      elapsedMinutes: 0,
      doneWhenMet: false,
      actions: { interested: 1, ask_ok: 1 },
    });
    expect(body.week).toHaveLength(7);
    expect(body.week[6]?.date).toBe(DATE);
  });

  it("defaults to today (Jakarta) and rejects a bad date", async () => {
    expect(((await (await get("/api/stats")).json()) as { date: string }).date).toBe(DATE);
    expect((await get("/api/stats?date=2026-02-30")).status).toBe(400);
    expect((await get("/api/stats?date=2026-03-10&x=1")).status).toBe(400);
  });
});
