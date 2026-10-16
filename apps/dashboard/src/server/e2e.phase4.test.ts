import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { __testInjectTimeAndSleep, log, openDb, type Db, type SalaryConfig } from "@job-agent/core";
import { main } from "@job-agent/pipeline";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";

// Phase 4 chain, offline: seed-demo -> answers import -> fetch-questions (recorded Greenhouse fixture via msw) ->
// match-questions -> queue API -> review every match (mixed actions, a link correction, a pay-policy mark) ->
// inbox answer -> stats -> digest. Everything runs in a temp dir with a fake persona; nothing reads config/ or data/.

const DATE = "2026-10-14";
const PORT = 4510;
const HOST = `127.0.0.1:${PORT}`;
const START = new Date("2026-10-14T06:00:00Z");
const FIXTURE = fileURLToPath(
  new URL(
    "../../../../packages/pipeline/test/fixtures/questions/greenhouse-job.json",
    import.meta.url,
  ),
);
const GH_JOB = "https://boards-api.greenhouse.io/v1/boards/northwind-demo/jobs/8860302002";

// Fake numbers; only read when a pay-policy mark recomputes tiers.
const SALARY: SalaryConfig = {
  floor_idr_month: 10_000_000,
  position_in_listed_range: 0.5,
  tiers: {
    indonesia: { ask_idr_month: 8_000_000 },
    regional: { ask_idr_month: 20_000_000 },
    global_adjusted: { ask_idr_month: 30_000_000 },
    global_flat: { ask_usd_year: 60_000 },
  },
  unknown_policy: "ask",
  text_field_answer: "negotiable",
  review_salary_answers: true,
};

// identity.full_name collides with the seeded dashboard answer (kept); the visa answer is approved, the other is not.
const ANSWERS_YAML = `identity:
  full_name:
    answer: Alex Example
    approved: true
    question: Full name
work:
  visa:
    answer: "No"
    approved: true
    type: yes_no
    question: Will you now or in the future require sponsorship for a visa to remain in your current location?
  former_employee:
    answer: "No"
    approved: false
    type: yes_no
    question: Have you previously worked at or consulted for GitLab?
`;

const RESIDENCE = "What is your current country of residence?";
const FORMER = "Have you previously worked at or consulted for GitLab?";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

let dir: string;
let dbPath: string;
let db: Db;
let clock: Date;
const requested: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "e2e4-"));
  dbPath = join(dir, "e2e.db");
  writeFileSync(join(dir, "answers.yaml"), ANSWERS_YAML);
  vi.stubEnv("JOB_AGENT_DB", dbPath);
  vi.stubEnv("JOB_AGENT_CONFIG_DIR", dir);
  clock = START;
  requested.length = 0;
  let t = START.getTime();
  __testInjectTimeAndSleep(
    () => new Date(Math.max(t, clock.getTime())),
    async (ms) => {
      t += ms;
    },
  );
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(log, level).mockImplementation(() => undefined);
  }
  server.events.on("request:start", ({ request }) => {
    requested.push(`${request.method} ${request.url}`);
  });
  server.use(
    http.get(GH_JOB, () => HttpResponse.json(JSON.parse(readFileSync(FIXTURE, "utf8")) as object)),
  );
  db = openDb(dbPath);
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
  server.resetHandlers();
  server.events.removeAllListeners();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  __testInjectTimeAndSleep(
    () => new Date(),
    (ms) => new Promise((r) => setTimeout(r, ms)),
  );
});

async function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join(""), err: err.join("") };
}

/** GET without a body, POST with one; same-origin headers like the web app sends. */
async function api(path: string, body?: unknown): Promise<Response> {
  const app = createApp(db, {
    port: PORT,
    now: () => clock,
    salary: () => SALARY,
    exportsDir: join(dir, "exports"),
    logError: () => {},
  });
  if (body === undefined) return app.request(`http://x${path}`, { headers: { Host: HOST } });
  return app.request(`http://x${path}`, {
    method: "POST",
    headers: { Host: HOST, "Content-Type": "application/json", Origin: `http://${HOST}` },
    body: JSON.stringify(body),
  });
}

interface Item {
  postingId: string;
  title: string;
  company: string;
  review: { status: string; processed: boolean };
  questions: {
    total: number;
    covered: number;
    needsMapping: number;
    unknown: number;
    salary: number;
  };
}
interface Queue {
  sections: Record<"top" | "needs_a_look" | "suspicious" | "waiting", Item[]>;
  firstReviewAt: string | null;
}
const queue = async (): Promise<Queue> =>
  (await api(`/api/queue?date=${DATE}`)).json() as Promise<Queue>;

/** One review click, 30 s after the previous one. */
async function review(postingId: string, action: string, extra: Record<string, unknown> = {}) {
  clock = new Date(clock.getTime() + 30_000);
  const res = await api("/api/reviews", { posting_id: postingId, action, ...extra });
  expect(res.status, `${action} ${postingId}`).toBe(201);
}

const rows = <T>(sql: string, ...params: string[]): T[] =>
  db.$client.prepare(sql).all(...params) as T[];

const section = (md: string, heading: string): string => {
  const start = md.indexOf(`## ${heading}`);
  if (start < 0) throw new Error(`no section ${heading}`);
  const rest = md.slice(start + 3);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
};

describe("phase 4 review workflow end to end", () => {
  it("seed -> answers -> questions -> match -> review every match -> inbox -> stats -> digest", async () => {
    // Seed: the fake day (5 matches: 4 top + 1 suspicious; 2 waiting). Make the ATS posting fetchable.
    expect((await cli("seed-demo", "--date", DATE)).code).toBe(0);
    db.$client
      .prepare("update postings set external_id = '8860302002', apply_url = ? where id = ?")
      .run(
        "https://job-boards.greenhouse.io/northwind-demo/jobs/8860302002",
        `demo-${DATE}-top-ats`,
      );

    // The seed already stored three demo questions for it: drop them so fetch-questions treats it as due.
    db.$client
      .prepare("delete from posting_questions where posting_id = ?")
      .run(`demo-${DATE}-top-ats`);

    // Digest before any review lists every match (control for the end of the test).
    const before = await cli("digest", "--date", DATE, "--out-dir", join(dir, "digest-before"));
    expect(before.code).toBe(0);
    const mdBefore = readFileSync(join(dir, "digest-before", `${DATE}.md`), "utf8");
    for (const t of ["Senior Backend Engineer", "Full-stack Developer", "Platform Engineer"]) {
      expect(section(mdBefore, "Top matches")).toContain(t);
    }

    // answers import: config entries upserted, the dashboard-edited one kept.
    const imp = await cli("answers", "import");
    expect(imp.code).toBe(0);
    expect(imp.out).toContain("kept dashboard version: identity.full_name");
    expect(imp.out).toContain("answers import: 2 added, 0 updated, 0 unchanged, 1 kept");

    // fetch-questions: one GET to the public Greenhouse job API, 13 questions from the recorded fixture.
    const fetched = await cli("fetch-questions", "--limit", "3");
    expect(fetched.code).toBe(0);
    expect(requested).toEqual([`GET ${GH_JOB}?questions=true`]);
    expect(fetched.out).toMatch(/greenhouse: fetched 1, questions 13/);
    expect(
      rows("select id from posting_questions where posting_id = ?", `demo-${DATE}-top-ats`),
    ).toHaveLength(13);

    // match-questions: standard fields and the approved visa answer covered, salary never from the bank, rest unknown.
    const match = await cli("match-questions");
    expect(match.code).toBe(0);
    expect(match.out).toMatch(
      /^match-questions: 13 questions, 7 covered, 1 need a choice mapping, 0 salary, 5 unknown \(5 wordings\), \d+ changed$/m,
    );
    expect(
      rows<{ matched_key: string | null }>(
        "select matched_key from posting_questions where label like 'Will you now%'",
      )[0]?.matched_key,
    ).toBe("work.visa");
    // The not-approved answer does not cover its question.
    expect(
      rows<{ matched_key: string | null }>(
        "select matched_key from posting_questions where label like 'Have you previously%'",
      )[0]?.matched_key,
    ).toBeNull();

    // Queue API: 4 top (one also needs a look), 1 suspicious, 2 waiting; the question counts reach the queue.
    const q0 = await queue();
    const byKey = (key: string): Item => {
      const all = [...Object.values(q0.sections).flat()].find(
        (i) => i.postingId === `demo-${DATE}-${key}`,
      );
      if (all === undefined) throw new Error(`no ${key}`);
      return all;
    };
    expect(q0.sections.top.map((i) => i.postingId).sort()).toEqual(
      ["top-ats", "top-form", "top-paid", "top-unclear"].map((k) => `demo-${DATE}-${k}`),
    );
    expect(q0.sections.suspicious).toHaveLength(1);
    expect(q0.sections.waiting).toHaveLength(2);
    expect(q0.sections.needs_a_look.map((i) => i.postingId)).toContain(`demo-${DATE}-top-unclear`);
    expect(q0.firstReviewAt).toBeNull();
    expect(byKey("top-ats").questions).toEqual({
      total: 13,
      covered: 7,
      needsMapping: 1,
      unknown: 5,
      salary: 0,
    });
    const all = Object.values(q0.sections).flat();
    expect(all.every((i) => i.review.status === "open")).toBe(true);
    expect(
      (await (await api(`/api/stats?date=${DATE}`)).json()) as { matches: number; open: number },
    ).toMatchObject({
      matches: 5,
      processed: 0,
      open: 5,
    });

    // Review every match with a mix of actions.
    const id = (k: string) => `demo-${DATE}-${k}`;
    await review(id("top-ats"), "pay_policy", { pay_policy: "location_agnostic" });
    await review(id("top-ats"), "interested");
    await review(id("top-form"), "wrong_apply_link", {
      apply_url: "https://lumen-demo.example.com/careers/apply/fullstack",
    });
    await review(id("top-form"), "applied_manually");
    await review(id("top-paid"), "ask_too_high");
    await review(id("top-paid"), "not_interested", { reason: "salary" });
    await review(id("top-unclear"), "later");
    const mid = (await (await api(`/api/stats?date=${DATE}`)).json()) as {
      processed: number;
      open: number;
    };
    expect(mid).toMatchObject({ processed: 3, open: 2 }); // a "later" posting stays open
    await review(id("suspicious"), "scam");
    const bulk = await api("/api/reviews/bulk", {
      posting_ids: [id("top-unclear"), id("suspicious")],
      action: "not_interested",
      reason: "location",
    });
    expect(bulk.status).toBe(201);

    // Feedback reached the registries.
    expect(
      rows<{ pay_policy: string; pay_policy_source: string }>(
        "select c.pay_policy, c.pay_policy_source from companies c join postings p on p.company_id = c.id where p.id = ?",
        id("top-ats"),
      )[0],
    ).toEqual({ pay_policy: "location_agnostic", pay_policy_source: `owner:${DATE}` });
    expect(
      rows<{ apply_url: string; method: string }>(
        "select apply_url, method from apply_links where posting_id = ?",
        id("top-form"),
      )[0],
    ).toEqual({
      apply_url: "https://lumen-demo.example.com/careers/apply/fullstack",
      method: "owner",
    });

    // Inbox: answer one unknown wording; matching re-runs over the stored questions.
    const inbox = (await (await api("/api/inbox")).json()) as {
      openCount: number;
      items: { id: string; label: string }[];
    };
    expect(inbox.openCount).toBeGreaterThanOrEqual(5);
    const wording = inbox.items.find((i) => i.label === RESIDENCE);
    expect(wording).toBeDefined();
    const answered = await api(`/api/inbox/${wording?.id ?? ""}/answer`, {
      group: "location",
      key: "country",
      answer: "Indonesia",
      type: "text",
      approved: true,
    });
    expect(answered.status).toBe(200);
    expect(((await answered.json()) as { key: string }).key).toBe("location.country");
    const after = (await (await api("/api/inbox")).json()) as { items: { label: string }[] };
    expect(after.items.map((i) => i.label)).not.toContain(RESIDENCE);
    expect(after.items.map((i) => i.label)).toContain(FORMER); // not approved, still unknown
    expect(
      (await queue()).sections.top.find((i) => i.postingId === id("top-ats"))?.questions,
    ).toEqual({
      total: 13,
      covered: 7,
      needsMapping: 2,
      unknown: 4,
      salary: 0,
    });

    // Stats: all 5 matches processed, numbers from the recorded clicks.
    const stats = (await (await api(`/api/stats?date=${DATE}`)).json()) as {
      matches: number;
      processed: number;
      open: number;
      elapsedMinutes: number;
      doneWhenMet: boolean;
      actions: Record<string, number>;
      reasons: Record<string, number>;
      askChecks: Record<string, { too_high: number; total: number }>;
    };
    expect(stats).toMatchObject({ matches: 5, processed: 5, open: 0, doneWhenMet: true });
    expect(stats.elapsedMinutes).toBeGreaterThan(0);
    expect(stats.elapsedMinutes).toBeLessThanOrEqual(30);
    expect(stats.actions).toEqual({
      pay_policy: 1,
      interested: 1,
      wrong_apply_link: 1,
      applied_manually: 1,
      ask_too_high: 1,
      not_interested: 3,
      later: 1,
      scam: 1,
    });
    expect(stats.reasons).toEqual({ salary: 1, location: 2 });
    expect(stats.askChecks["global_adjusted"]).toMatchObject({ too_high: 1, total: 1 });

    // CLI stats agree with the API.
    const cliStats = await cli("review-stats", "--date", DATE);
    expect(cliStats.out).toContain("matches: 5, processed: 5, open: 0");
    expect(cliStats.out).toContain("(met)");

    // Digest: processed postings leave Top matches and Needs a look; open ones stay.
    expect((await cli("digest", "--date", DATE, "--out-dir", join(dir, "digest-after"))).code).toBe(
      0,
    );
    const md = readFileSync(join(dir, "digest-after", `${DATE}.md`), "utf8");
    for (const sec of ["Top matches", "Needs a look"]) {
      for (const t of [
        "Senior Backend Engineer",
        "Full-stack Developer",
        "Platform Engineer",
        "Staff Software Engineer",
      ]) {
        expect(section(md, sec), `${sec}: ${t}`).not.toContain(t);
      }
    }
    expect(md).toContain("Reviewed: 5 processed, 2 open");
    expect(section(md, "Waiting for scoring")).toContain("Backend Developer");
  });
});
