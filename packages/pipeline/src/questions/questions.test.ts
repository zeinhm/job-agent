import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { http, HttpResponse, type JsonBodyType } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testInjectTimeAndSleep,
  analysis,
  APPLY_TYPES,
  apply_links,
  companies,
  intel,
  log,
  openDb,
  posting_questions,
  postings,
  reviews,
  type Db,
} from "@job-agent/core";
import { main } from "../cli.ts";
import { normalizeCompanyName } from "../normalize/index.ts";
import { DEFAULT_LIMIT, NO_ENDPOINT, REFETCH_WINDOW_MS, runFetchQuestions } from "./index.ts";
import { normalizeLabel } from "./normalize.ts";
import {
  ParseError,
  parseGreenhouse,
  parseRecruiteeOffers,
  parseWorkable,
  recruiteeQuestions,
} from "./parse.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/questions");
const fixture = (name: string): JsonBodyType =>
  JSON.parse(readFileSync(join(fixtureDir, name), "utf-8")) as JsonBodyType;

const server = setupServer();
const requested: string[] = [];
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

let db: Db;
let clock: Date;
const T0 = new Date("2026-10-14T00:00:00.000Z");
const GH_JOB = "https://boards-api.greenhouse.io/v1/boards/gitlab/jobs/8860302002";
const WK_FORM = "https://apply.workable.com/api/v1/jobs/81B46579FE/form";
const RC_OFFERS = "https://bunq.recruitee.com/api/offers/";

beforeEach(() => {
  db = openDb(":memory:");
  clock = T0;
  requested.length = 0;
  let t = 0;
  __testInjectTimeAndSleep(
    () => new Date(t),
    async (ms) => {
      t += ms;
    },
  );
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  server.events.on("request:start", ({ request }) => {
    requested.push(`${request.method} ${request.url}`);
  });
});
afterEach(() => {
  server.resetHandlers();
  server.events.removeAllListeners();
  vi.restoreAllMocks();
  db.$client.close();
});

let n = 0;
function addCompany(name: string, ats: string | null, slug: string | null): string {
  const id = randomUUID();
  db.insert(companies)
    .values({
      id,
      name,
      normalized_name: normalizeCompanyName(name),
      ats_type: ats as never,
      ats_slug: slug,
      created_at: T0.toISOString(),
    })
    .run();
  return id;
}

interface Opts {
  source?: string;
  externalId?: string;
  url?: string;
  applyUrl?: string | null;
  final?: "keep" | "reject" | "suspicious" | null;
  canonical?: string;
  seen?: string;
  updatedAt?: string;
  companyId?: string | null;
  link?: { type: (typeof APPLY_TYPES)[number]; ats?: string; slug?: string; url?: string };
}

function addPosting(o: Opts = {}): string {
  const id = `p${++n}`;
  const source = o.source ?? "hn";
  db.insert(postings)
    .values({
      id,
      source,
      external_id: o.externalId ?? id,
      url: o.url ?? `https://${source}.example.test/jobs/${id}`,
      apply_url: o.applyUrl ?? null,
      title: `Engineer ${id}`,
      company_id: o.companyId ?? null,
      company_name: "Acme",
      first_seen_at: o.seen ?? "2026-10-13T00:00:00.000Z",
      last_seen_at: "2026-10-13T00:00:00.000Z",
      normalized_at: "2026-10-13T00:00:00.000Z",
      canonical_posting_id: o.canonical ?? null,
      updated_at: o.updatedAt ?? null,
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
      final_decision: o.final === undefined ? "keep" : o.final,
      updated_at: "2026-10-13T00:00:00.000Z",
    })
    .run();
  if (o.link) {
    db.insert(apply_links)
      .values({
        id: `l-${id}`,
        posting_id: id,
        apply_url: o.link.url ?? o.applyUrl ?? o.url ?? "https://example.test/apply",
        apply_type: o.link.type,
        method: "ats_board",
        ats_type: o.link.ats ?? null,
        ats_slug: o.link.slug ?? null,
        found_on: source,
        checked_at: "2026-10-13T00:00:00.000Z",
      })
      .run();
  }
  return id;
}

/** A kept HN posting whose apply link points at the GitLab job on Greenhouse. */
const ghPosting = (o: Opts = {}) =>
  addPosting({
    applyUrl: "https://job-boards.greenhouse.io/gitlab/jobs/8860302002",
    link: { type: "ats", ats: "greenhouse", slug: "gitlab" },
    ...o,
  });

async function run(limit?: number) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runFetchQuestions({
    db,
    limit,
    now: () => clock,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  return { code, out: out.join(""), err: err.join("") };
}
const rows = (postingId: string) =>
  db.select().from(posting_questions).where(eq(posting_questions.posting_id, postingId)).all();
const gh200 = () =>
  server.use(http.get(GH_JOB, () => HttpResponse.json(fixture("greenhouse-job.json"))));
const day = (d: number) => d * 24 * 60 * 60 * 1000;

describe("response parsing", () => {
  it("Greenhouse: standard and custom questions, types and options, EEOC left out", () => {
    const qs = parseGreenhouse(fixture("greenhouse-job.json"));
    expect(qs).toHaveLength(13);
    const byId = new Map(qs.map((q) => [q.question_id, q]));
    expect(byId.get("first_name")).toMatchObject({
      label: "First Name",
      required: true,
      type: "text",
    });
    expect(byId.get("resume")).toMatchObject({ type: "file", required: true });
    expect(byId.get("cover_letter")).toMatchObject({ type: "file", required: false });
    expect(byId.get("question_38624168002")).toMatchObject({
      label: "LinkedIn Profile",
      type: "text",
    });
    expect(byId.get("question_38624170002")).toMatchObject({
      type: "yes_no",
      options: ["Yes", "No"],
    });
    const visa = byId.get("question_38624172002");
    expect(visa?.type).toBe("choice");
    expect(visa?.options?.length).toBeGreaterThan(2);
    expect(qs.some((q) => q.question_id === "veteran_status")).toBe(false);
    expect(
      qs.every((q) => (q.type === "choice" || q.type === "yes_no") === (q.options !== null)),
    ).toBe(true);
  });

  it("Workable: sections flattened, types mapped, a field without a label keeps its id", () => {
    const qs = parseWorkable(fixture("workable-form.json"));
    const byId = new Map(qs.map((q) => [q.question_id, q]));
    expect(byId.get("firstname")).toMatchObject({ type: "text", required: true });
    expect(byId.get("resume")).toMatchObject({ type: "file" });
    expect(byId.get("CA_10626")).toMatchObject({ label: "Expected salary", type: "text" });
    expect(byId.get("CA_10628")).toMatchObject({ type: "yes_no", options: null });
    expect(byId.get("QA_11844076")?.type).toBe("long_text");
    const notice = byId.get("CA_10627");
    expect(notice).toMatchObject({ type: "choice" });
    expect(notice?.options).toContain("Available immediately");
    expect(byId.get("education")?.type).toBe("other");
    expect(byId.get("gdpr")).toMatchObject({ label: "gdpr", type: "yes_no", required: true });
  });

  it("Recruitee: infoboxes are not questions, kinds are mapped, off switches are skipped", () => {
    const offers = parseRecruiteeOffers(fixture("recruitee-offers.json"));
    const first = offers[0];
    if (first === undefined) throw new Error("fixture has no offer");
    const qs = recruiteeQuestions(first);
    const infoboxes = (first.open_questions ?? []).filter((q) => q.kind === "infobox").length;
    expect(infoboxes).toBeGreaterThan(0);
    expect(qs).toHaveLength((first.open_questions ?? []).length - infoboxes + 1); // + the phone switch
    expect(qs.find((q) => q.question_id === "options_phone")).toMatchObject({
      required: true,
      type: "text",
    });
    expect(qs.some((q) => q.question_id === "options_cv")).toBe(false); // options_cv is "off"
    expect(qs.find((q) => q.question_id === "4435735")).toMatchObject({
      label: "What country do you currently live in?",
      type: "text",
    });
    expect(qs.find((q) => q.question_id === "4435744")?.type).toBe("yes_no");
    expect(qs.find((q) => q.question_id === "4435737")?.options).toHaveLength(6);
  });

  it("a response of the wrong shape is a ParseError, never an empty list", () => {
    expect(() => parseGreenhouse({ id: 1 })).toThrow(ParseError);
    expect(() => parseGreenhouse(null)).toThrow(ParseError);
    expect(() =>
      parseGreenhouse({ questions: [{ label: "x", required: true, fields: [] }] }),
    ).toThrow(ParseError);
    expect(() => parseWorkable({ sections: [] })).toThrow(ParseError);
    expect(() => parseWorkable([{ name: "A", fields: [{ id: "x", type: "text" }] }])).toThrow(
      ParseError,
    );
    expect(() => parseRecruiteeOffers([])).toThrow(ParseError);
    expect(() => parseRecruiteeOffers({ offers: [{ slug: "a" }] })).toThrow(ParseError);
  });

  it("a repeated question id is a ParseError", () => {
    const q = { label: "A", required: false, fields: [{ name: "same", type: "input_text" }] };
    expect(() => parseGreenhouse({ questions: [q, q] })).toThrow(ParseError);
  });

  it("normalizes labels: case, punctuation, whitespace, trailing ? and *, markup", () => {
    expect(normalizeLabel("  What is your <b>Notice  Period</b>?* ")).toBe(
      "what is your notice period",
    );
    expect(normalizeLabel("Linkedin")).toBe(normalizeLabel("LinkedIn:"));
  });
});

describe("fetch-questions", () => {
  it("stores a Greenhouse job's questions and prints counts per ATS (no question text)", async () => {
    gh200();
    const id = ghPosting();
    const r = await run();
    expect(r.code).toBe(0);
    const stored = rows(id);
    expect(stored).toHaveLength(13);
    const yesNo = stored.find((q) => q.question_id === "question_38624170002");
    expect(yesNo).toMatchObject({
      ats_type: "greenhouse",
      required: true,
      type: "yes_no",
      options: JSON.stringify(["Yes", "No"]),
      matched_key: null,
      fetched_at: T0.toISOString(),
    });
    expect(yesNo?.normalized_label).toBe(normalizeLabel(yesNo?.label ?? ""));
    expect(requested).toEqual([`GET ${GH_JOB}?questions=true`]);
    expect(r.out).toContain("fetch-questions: selected 1, attempted 1");
    expect(r.out).toContain(
      "fetch-questions: greenhouse: fetched 1, questions 13, closed 0, skipped 0, deferred 0, errors 0",
    );
    expect(r.out).not.toContain("LinkedIn");
    expect(r.err).toBe("");
  });

  it("fetches a Workable form and a Recruitee offer, the latter from one board request for both postings", async () => {
    server.use(
      http.get(WK_FORM, () => HttpResponse.json(fixture("workable-form.json"))),
      http.get(RC_OFFERS, () => HttpResponse.json(fixture("recruitee-offers.json"))),
    );
    const wk = addPosting({
      applyUrl: "https://apply.workable.com/huggingface/j/81B46579FE/",
      link: { type: "ats", ats: "workable", slug: "huggingface" },
    });
    const rc1 = addPosting({
      applyUrl: "https://careers.bunq.com/o/head-of-product-6",
      link: { type: "ats", ats: "recruitee", slug: "bunq" },
    });
    const rc2 = addPosting({
      applyUrl: "https://bunq.recruitee.com/o/senior-product-owner-1",
      link: { type: "ats", ats: "recruitee", slug: "bunq" },
    });
    const r = await run();
    expect(r.code).toBe(0);
    expect(rows(wk).map((q) => q.ats_type)).toEqual(Array(rows(wk).length).fill("workable"));
    expect(rows(wk).length).toBeGreaterThan(10);
    expect(rows(rc1).length).toBeGreaterThan(5);
    expect(rows(rc2).some((q) => q.type === "long_text")).toBe(true); // the second offer's "text" question
    expect(rows(rc1).some((q) => q.type === "long_text")).toBe(false);
    expect(requested.filter((u) => u.includes("recruitee"))).toHaveLength(1);
    expect(r.out).toMatch(/fetch-questions: recruitee: fetched 2, questions \d+, closed 0/);
    expect(r.out).toMatch(/fetch-questions: workable: fetched 1, questions \d+/);
    expect(r.out).toContain("requests 2");
  });

  it("covers an ATS source's own postings (no apply_links row), using external_id and the company's board", async () => {
    gh200();
    const co = addCompany("GitLab", "greenhouse", "gitlab");
    const id = addPosting({
      source: "greenhouse",
      externalId: "8860302002",
      url: "https://job-boards.greenhouse.io/gitlab/jobs/8860302002",
      applyUrl: "https://job-boards.greenhouse.io/gitlab/jobs/8860302002",
      companyId: co,
    });
    const r = await run();
    expect(r.code).toBe(0);
    expect(rows(id)).toHaveLength(13);
  });

  it("uses the stored board slug when the apply link is a company page with ?gh_jid=", async () => {
    gh200();
    const id = addPosting({
      applyUrl: "https://about.example.test/careers/job?gh_jid=8860302002",
      link: { type: "ats", ats: "greenhouse", slug: "gitlab" },
    });
    expect((await run()).code).toBe(0);
    expect(rows(id)).toHaveLength(13);
  });

  it("selects only canonical, kept, ATS-type postings", async () => {
    gh200();
    const keep = ghPosting();
    ghPosting({ final: "reject" });
    ghPosting({ final: "suspicious" });
    ghPosting({ final: null });
    ghPosting({ canonical: keep });
    addPosting({ link: { type: "company_form" }, applyUrl: "https://acme.example.test/jobs/1" });
    addPosting({ link: { type: "unknown" } });
    addPosting({ applyUrl: "https://job-boards.greenhouse.io/gitlab/jobs/8860302002" }); // no apply_links row, not an ATS source
    const r = await run();
    expect(r.out).toContain("selected 1, attempted 1");
    expect(requested).toHaveLength(1);
    expect(rows(keep)).toHaveLength(13);
  });

  it("skips ATSs without a public questions endpoint, with the reason and no request", async () => {
    addPosting({
      applyUrl: "https://jobs.lever.co/acme/123e4567-e89b-12d3-a456-426614174000",
      link: { type: "ats", ats: "lever", slug: "acme" },
    });
    addPosting({
      applyUrl: "https://jobs.ashbyhq.com/acme/123e4567-e89b-12d3-a456-426614174000",
      link: { type: "ats", ats: "ashby", slug: "acme" },
    });
    addPosting({
      applyUrl: "https://jobs.smartrecruiters.com/Acme/744000154502129-ops",
      link: { type: "ats", ats: "smartrecruiters", slug: "Acme" },
    });
    addPosting({
      applyUrl: "https://acme.teamtailor.com/jobs/1-dev",
      link: { type: "ats", ats: "teamtailor", slug: "acme" },
    });
    const r = await run();
    expect(r.code).toBe(0);
    expect(requested).toEqual([]);
    expect(r.out).toContain("fetch-questions: selected 4, attempted 0");
    for (const ats of ["lever", "ashby", "smartrecruiters", "teamtailor"]) {
      expect(r.out).toContain(`fetch-questions: skipped 1 (${ats}: ${NO_ENDPOINT})`);
    }
    expect(db.select().from(posting_questions).all()).toEqual([]);
  });

  it("skipped postings do not use up --limit", async () => {
    gh200();
    for (let i = 0; i < 3; i++) {
      addPosting({
        applyUrl: `https://jobs.lever.co/acme/${i}`,
        link: { type: "ats", ats: "lever", slug: "acme" },
        seen: "2026-10-14T00:00:00.000Z",
      });
    }
    const id = ghPosting();
    const r = await run(1);
    expect(r.out).toContain("attempted 1");
    expect(rows(id)).toHaveLength(13);
  });

  it("--limit caps the fetches; the rest wait for the next run; the default cap is 50", async () => {
    expect(DEFAULT_LIMIT).toBe(50);
    gh200();
    const newer = ghPosting({ seen: "2026-10-13T12:00:00.000Z" });
    const older = ghPosting({ seen: "2026-10-12T12:00:00.000Z" });
    const r = await run(1);
    expect(r.out).toContain("selected 2, attempted 1");
    expect(rows(newer)).toHaveLength(13);
    expect(rows(older)).toHaveLength(0);
    expect(requested).toHaveLength(1);
    expect((await run(1)).out).toContain("selected 1, attempted 1"); // only the older one is left
    expect(rows(older)).toHaveLength(13);
  });

  it("rejects a --limit that is not a positive integer", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const r = await run(bad);
      expect(r.code).toBe(1);
      expect(r.err).toContain("--limit must be a positive integer");
    }
  });

  it("does not fetch again inside the window, and does after 7 days", async () => {
    gh200();
    const id = ghPosting();
    await run();
    expect(requested).toHaveLength(1);
    clock = new Date(T0.getTime() + REFETCH_WINDOW_MS - day(1));
    expect((await run()).out).toContain("selected 0");
    expect(requested).toHaveLength(1);
    clock = new Date(T0.getTime() + REFETCH_WINDOW_MS + day(1));
    const r = await run();
    expect(r.out).toContain("selected 1, attempted 1");
    expect(requested).toHaveLength(2);
    expect(rows(id)).toHaveLength(13);
    expect(rows(id)[0]?.fetched_at).toBe(clock.toISOString());
  });

  it("fetches again when the posting was updated after the last fetch", async () => {
    gh200();
    const id = ghPosting();
    await run();
    db.update(postings)
      .set({ updated_at: new Date(T0.getTime() + day(1)).toISOString() })
      .where(eq(postings.id, id))
      .run();
    clock = new Date(T0.getTime() + day(2));
    expect((await run()).out).toContain("selected 1, attempted 1");
  });

  it("never fetches for a posting the owner already decided on; 'later' stays open", async () => {
    gh200();
    const base = {
      reviewed_at: "2026-10-13T10:00:00.000Z",
      review_day: "2026-10-13",
    };
    const done = ghPosting();
    db.insert(reviews)
      .values({ id: "r1", posting_id: done, action: "applied_manually", ...base })
      .run();
    const skip = ghPosting();
    db.insert(reviews)
      .values({ id: "r2", posting_id: skip, action: "not_interested", reason: "role", ...base })
      .run();
    const later = ghPosting();
    db.insert(reviews)
      .values({ id: "r3", posting_id: later, action: "later", ...base })
      .run();
    const reopened = ghPosting();
    db.insert(reviews)
      .values({ id: "r4", posting_id: reopened, action: "interested", ...base })
      .run();
    db.insert(reviews)
      .values({
        id: "r5",
        posting_id: reopened,
        action: "later",
        ...base,
        reviewed_at: "2026-10-13T11:00:00.000Z",
      })
      .run();
    const r = await run();
    expect(r.out).toContain("selected 2, attempted 2");
    expect(rows(done)).toHaveLength(0);
    expect(rows(skip)).toHaveLength(0);
    expect(rows(later)).toHaveLength(13);
    expect(rows(reopened)).toHaveLength(13);
  });

  it("a refetch replaces the rows, drops removed questions and keeps a matched key while the label is unchanged", async () => {
    gh200();
    const id = ghPosting();
    await run();
    const stored = rows(id);
    const linkedin = stored.find((q) => q.question_id === "question_38624168002");
    const phone = stored.find((q) => q.question_id === "phone");
    db.update(posting_questions)
      .set({ matched_key: "links.linkedin" })
      .where(eq(posting_questions.id, linkedin?.id ?? ""))
      .run();
    db.update(posting_questions)
      .set({ matched_key: "contact.phone" })
      .where(eq(posting_questions.id, phone?.id ?? ""))
      .run();
    const changed = structuredClone(fixture("greenhouse-job.json")) as {
      questions: Array<{ label: string; fields: Array<{ name: string }> }>;
    };
    changed.questions = changed.questions
      .filter((q) => q.fields[0]?.name !== "question_38624173002") // removed
      .map((q) => (q.fields[0]?.name === "phone" ? { ...q, label: "Mobile number" } : q)); // reworded
    server.use(http.get(GH_JOB, () => HttpResponse.json(changed)));
    clock = new Date(T0.getTime() + day(8));
    await run();
    const after = rows(id);
    expect(after).toHaveLength(12);
    expect(after.find((q) => q.question_id === "question_38624173002")).toBeUndefined();
    expect(after.find((q) => q.question_id === "question_38624168002")?.matched_key).toBe(
      "links.linkedin",
    );
    expect(after.find((q) => q.question_id === "question_38624168002")?.id).toBe(linkedin?.id);
    expect(after.find((q) => q.question_id === "phone")).toMatchObject({
      label: "Mobile number",
      matched_key: null,
    });
  });

  it("a parse failure is an error line for that posting, stores nothing, keeps old rows, and exits 1", async () => {
    gh200();
    const id = ghPosting();
    await run();
    const before = rows(id);
    server.use(http.get(GH_JOB, () => HttpResponse.json({ id: 1, title: "x" })));
    const other = ghPosting({ applyUrl: "https://job-boards.greenhouse.io/gitlab/jobs/111" });
    server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/gitlab/jobs/111", () =>
        HttpResponse.text("<html>", { status: 200 }),
      ),
    );
    clock = new Date(T0.getTime() + day(8));
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      `fetch-questions: error ${id} greenhouse: greenhouse response does not match the expected shape at questions`,
    );
    expect(r.err).toContain(`fetch-questions: error ${other} greenhouse: response is not JSON`);
    expect(r.out).toContain(
      "greenhouse: fetched 0, questions 0, closed 0, skipped 0, deferred 0, errors 2",
    );
    expect(rows(id)).toEqual(before);
    expect(rows(other)).toEqual([]);
  });

  it("a 404 means the job closed: stored questions stay, no error", async () => {
    gh200();
    const id = ghPosting();
    await run();
    server.use(http.get(GH_JOB, () => new HttpResponse("Not Found", { status: 404 })));
    clock = new Date(T0.getTime() + day(8));
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("greenhouse: fetched 0, questions 0, closed 1");
    expect(rows(id)).toHaveLength(13);
  });

  it("a Recruitee offer that left the board counts as closed", async () => {
    server.use(http.get(RC_OFFERS, () => HttpResponse.json(fixture("recruitee-offers.json"))));
    addPosting({
      applyUrl: "https://careers.bunq.com/o/gone-offer-9",
      link: { type: "ats", ats: "recruitee", slug: "bunq" },
    });
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("recruitee: fetched 0, questions 0, closed 1");
  });

  it("stops a host after 429/403/401 for the rest of the run: deferred, not retried, other hosts go on", async () => {
    for (const status of [429, 403, 401]) {
      requested.length = 0;
      server.use(
        http.get(/boards-api\.greenhouse\.io/, () => new HttpResponse("no", { status })),
        http.get(WK_FORM, () => HttpResponse.json(fixture("workable-form.json"))),
      );
      db.delete(posting_questions).run();
      db.delete(apply_links).run();
      db.delete(intel).run();
      db.delete(analysis).run();
      db.delete(postings).run();
      ghPosting({ applyUrl: "https://job-boards.greenhouse.io/gitlab/jobs/1" });
      ghPosting({ applyUrl: "https://job-boards.greenhouse.io/gitlab/jobs/2" });
      const wk = addPosting({
        applyUrl: "https://apply.workable.com/huggingface/j/81B46579FE/",
        link: { type: "ats", ats: "workable", slug: "huggingface" },
      });
      const r = await run();
      expect(r.code, `status ${status}`).toBe(0);
      expect(r.out).toContain(
        "greenhouse: fetched 0, questions 0, closed 0, skipped 0, deferred 2, errors 0",
      );
      expect(r.out).toContain(`boards-api.greenhouse.io answered HTTP ${status}`);
      expect(requested.filter((u) => u.includes("greenhouse"))).toHaveLength(
        status === 429 ? 3 : 1,
      ); // httpGet retries a 429 twice, once per run
      expect(rows(wk).length).toBeGreaterThan(10);
    }
  });

  it("a server error is an error line and exit 1", async () => {
    server.use(http.get(GH_JOB, () => new HttpResponse("boom", { status: 500 })));
    const id = ghPosting();
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.err).toContain(`fetch-questions: error ${id} greenhouse: HTTP 500`);
  });

  it("only ever sends GET requests", async () => {
    gh200();
    server.use(
      http.get(WK_FORM, () => HttpResponse.json(fixture("workable-form.json"))),
      http.get(RC_OFFERS, () => HttpResponse.json(fixture("recruitee-offers.json"))),
    );
    ghPosting();
    addPosting({
      applyUrl: "https://apply.workable.com/huggingface/j/81B46579FE/",
      link: { type: "ats", ats: "workable", slug: "huggingface" },
    });
    addPosting({
      applyUrl: "https://bunq.recruitee.com/o/head-of-product-6",
      link: { type: "ats", ats: "recruitee", slug: "bunq" },
    });
    await run();
    expect(requested).toHaveLength(3);
    for (const r of requested) expect(r.startsWith("GET ")).toBe(true);
  });

  it("is wired into the CLI as `fetch-questions [--limit n]`", async () => {
    // Neither call reaches the database: usage and option errors come first.
    const err: string[] = [];
    const io = { out: () => undefined, err: (t: string) => err.push(t) };
    expect(await main([], io)).toBe(1);
    expect(err.join("")).toContain("\n  fetch-questions\n");
    err.length = 0;
    expect(await main(["fetch-questions", "--nope"], io)).toBe(1);
    expect(err.join("")).toContain("fetch-questions:");
  });
});
