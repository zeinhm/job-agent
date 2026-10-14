import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testInjectTimeAndSleep,
  analysis,
  apply_links,
  intel,
  llm_calls,
  log,
  openDb,
  postings,
  type Db,
} from "@job-agent/core";
import { APPLY_LINK_SYSTEM_PROMPT } from "../intel/prompts/apply-link.ts";
import { runResolveApply } from "./index.ts";
import {
  APPLY_LINK_MAX_TOKENS,
  buildApplyLinkInput,
  candidateLinks,
  MAX_CANDIDATES,
  MAX_CONTEXT_CHARS,
} from "./llm-step.ts";

const API = "https://api.anthropic.com/v1/messages";
const ENV = { ANTHROPIC_API_KEY: "sk-ant-test-key-0000" };
const T0 = new Date("2026-10-14T00:00:00.000Z");

const reply = (text: string, inputTokens = 1200) => ({
  _handbuilt: true,
  id: "msg_fixture_apply_link",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: inputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 12,
  },
});

type Req = { model: string; max_tokens: number; messages: Array<{ content: string }> };
let requests: Req[] = [];
let answers: Array<{ text: string; inputTokens?: number }> = [];
const server = setupServer(
  http.post(API, async ({ request }) => {
    requests.push((await request.json()) as Req);
    const a = answers[Math.min(requests.length, answers.length) - 1];
    return HttpResponse.json(reply(a?.text ?? '{"choice":0,"kind":"unknown"}', a?.inputTokens));
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

let db: Db;
let n = 0;
const logged: unknown[] = [];

beforeEach(() => {
  db = openDb(":memory:");
  requests = [];
  answers = [];
  logged.length = 0;
  let t = 0;
  __testInjectTimeAndSleep(
    () => new Date(t),
    async (ms) => {
      t += ms;
    },
  );
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(log, level).mockImplementation((...a: unknown[]) => {
      logged.push(a);
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  db.$client.close();
});

const LINKS_TEXT = `<p>Join us!</p><p><a href="https://forms.example.test/apply/42">Application form</a>
or read <a href="https://blog.example.test/post">our blog</a> and <a href="https://example.test/about">About us</a>.</p>`;
const FORM = "https://forms.example.test/apply/42";

function addPosting(
  opts: {
    text?: string;
    fit?: number | null;
    final?: "keep" | "reject" | null;
    title?: string;
  } = {},
): string {
  const id = `p${++n}`;
  db.insert(postings)
    .values({
      id,
      source: "remotive",
      external_id: id,
      url: `https://remotive.example.test/jobs/${id}`,
      title: opts.title ?? "Platform Engineer",
      company_name: "Nobody Inc",
      description_text: opts.text ?? LINKS_TEXT,
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
  db.insert(intel)
    .values({
      id: `i-${id}`,
      posting_id: id,
      status: "done",
      final_decision: opts.final === undefined ? "keep" : opts.final,
      fit_score: opts.fit === undefined ? 80 : opts.fit,
      updated_at: "2026-10-13T00:00:00.000Z",
    })
    .run();
  return id;
}

let clock = T0;
async function run(env: Record<string, string | undefined> = ENV) {
  const out: string[] = [];
  const code = await runResolveApply({
    db,
    now: () => clock,
    out: (t) => out.push(t),
    err: () => undefined,
    llm: { env, baseURL: "https://api.anthropic.com" },
  });
  return { code, out: out.join("") };
}
const link = (id: string) =>
  db.select().from(apply_links).where(eq(apply_links.posting_id, id)).get();
const calls = () => db.select().from(llm_calls).all();

describe("apply-link LLM step", () => {
  beforeEach(() => {
    clock = T0;
  });

  it("stores a valid choice with method llm and the exact candidate URL", async () => {
    answers = [{ text: '{"choice":1,"kind":"company_form"}' }];
    const p = addPosting();
    const r = await run();
    expect(link(p)).toMatchObject({
      apply_url: FORM,
      apply_type: "company_form",
      method: "llm",
      found_on: "remotive",
      reason: "LLM chose link 1 of 3 (company_form)",
    });
    expect(r.out).toMatch(/methods: .*source 0, llm 1; types: .*company_form 1/);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatchObject({
      purpose: "apply_link",
      model: "claude-haiku-5-5",
      posting_id: p,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.max_tokens).toBe(APPLY_LINK_MAX_TOKENS);
    const sent = requests[0]?.messages[0]?.content ?? "";
    expect(sent).toContain("1. https://forms.example.test/apply/42 (link text: Application form)");
    expect(sent).toContain("Title: Platform Engineer");
  });

  it("downgrades kind ats when the chosen URL is not an ATS link", async () => {
    answers = [{ text: '{"choice":2,"kind":"ats"}' }];
    const p = addPosting();
    await run();
    expect(link(p)).toMatchObject({
      apply_url: "https://blog.example.test/post",
      apply_type: "unknown",
      method: "llm",
    });
  });

  it("treats an out-of-range choice as none, with one call and no retry loop", async () => {
    answers = [{ text: '{"choice":9,"kind":"company_form"}' }];
    const p = addPosting();
    await run();
    expect(requests).toHaveLength(1);
    expect(link(p)).toMatchObject({
      apply_url: `https://remotive.example.test/jobs/${p}`,
      apply_type: "unknown",
      method: "llm",
    });
    expect(link(p)?.reason).toContain("out of range");
  });

  it("choice 0 is none; the answer is final (no second call, also after 8 days)", async () => {
    answers = [{ text: '{"choice":0,"kind":"unknown"}' }];
    const p = addPosting();
    await run();
    expect(link(p)).toMatchObject({ apply_type: "unknown", method: "llm" });
    clock = new Date(T0.getTime() + 8 * 24 * 60 * 60 * 1000);
    expect((await run()).out).toMatch(/checked 0,/);
    expect(requests).toHaveLength(1);
    expect(calls()).toHaveLength(1);
  });

  it("invalid output: the client retries once, the row stays unknown with method source", async () => {
    answers = [{ text: '{"choice":"two"}' }, { text: "not json" }];
    const p = addPosting();
    const r = await run();
    expect(r.code).toBe(0);
    expect(requests).toHaveLength(2);
    expect(link(p)).toMatchObject({ apply_type: "unknown", method: "source" });
  });

  it("stops the step when the budget runs out mid-run; the rest stay for the next run", async () => {
    // Each call costs about $0.0003 (3000 input tokens); the reserve of the next one no longer fits under the cap.
    answers = [{ text: '{"choice":1,"kind":"company_form"}', inputTokens: 3000 }];
    const first = addPosting();
    const second = addPosting({ title: "Data Engineer" });
    const third = addPosting({ title: "SRE" });
    const out: string[] = [];
    await runResolveApply({
      db,
      now: () => clock,
      out: (t) => out.push(t),
      err: () => undefined,
      llm: {
        env: { ...ENV, JOB_AGENT_LLM_CAP_USD: "0.0004" },
        baseURL: "https://api.anthropic.com",
      },
    });
    const stored = [first, second, third].filter((id) => link(id) !== undefined);
    expect(stored).toHaveLength(1);
    expect(link(stored[0] as string)?.method).toBe("llm");
    expect(requests).toHaveLength(1);
    expect(out.join("")).toContain("LLM daily budget used up");
    expect(out.join("")).toMatch(/deferred 2/);

    // Next run (new day, fresh budget): the other two are resolved.
    answers = [{ text: '{"choice":1,"kind":"company_form"}' }];
    clock = new Date(T0.getTime() + 24 * 60 * 60 * 1000);
    await run();
    expect([first, second, third].every((id) => link(id)?.method === "llm")).toBe(true);
    expect(requests).toHaveLength(3);
  });

  it("without a key the step is skipped with one line and the posting stays for a later run", async () => {
    const p1 = addPosting();
    const p2 = addPosting({ title: "SRE" });
    const r = await run({});
    expect(r.out.match(/ANTHROPIC_API_KEY not set/g)).toHaveLength(1);
    expect(requests).toHaveLength(0);
    expect(calls()).toHaveLength(0);
    expect(link(p1)).toBeUndefined();
    expect(link(p2)).toBeUndefined();
    answers = [{ text: '{"choice":1,"kind":"company_form"}' }];
    await run();
    expect(link(p1)?.method).toBe("llm");
  });

  it("makes no call for fit < 60, a missing fit, a non-keep decision or a single candidate", async () => {
    const low = addPosting({ fit: 59 });
    const none = addPosting({ fit: null });
    const single = addPosting({ text: `<a href="${FORM}">Apply</a>` });
    const noLinks = addPosting({ text: "No links here." });
    await run();
    expect(calls()).toHaveLength(0);
    expect(requests).toHaveLength(0);
    for (const id of [low, none, single, noLinks]) {
      expect(link(id)).toMatchObject({ apply_type: "unknown", method: "source" });
    }
  });

  it("makes no call when the text holds an ATS job URL", async () => {
    const p = addPosting({
      text: `<a href="https://jobs.ashbyhq.com/acmelabs/0f6e5d4c-1b2a-4c3d-9e8f-123456789abc">Apply</a> <a href="${FORM}">Form</a> <a href="https://blog.example.test/post">Blog</a>`,
    });
    await run();
    expect(calls()).toHaveLength(0);
    expect(link(p)).toMatchObject({ apply_type: "ats", method: "posting_text" });
  });

  it("logs ids, model, tokens and cost only, never a URL from the prompt", async () => {
    answers = [{ text: '{"choice":1,"kind":"company_form"}' }];
    addPosting();
    await run();
    const text = JSON.stringify(logged);
    expect(text).toContain("llm call");
    expect(text).toContain("apply_link");
    expect(text).not.toContain("example.test/apply");
    expect(text).not.toContain("blog.example.test");
    expect(text).not.toContain("Application form");
  });
});

describe("candidateLinks and prompt input", () => {
  it("keeps anchor text, drops the own listing, LinkedIn links and assets, caps at 10", () => {
    const many = Array.from({ length: 14 }, (_, i) => `https://c${i}.example.test/x`).join(" ");
    const got = candidateLinks(
      `<a href="https://www.linkedin.com/company/x">li</a> <a href="https://own.example.test/job/1">own</a> https://cdn.example.test/logo.png <a href="https://a.example.test/apply">Apply   now</a> ${many}`,
      [],
      ["https://own.example.test/job/1"],
    );
    expect(got).toHaveLength(MAX_CANDIDATES);
    expect(got[0]).toEqual({ url: "https://a.example.test/apply", anchor: "Apply now" });
    expect(got.some((c) => /linkedin|logo\.png|own\.example/.test(c.url))).toBe(false);
  });

  it("limits the posting text to 2,000 characters and numbers the links", () => {
    const cands = candidateLinks(
      `${"x ".repeat(3000)} https://a.example.test/1 https://b.example.test/2`,
      [],
      [],
    );
    const input = buildApplyLinkInput(
      {
        title: "T",
        companyName: "C",
        descriptionText: `${"x ".repeat(3000)} https://a.example.test/1 https://b.example.test/2`,
      },
      cands,
    );
    expect(input).toContain("1. https://a.example.test/1");
    expect(input).toContain("2. https://b.example.test/2");
    const textPart = input.split("Posting text around the links:\n")[1] ?? "";
    expect(textPart.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
  });

  it("the prompt tells the model to answer with a number only", () => {
    expect(APPLY_LINK_SYSTEM_PROMPT).toContain("Never write a URL");
  });
});
