import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASHBY_FIXTURE_CAPTCHA_PATH,
  ASHBY_FIXTURE_FORM_PATH,
  ASHBY_FIXTURE_POSTING_ID,
  ASHBY_READ_ONLY_OPERATIONS,
  FIXTURE_CAPTCHA_PATH,
  FIXTURE_FORM_PATH,
  FIXTURE_POSTING_ID,
  LEVER_FIXTURE_CAPTCHA_PATH,
  LEVER_FIXTURE_FORM_PATH,
  LEVER_FIXTURE_POSTING_ID,
  ashbyFixtureContext,
  createAnswer,
  fixtureContext,
  leverFixtureContext,
  loadFillContext,
  matchQuestions,
  runAshbyDryRun,
  runGreenhouseDryRun,
  runLeverDryRun,
  seedAshbyFixture,
  seedGreenhouseFixture,
  seedLeverFixture,
  startAshbyFixtureServer,
  startGreenhouseFixtureServer,
  startLeverFixtureServer,
  type PlanContext,
} from "@job-agent/apply";
import { resetRunLimit } from "@job-agent/apply/testing";
import { openDb, type Db } from "@job-agent/core";
import { main } from "@job-agent/pipeline";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";

// Phase 5 chain, offline: seed-demo -> fixture dry runs for Greenhouse, Lever and Ashby (full fill, CAPTCHA stop, a choice
// question that needs a mapping, the mapping saved through the API, the same form filled, an uncovered question left empty)
// -> every run reviewed through the API -> the done-when line. Everything runs in a temp dir with the fake persona and the
// committed fixture forms served from 127.0.0.1; nothing reads config/ or data/, nothing real is opened.

const PORT = 4513;
const HOST = `127.0.0.1:${PORT}`;
const DATE = "2026-10-17";
const KINDS = ["greenhouse", "lever", "ashby"] as const;
type Kind = (typeof KINDS)[number];

const POSTING: Record<Kind, string> = {
  greenhouse: FIXTURE_POSTING_ID,
  lever: LEVER_FIXTURE_POSTING_ID,
  ashby: ASHBY_FIXTURE_POSTING_ID,
};
const FORM: Record<Kind, string> = {
  greenhouse: FIXTURE_FORM_PATH,
  lever: LEVER_FIXTURE_FORM_PATH,
  ashby: ASHBY_FIXTURE_FORM_PATH,
};
const CAPTCHA: Record<Kind, string> = {
  greenhouse: FIXTURE_CAPTCHA_PATH,
  lever: LEVER_FIXTURE_CAPTCHA_PATH,
  ashby: ASHBY_FIXTURE_CAPTCHA_PATH,
};
const FAKE_VALUES = ["Alex Example", "alex.example@example.test", "555 0100", "Example Corp"];

let dir: string;
let db: Db;
type Servers = {
  greenhouse: Awaited<ReturnType<typeof startGreenhouseFixtureServer>>;
  lever: Awaited<ReturnType<typeof startLeverFixtureServer>>;
  ashby: Awaited<ReturnType<typeof startAshbyFixtureServer>>;
};
let servers: Servers;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "e2e5-"));
  vi.stubEnv("JOB_AGENT_DB", join(dir, "e2e.db"));
  vi.stubEnv("JOB_AGENT_CONFIG_DIR", dir);
  db = openDb(join(dir, "e2e.db"));
  servers = {
    greenhouse: await startGreenhouseFixtureServer(),
    lever: await startLeverFixtureServer(),
    ashby: await startAshbyFixtureServer(),
  };
});
afterAll(async () => {
  for (const s of Object.values(servers ?? {})) await s.close();
  vi.unstubAllEnvs();
  db?.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

async function cli(...args: string[]): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const code = await main(args, { out: (t) => out.push(t), err: (t) => out.push(t) });
  return { code, out: out.join("") };
}

/** GET without a body, POST / PATCH with one; same-origin headers like the web app sends. */
async function api(path: string, body?: unknown, method = "POST"): Promise<Response> {
  const app = createApp(db, {
    port: PORT,
    now: () => new Date(`${DATE}T09:00:00Z`),
    dataDir: dir,
    logError: () => {},
  });
  if (body === undefined) return app.request(`http://x${path}`, { headers: { Host: HOST } });
  return app.request(`http://x${path}`, {
    method,
    headers: { Host: HOST, "Content-Type": "application/json", Origin: `http://${HOST}` },
    body: JSON.stringify(body),
  });
}
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

/** The fixture persona's approved answers and the owner's approved mappings, both read from the DB; the tier ask is fixed. */
const dbContext = (kind: Kind): PlanContext => ({
  ...loadFillContext(db, POSTING[kind]),
  ask: fixtureContext(dir).ask,
});

interface Run {
  runId: string;
  status: string;
  stopReason: string | null;
  filled: number;
  total: number;
}

/** One browser run (the harness allows one per process; the test seam resets that). `context` undefined = the static fixture persona. */
async function dryRun(kind: Kind, path: string, context?: PlanContext): Promise<Run> {
  resetRunLimit();
  const base = {
    db,
    dataDir: dir,
    postingId: POSTING[kind],
    fixture: true,
    url: `${servers[kind].origin}${path}`,
    context:
      context ??
      (kind === "greenhouse"
        ? fixtureContext(dir)
        : kind === "lever"
          ? leverFixtureContext(dir)
          : ashbyFixtureContext(dir)),
  };
  const run = await (kind === "greenhouse"
    ? runGreenhouseDryRun(base)
    : kind === "lever"
      ? runLeverDryRun(base)
      : runAshbyDryRun(base));
  return run;
}

interface Detail {
  status: string;
  stopReason: string | null;
  fixture: boolean;
  hasScreenshot: boolean;
  fields: { label: string; filled: boolean; source: string; note: string | null }[];
}
const detail = async (id: string): Promise<Detail> => json(await api(`/api/dry-runs/${id}`));
// Untouched blocks (survey, consent) are listed as "skipped:" rows: never open questions.
const open = (d: Detail) => d.fields.filter((f) => !f.filled && !f.note?.startsWith("skipped: "));
const unfilled = (d: Detail) => open(d).map((f) => f.label);

interface Inbox {
  items: { label: string }[];
  mappings: { answerKey: string; label: string; options: string[]; answerText: string }[];
}
const inbox = async (): Promise<Inbox> => json(await api("/api/inbox"));

describe("phase 5 dry-run workflow end to end", () => {
  it("fixture dry runs for all three ATSs -> mapping through the API -> review -> done-when line", async () => {
    // Demo day + the fake persona's approved answers in the answer bank (not config/).
    expect((await cli("seed-demo", "--date", DATE)).code).toBe(0);
    // The demo bank already holds approved answers under real keys (e.g. contact.full_name); the persona fills the rest.
    const seeded = new Set(
      (await json<{ answers: { key: string }[] }>(await api("/api/answers"))).answers.map(
        (a) => a.key,
      ),
    );
    for (const a of fixtureContext(dir).answers) {
      if (seeded.has(a.key)) continue;
      const [group, ...rest] = a.key.split(".");
      createAnswer(db, {
        group: group as string,
        key: rest.join("."),
        answer: a.answer,
        question: a.question,
        alternatives: a.alternatives,
        type: a.type as "yes_no" | "choice" | null,
        choices: a.choices,
        approved: true,
      });
    }
    createAnswer(db, {
      group: "experience",
      key: "years_nextjs",
      answer: "Example Corp",
      question: "Current company",
      approved: true,
    });
    createAnswer(db, {
      group: "contact",
      key: "location",
      answer: "Jakarta, Indonesia",
      approved: true,
    });
    seedGreenhouseFixture(db);
    seedLeverFixture(db);
    seedAshbyFixture(db);

    const full: Record<Kind, Run> = {} as Record<Kind, Run>;
    const captcha: Record<Kind, Run> = {} as Record<Kind, Run>;
    const unmapped: Record<Kind, Run> = {} as Record<Kind, Run>;
    const mapped: Record<Kind, Run> = {} as Record<Kind, Run>;
    const uncovered: Record<Kind, Run> = {} as Record<Kind, Run>;

    // 1. A full fill on the static fixture persona (this also stores the Lever and Ashby questions from their pages).
    for (const k of KINDS) {
      full[k] = await dryRun(k, FORM[k]);
      expect(full[k], k).toMatchObject({ status: "filled", stopReason: null });
      expect(full[k].filled).toBe(full[k].total);
      expect(full[k].total).toBeGreaterThanOrEqual(13);
    }
    matchQuestions(db);

    // 2. A page with a visible CAPTCHA challenge (a passive script alone does not stop a run) stops before any field is filled.
    for (const k of KINDS) {
      captcha[k] = await dryRun(k, CAPTCHA[k]);
      expect(captcha[k], k).toMatchObject({ status: "stopped", stopReason: "captcha", filled: 0 });
      expect((await detail(captcha[k].runId)).hasScreenshot).toBe(true);
    }

    // 3. The same form with the answers and mappings read from the DB: no mapping saved yet, so the choice questions stay empty.
    for (const k of KINDS) {
      unmapped[k] = await dryRun(k, FORM[k], dbContext(k));
      expect(unmapped[k], k).toMatchObject({
        status: "needs_input",
        stopReason: "choice_unmapped",
      });
      expect(unmapped[k].filled).toBeLessThan(unmapped[k].total);
    }

    // 4. The owner maps each choice question through the API (the Inbox shows the form's options and the approved answer).
    //    (The demo postings have their own choice question; the owner has not mapped that one and it does not matter here.)
    const formLabels = new Set(
      (
        db.$client
          .prepare("select label from posting_questions where posting_id like 'fixture-%'")
          .all() as { label: string }[]
      ).map((r) => r.label),
    );
    const isForm = (m: { label: string }) => formLabels.has(m.label);
    const needs = (await inbox()).mappings.filter(isForm);
    expect(needs.length).toBeGreaterThanOrEqual(4);
    for (const n of needs) {
      const given = n.answerText.split(", ");
      const chosen = n.options.filter((o) => given.includes(o));
      expect(chosen.length, n.label).toBeGreaterThan(0);
      const res = await api("/api/choice-mappings", {
        answer_key: n.answerKey,
        label: n.label,
        options: n.options,
        chosen,
      });
      expect(res.status, n.label).toBe(201);
    }
    expect((await inbox()).mappings.filter(isForm)).toEqual([]);
    expect(
      ((await json(await api("/api/choice-mappings"))) as { mappings: unknown[] }).mappings.length,
    ).toBe(needs.length);

    // 5. The same runs again: every choice question is now filled, nothing is left empty.
    for (const k of KINDS) {
      mapped[k] = await dryRun(k, FORM[k], dbContext(k));
      expect(mapped[k], k).toMatchObject({ status: "filled", stopReason: null });
      expect(mapped[k].filled).toBe(mapped[k].total);
      expect(unfilled(await detail(mapped[k].runId))).toEqual([]);
    }

    // 6. An answer the owner no longer approves: that field stays empty, the run is needs_input and the label is in the Inbox.
    const why = await api("/api/answers/misc.open_to_crypto_web3", { approved: false }, "PATCH");
    expect(why.status).toBe(200);
    for (const k of KINDS) {
      uncovered[k] = await dryRun(k, FORM[k], dbContext(k));
      expect(uncovered[k], k).toMatchObject({
        status: "needs_input",
        stopReason: "uncovered_question",
      });
      const d = await detail(uncovered[k].runId);
      const empty = unfilled(d);
      expect(empty, k).toHaveLength(1);
      expect(open(d)[0]?.source).toBe("none");
      expect((await inbox()).items.map((i) => i.label)).toContain(empty[0]);
      expect(uncovered[k].filled).toBe(uncovered[k].total - 1);
    }

    const allRuns = KINDS.flatMap((k) => [
      full[k],
      captcha[k],
      unmapped[k],
      mapped[k],
      uncovered[k],
    ]);

    // 7. The dashboard lists 15 fixture runs, never a filled value; every screenshot is served by run id.
    const list = await api("/api/dry-runs");
    const listText = await list.text();
    for (const v of FAKE_VALUES) expect(listText).not.toContain(v);
    const listed = JSON.parse(listText) as { runs: { fixture: boolean; review: string | null }[] };
    // 15 fixture runs plus the 2 owner-style runs seed-demo adds (fixture = false, never reviewed here).
    expect(listed.runs).toHaveLength(17);
    expect(listed.runs.filter((r) => r.fixture)).toHaveLength(15);
    expect(listed.runs.every((r) => r.review === null)).toBe(true);
    const shot = await api(`/api/dry-runs/${full.greenhouse.runId}/screenshot`);
    expect(shot.status).toBe(200);
    expect(shot.headers.get("content-type")).toBe("image/png");

    // 8. Review every run through the API: the five runs of each ATS are right, except one wrong uncovered run
    //    whose missing label goes to the Inbox.
    const review = (id: string, body: Record<string, unknown>) =>
      api(`/api/dry-runs/${id}/review`, body);
    for (const k of KINDS) {
      for (const run of [full[k], captcha[k], unmapped[k], mapped[k]]) {
        expect((await review(run.runId, { review: "correct" })).status, k).toBe(200);
      }
    }
    expect((await review(uncovered.lever.runId, { review: "correct" })).status).toBe(200);
    expect((await review(uncovered.ashby.runId, { review: "correct" })).status).toBe(200);
    const wrong = await review(uncovered.greenhouse.runId, {
      review: "wrong",
      reason: "missing_field",
      missing_label: "Preferred pronouns",
    });
    expect(wrong.status).toBe(200);
    expect((await json<{ inboxOpen: boolean }>(wrong)).inboxOpen).toBe(true);
    expect((await inbox()).items.map((i) => i.label)).toContain("Preferred pronouns");
    expect((await review(full.greenhouse.runId, { review: "wrong" })).status).toBe(400);

    // 9. Done-when. Fixture runs never count: all 15 are reviewed but the line stays at zero. (Direct count check: the
    //    expected counts are asserted on the rows as they are, no test-only switch exists in the product.)
    const fixtureLine = (await json<{ doneWhen: { line: string } }>(await api("/api/dry-runs")))
      .doneWhen;
    expect(fixtureLine.line).toMatch(
      /^dry runs: 0 correct of 0 reviewed \(0 full fills\); .*not met$/,
    );

    // Twin: the same rows counted as owner runs (the fixture flag cleared directly in the temp DB, test only) read the
    // expected numbers: 15 reviewed, 14 correct, 6 full fills (the full and the mapped run of each ATS).
    db.$client.prepare("update dry_runs set fixture = 0 where fixture = 1").run();
    const owner = (
      await json<{ doneWhen: { line: string; met: boolean } }>(await api("/api/dry-runs"))
    ).doneWhen;
    expect(owner.line).toMatch(/^dry runs: 14 correct of 15 reviewed \(6 full fills\); .*not met$/);
    expect(owner.met).toBe(false);
    db.$client
      .prepare(`update dry_runs set fixture = 1 where id in (${allRuns.map(() => "?").join(",")})`)
      .run(...allRuns.map((r) => r.runId));
    expect(
      (await json<{ doneWhen: { line: string } }>(await api("/api/dry-runs"))).doneWhen.line,
    ).toMatch(/^dry runs: 0 correct of 0 reviewed/);

    // 10. Nothing was ever sent: the fixture servers saw GET / HEAD only. The one exception is Ashby's read-only GraphQL
    //     query POSTs (allowlisted operation, never a mutation).
    expect(servers.greenhouse.nonGet()).toEqual([]);
    expect(servers.lever.nonGet()).toEqual([]);
    const ashby = servers.ashby;
    expect(ashby.graphql.length).toBeGreaterThan(0);
    expect(ashby.graphql.every((g) => g.kind === "query")).toBe(true);
    expect(
      ashby.nonGet().every((r) => r.path === "/api/non-user-graphql" && r.op !== undefined),
    ).toBe(true);
    expect(ashby.nonGet().every((r) => ASHBY_READ_ONLY_OPERATIONS.has(r.op as string))).toBe(true);
  }, 300_000);
});
