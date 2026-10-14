import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  intel,
  log,
  openDb,
  postings,
  type Db,
} from "@job-agent/core";
import { main } from "../cli.ts";
import { normalizeCompanyName } from "../normalize/index.ts";
import { MAX_SLUG_CANDIDATES, runResolveApply } from "./index.ts";
import { slugCandidates } from "./slugs.ts";

// Hand-built board JSON in the shape of the public ATS APIs (fake companies only).
const ghProbe = (name: string) => HttpResponse.json({ name, content: "" });
const ghJobs = (titles: string[], base = "https://boards.example-ats.test/acme") =>
  HttpResponse.json({
    jobs: titles.map((title, i) => ({ id: i + 1, title, absolute_url: `${base}/jobs/${i + 1}` })),
  });
const ashbyJobs = (jobs: Array<{ title: string; id: string; text?: string }>) =>
  HttpResponse.json({
    jobs: jobs.map((j) => ({
      id: j.id,
      title: j.title,
      jobUrl: `https://jobs.ashbyhq.com/acmelabs/${j.id}`,
      isListed: true,
      descriptionPlain: j.text ?? "",
    })),
  });
const notFound = () => new HttpResponse("Not Found", { status: 404 });
const srEmpty = () => HttpResponse.json({ offset: 0, limit: 100, totalFound: 0, content: [] });

const server = setupServer();
const requested: string[] = [];
const hostCount = (host: string) => requested.filter((u) => new URL(u).hostname === host).length;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

let db: Db;
let clock: Date;
const T0 = new Date("2026-10-14T00:00:00.000Z");
const day = (n: number) => n * 24 * 60 * 60 * 1000;

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
    requested.push(request.url);
  });
});
afterEach(() => {
  server.resetHandlers();
  server.events.removeAllListeners();
  vi.restoreAllMocks();
  db.$client.close();
});

function addCompany(name: string, extra: Partial<typeof companies.$inferInsert> = {}): string {
  const id = randomUUID();
  db.insert(companies)
    .values({
      id,
      name,
      normalized_name: normalizeCompanyName(name),
      created_at: T0.toISOString(),
      ...extra,
    })
    .run();
  return id;
}

let n = 0;
function addPosting(
  source: string,
  title: string,
  companyId: string | null,
  companyName: string,
  opts: {
    decision?: "keep" | "reject";
    final?: "keep" | "reject" | "suspicious" | null;
    /** An intel row with no final decision yet (pending, e.g. no API key). */
    pending?: boolean;
    seen?: string;
    canonical?: string;
    description?: string;
    applyUrl?: string;
  } = {},
): string {
  const id = `p${++n}`;
  db.insert(postings)
    .values({
      id,
      source,
      external_id: id,
      url: `https://${source}.example.test/jobs/${id}`,
      title,
      company_id: companyId,
      company_name: companyName,
      description_text: opts.description ?? null,
      apply_url: opts.applyUrl ?? null,
      first_seen_at: opts.seen ?? "2026-10-13T00:00:00.000Z",
      last_seen_at: "2026-10-13T00:00:00.000Z",
      normalized_at: "2026-10-13T00:00:00.000Z",
      canonical_posting_id: opts.canonical ?? null,
    })
    .run();
  db.insert(analysis)
    .values({
      id: `a-${id}`,
      posting_id: id,
      location_class: "worldwide",
      indonesia_rule: "not_applicable",
      salary_status: "unknown",
      decision: opts.decision ?? "keep",
      analyzed_at: "2026-10-13T00:00:00.000Z",
    })
    .run();
  if (opts.pending || (opts.final !== undefined && opts.final !== null)) {
    db.insert(intel)
      .values({
        id: `i-${id}`,
        posting_id: id,
        status: opts.pending ? "pending" : "done",
        final_decision: opts.pending ? null : (opts.final ?? null),
        updated_at: "2026-10-13T00:00:00.000Z",
      })
      .run();
  }
  return id;
}

async function run(limit?: number) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runResolveApply({
    db,
    limit,
    now: () => clock,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  return { code, out: out.join(""), err: err.join("") };
}
const link = (postingId: string) =>
  db.select().from(apply_links).where(eq(apply_links.posting_id, postingId)).get();
const company = (id: string) => db.select().from(companies).where(eq(companies.id, id)).get();

/** Every ATS answers 404 (SmartRecruiters: 200 with an empty list), counted by the request listener. */
function allBoardsMissing() {
  server.use(
    http.get("https://boards-api.greenhouse.io/*", notFound),
    http.get("https://api.lever.co/*", notFound),
    http.get("https://api.ashbyhq.com/*", notFound),
    http.get("https://api.smartrecruiters.com/*", srEmpty),
    http.get("https://apply.workable.com/*", notFound),
    http.get(/^https:\/\/[a-z0-9-]+\.recruitee\.com\//, notFound),
  );
}

const METHOD_KEYS = ["ats_db", "ats_board", "careers_page", "posting_text", "source"] as const;
const TYPE_KEYS = ["ats", "company_form", "paid_aggregator", "signup_required", "unknown"] as const;
/** The expected summary line; `requests` may be a regex source for "any number". */
function summary(
  checked: number,
  methods: Partial<Record<(typeof METHOD_KEYS)[number], number>>,
  types: Partial<Record<(typeof TYPE_KEYS)[number], number>>,
  requests: number | string,
): string {
  const list = (keys: readonly string[], m: Record<string, number | undefined>) =>
    keys.map((k) => `${k} ${m[k] ?? 0}`).join(", ");
  return `resolve-apply: checked ${checked}, methods: ${list(METHOD_KEYS, methods)}; types: ${list(TYPE_KEYS, types)}; requests ${requests}\n`;
}

describe("slugCandidates", () => {
  it("follows the research rules", () => {
    expect(slugCandidates("Acme Labs, Inc.")).toEqual(["acmelabs", "acme-labs", "acme"]);
    expect(slugCandidates("Typeform")).toEqual(["typeform"]);
    expect(slugCandidates("The Zeta Group GmbH")).toEqual(["zetagroup", "zeta-group", "zeta"]);
    expect(slugCandidates("Global Payments")).toEqual(["globalpayments", "global-payments"]);
    expect(slugCandidates("Hugging Face")).toEqual(["huggingface", "hugging-face", "hugging"]);
    expect(slugCandidates("Bosch Group", true)[0]).toBe("BoschGroup");
    expect(slugCandidates("Crème & Co")[0]).toBe("cremeand");
    expect(slugCandidates("Io")).toEqual([]);
    expect(slugCandidates("A B C D E").length).toBeLessThanOrEqual(MAX_SLUG_CANDIDATES);
  });
});

describe("resolve-apply selection", () => {
  it("selects only kept canonical non-ATS postings without a link, newest first, honouring --limit", async () => {
    allBoardsMissing();
    const c = addCompany("Nobody Inc");
    const old = addPosting("remotive", "Old", c, "Nobody Inc", { seen: "2026-10-01T00:00:00Z" });
    const fresh = addPosting("himalayas", "Fresh", c, "Nobody Inc", {
      seen: "2026-10-13T12:00:00Z",
    });
    const ats = addPosting("greenhouse", "From ATS", c, "Nobody Inc");
    const rejected = addPosting("remotive", "Rejected rule", c, "Nobody Inc", {
      decision: "reject",
    });
    const rejectedIntel = addPosting("remotive", "Rejected intel", c, "Nobody Inc", {
      final: "reject",
    });
    const suspicious = addPosting("remotive", "Suspicious", c, "Nobody Inc", {
      final: "suspicious",
    });
    const dup = addPosting("remotive", "Duplicate", c, "Nobody Inc", { canonical: ats });
    const kept = addPosting("hn", "Kept with intel", c, "Nobody Inc", { final: "keep" });
    const pending = addPosting("hn", "Pending intel", c, "Nobody Inc", {
      pending: true,
      seen: "2026-10-12T00:00:00Z",
    });

    const first = await run(1);
    expect(first.out).toMatch(/^resolve-apply: checked 1, /);
    expect(link(fresh)).toBeDefined(); // newest first_seen_at
    expect(link(kept)).toBeUndefined();
    expect(link(old)).toBeUndefined();
    db.delete(apply_links).run();

    const all = await run();
    expect(all.out).toMatch(new RegExp(`^${summary(4, { source: 4 }, { unknown: 4 }, "\\d+")}$`));
    for (const id of [old, fresh, kept, pending]) expect(link(id)).toBeDefined();
    for (const id of [ats, rejected, rejectedIntel, suspicious, dup])
      expect(link(id)).toBeUndefined();
  });

  it("skips a posting with a link, and re-checks an unknown one only after 7 days", async () => {
    allBoardsMissing();
    const c = addCompany("Nobody Inc");
    const p = addPosting("remotive", "Role", c, "Nobody Inc");
    await run();
    const before = requested.length;
    expect(link(p)?.apply_type).toBe("unknown");

    clock = new Date(T0.getTime() + day(6));
    expect((await run()).out).toMatch(/checked 0,/);
    clock = new Date(T0.getTime() + day(8));
    expect((await run()).out).toMatch(/checked 1,/);
    // The 30-day negative cache still holds, so the re-check made no board request.
    expect(requested.length).toBe(before);
    expect(link(p)?.checked_at).toBe(clock.toISOString());

    db.update(apply_links).set({ apply_type: "ats" }).where(eq(apply_links.posting_id, p)).run();
    clock = new Date(T0.getTime() + day(40));
    expect((await run()).out).toMatch(/checked 0,/);
  });

  it("rejects an invalid --limit", async () => {
    const r = await run(0);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/--limit must be a positive integer/);
  });
});

describe("step 1a: ATS posting in the DB", () => {
  it("matches normalized company + title and makes no request", async () => {
    const c = addCompany("Acme Labs, Inc.");
    const atsId = addPosting("ashby", "Senior Frontend Engineer", c, "Acme Labs");
    const agg = addPosting("remotive", "Senior Frontend Engineer (Remote)", null, "ACME LABS");
    const r = await run();
    expect(r.out).toBe(summary(1, { ats_db: 1 }, { ats: 1 }, 0));
    expect(link(agg)).toMatchObject({
      apply_url: `https://ashby.example.test/jobs/${atsId}`,
      apply_type: "ats",
      method: "ats_db",
      found_on: "remotive",
    });
    expect(requested).toEqual([]);
  });

  it("does not match another title or another company", async () => {
    allBoardsMissing();
    const c = addCompany("Acme Labs");
    addPosting("ashby", "Backend Engineer", c, "Acme Labs");
    const other = addCompany("Other Co");
    addPosting("greenhouse", "Frontend Engineer", other, "Other Co");
    const a = addPosting("remotive", "Frontend Engineer", c, "Acme Labs");
    await run();
    expect(link(a)).toMatchObject({ apply_type: "unknown", method: "source" });
  });
});

describe("step 1b: stored board", () => {
  it("fetches the stored board once per run and matches the title", async () => {
    const c = addCompany("Acme Labs", { ats_type: "greenhouse", ats_slug: "acme", verified: true });
    const a = addPosting("remotive", "Frontend Engineer", c, "Acme Labs", {
      seen: "2026-10-13T02:00:00Z",
    });
    const b = addPosting("himalayas", "Staff Designer", c, "Acme Labs", {
      seen: "2026-10-13T01:00:00Z",
    });
    server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/acme/jobs", () =>
        ghJobs(["Frontend Engineer", "Staff Designer"]),
      ),
    );
    const r = await run();
    expect(r.out).toBe(summary(2, { ats_board: 2 }, { ats: 2 }, 1));
    expect(link(a)).toMatchObject({
      apply_url: "https://boards.example-ats.test/acme/jobs/1",
      method: "ats_board",
      ats_type: "greenhouse",
      ats_slug: "acme",
    });
    expect(link(b)?.apply_url).toBe("https://boards.example-ats.test/acme/jobs/2");
  });

  it("stores unknown with the reason when the board has no matching title, and does not guess slugs", async () => {
    const c = addCompany("Acme Labs", { ats_type: "greenhouse", ats_slug: "acme", verified: true });
    const p = addPosting("remotive", "Frontend Engineer", c, "Acme Labs");
    server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/acme/jobs", () =>
        ghJobs(["Backend Engineer"]),
      ),
    );
    const r = await run();
    expect(r.out).toBe(summary(1, { source: 1 }, { unknown: 1 }, 1));
    expect(link(p)).toMatchObject({
      apply_type: "unknown",
      method: "source",
      reason: "board found, no matching title",
      apply_url: `https://remotive.example.test/jobs/${p}`,
    });
  });
});

describe("step 1c: slug guesses", () => {
  it("finds an Ashby board after a Greenhouse 404 and updates the company", async () => {
    const c = addCompany("Acme Labs, Inc.", { domain: "acmelabs.example" });
    const p = addPosting("remotive", "Senior Frontend Engineer", c, "Acme Labs, Inc.");
    server.use(
      http.get("https://acmelabs.example/*", notFound), // careers pages come first and show nothing
      http.get("https://boards-api.greenhouse.io/*", notFound),
      http.get("https://api.lever.co/*", notFound),
      http.get("https://api.ashbyhq.com/posting-api/job-board/acmelabs", () =>
        ashbyJobs([
          { id: "j1", title: "Senior Frontend Engineer", text: "Acme Labs builds things." },
        ]),
      ),
    );
    const r = await run();
    expect(r.out).toBe(summary(1, { ats_board: 1 }, { ats: 1 }, 5));
    expect(link(p)).toMatchObject({
      apply_url: "https://jobs.ashbyhq.com/acmelabs/j1",
      apply_type: "ats",
      method: "ats_board",
      ats_type: "ashby",
      ats_slug: "acmelabs",
    });
    expect(company(c)).toMatchObject({
      ats_type: "ashby",
      ats_slug: "acmelabs",
      discovered_via: "apply_resolve",
      verified: true,
      ats_checked_at: clock.toISOString(),
    });
  });

  it("uses the Greenhouse name probe first and downloads jobs only for the same company", async () => {
    const c = addCompany("Acme Labs");
    const p = addPosting("remotive", "Frontend Engineer", c, "Acme Labs");
    server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/acmelabs", () => ghProbe("Acme Labs")),
      http.get("https://boards-api.greenhouse.io/v1/boards/acmelabs/jobs", () =>
        ghJobs(["Frontend Engineer"]),
      ),
    );
    await run();
    expect(requested).toEqual([
      "https://boards-api.greenhouse.io/v1/boards/acmelabs",
      "https://boards-api.greenhouse.io/v1/boards/acmelabs/jobs",
    ]);
    expect(link(p)).toMatchObject({ method: "ats_board", ats_type: "greenhouse" });
  });

  it("saves a found board even when no title matches (unknown, reason), so discover polls it", async () => {
    const c = addCompany("Acme Labs");
    const p = addPosting("remotive", "Frontend Engineer", c, "Acme Labs");
    server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/acmelabs", () => ghProbe("Acme Labs")),
      http.get("https://boards-api.greenhouse.io/v1/boards/acmelabs/jobs", () =>
        ghJobs(["Backend Engineer"]),
      ),
    );
    await run();
    expect(link(p)).toMatchObject({
      apply_type: "unknown",
      method: "source",
      reason: "board found, no matching title",
    });
    expect(company(c)).toMatchObject({
      ats_type: "greenhouse",
      ats_slug: "acmelabs",
      discovered_via: "apply_resolve",
      verified: true,
    });
  });

  it("does not use a 200 board that fails the same-company check", async () => {
    const c = addCompany("Acme Labs");
    const p = addPosting("remotive", "Frontend Engineer", c, "Acme Labs");
    allBoardsMissing();
    server.use(
      // Greenhouse: a different company owns the slug. The name probe rejects it before any job download.
      http.get("https://boards-api.greenhouse.io/v1/boards/acmelabs", () =>
        ghProbe("Totally Different"),
      ),
      http.get("https://boards-api.greenhouse.io/v1/boards/acmelabs/jobs", () => {
        throw new Error("jobs must not be downloaded for a foreign board");
      }),
      // Workable: other name, same title -> still not the same company.
      http.get("https://apply.workable.com/api/v1/widget/accounts/acme", () =>
        HttpResponse.json({
          name: "Unrelated Corp",
          jobs: [
            {
              title: "Frontend Engineer",
              shortcode: "AB12",
              url: "https://apply.workable.com/j/AB12",
            },
          ],
        }),
      ),
      // Ashby: no name; title matches but nothing ties it to Acme Labs.
      http.get("https://api.ashbyhq.com/posting-api/job-board/acme-labs", () =>
        ashbyJobs([{ id: "x", title: "Frontend Engineer", text: "We are Someone Else." }]),
      ),
    );
    await run();
    expect(link(p)).toMatchObject({ apply_type: "unknown", reason: "no ATS board found" });
    expect(company(c)).toMatchObject({ ats_type: null, ats_slug: null, discovered_via: null });
    expect(company(c)?.ats_checked_at).toBe(clock.toISOString());
  });

  it("asks at most 3 slugs x 6 hosts per company, then the 30-day cache prevents another lookup", async () => {
    const c = addCompany("Acme Labs, Inc.");
    addPosting("remotive", "Frontend Engineer", c, "Acme Labs, Inc.");
    addPosting("himalayas", "Backend Engineer", c, "Acme Labs, Inc.");
    allBoardsMissing();
    const r1 = await run();
    expect(r1.out).toBe(summary(2, { source: 2 }, { unknown: 2 }, 18));
    expect(requested).toHaveLength(MAX_SLUG_CANDIDATES * 6);
    for (const host of [
      "boards-api.greenhouse.io",
      "api.lever.co",
      "api.ashbyhq.com",
      "api.smartrecruiters.com",
      "apply.workable.com",
    ])
      expect(hostCount(host)).toBe(MAX_SLUG_CANDIDATES);
    for (const slug of ["acmelabs", "acme-labs", "acme"])
      expect(requested).toContain(`https://${slug}.recruitee.com/api/offers/`);
    expect(company(c)?.ats_checked_at).toBe(clock.toISOString());

    // Re-check the unknown rows after 8 days: still inside the 30-day negative cache -> no request.
    requested.length = 0;
    clock = new Date(T0.getTime() + day(8));
    const r2 = await run();
    expect(r2.out).toMatch(/checked 2, .*requests 0\n$/);
    expect(requested).toEqual([]);

    // After 31 days the company is searched again.
    clock = new Date(T0.getTime() + day(31));
    const r3 = await run();
    expect(r3.out).toMatch(/requests 18\n$/);
  });

  it("stops lookups on a host after a 429 and does not cache the incomplete lookup", async () => {
    const c1 = addCompany("Acme Labs");
    const c2 = addCompany("Beta Works");
    const p1 = addPosting("remotive", "Role One", c1, "Acme Labs", {
      seen: "2026-10-13T02:00:00Z",
    });
    const p2 = addPosting("remotive", "Role Two", c2, "Beta Works", {
      seen: "2026-10-13T01:00:00Z",
    });
    allBoardsMissing();
    server.use(
      http.get(
        "https://boards-api.greenhouse.io/*",
        () => new HttpResponse("slow down", { status: 429 }),
      ),
    );
    await run();
    // httpGet retries a 429 twice (3 requests) before giving up; the second company never touches Greenhouse.
    expect(hostCount("boards-api.greenhouse.io")).toBe(3);
    expect(link(p1)?.apply_type).toBe("unknown");
    expect(link(p2)?.apply_type).toBe("unknown");
    expect(company(c1)?.ats_checked_at).toBeNull();
    expect(company(c2)?.ats_checked_at).toBeNull();
  });

  it("counts a network error as expected and keeps going", async () => {
    const c = addCompany("Acme Labs");
    const p = addPosting("remotive", "Frontend Engineer", c, "Acme Labs");
    allBoardsMissing();
    server.use(http.get("https://api.lever.co/*", () => HttpResponse.error()));
    const r = await run();
    expect(r.code).toBe(0);
    expect(link(p)?.apply_type).toBe("unknown");
    expect(company(c)?.ats_checked_at).toBeNull();
  });

  it("makes no LLM request (msw errors on any unhandled host)", async () => {
    const c = addCompany("Acme Labs");
    addPosting("remotive", "Frontend Engineer", c, "Acme Labs");
    allBoardsMissing();
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    await run();
    vi.unstubAllEnvs();
    expect(requested.some((u) => u.includes("anthropic"))).toBe(false);
    expect(db.$client.prepare("SELECT COUNT(*) AS n FROM llm_calls").get()).toEqual({ n: 0 });
  });
});

describe("resolve-apply CLI", () => {
  it("runs through main() with --limit and prints the summary line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "job-agent-apply-"));
    vi.stubEnv("JOB_AGENT_DB", join(dir, "data", "t.db"));
    vi.stubEnv("JOB_AGENT_CONFIG_DIR", join(dir, "config"));
    try {
      const out: string[] = [];
      const err: string[] = [];
      const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };
      expect(await main(["resolve-apply", "--limit", "5"], io)).toBe(0);
      expect(out.join("")).toBe(
        summary(0, {}, {}, 0) + "companies.yaml: not found, nothing added\n",
      );
      // A company found earlier is appended to the temp companies.yaml, backup under <db dir>/backups.
      const seeded = openDb(join(dir, "data", "t.db"));
      seeded
        .insert(companies)
        .values({
          id: randomUUID(),
          name: "Omega Works",
          normalized_name: normalizeCompanyName("Omega Works"),
          ats_type: "lever",
          ats_slug: "omegaworks",
          discovered_via: "apply_resolve",
          verified: true,
          created_at: T0.toISOString(),
        })
        .run();
      seeded.$client.close();
      mkdirSync(join(dir, "config"));
      writeFileSync(
        join(dir, "config", "companies.yaml"),
        "companies:\n  - { name: Keep Me, ats: greenhouse, slug: keepme }\n",
      );
      out.length = 0;
      expect(await main(["resolve-apply"], io)).toBe(0);
      expect(readFileSync(join(dir, "config", "companies.yaml"), "utf8")).toMatch(
        /^companies:\n {2}- \{ name: Keep Me, ats: greenhouse, slug: keepme \}\n {2}- \{ name: Omega Works, ats: lever, slug: omegaworks \} {2}# added by job-agent \d{4}-\d\d-\d\d \(apply resolve\)\n$/,
      );
      expect(readdirSync(join(dir, "data", "backups"))).toHaveLength(1);
      expect(out.join("")).toContain("companies.yaml: added 1 (backup ");
      expect(await main(["resolve-apply", "--limit", "x"], io)).toBe(1);
      expect(await main(["resolve-apply", "--bogus"], io)).toBe(1);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const careersHtml = (body: string) => `<html><body><h1>Careers</h1>${body}</body></html>`;
const html = (body: string) =>
  new HttpResponse(careersHtml(body), { headers: { "content-type": "text/html" } });

describe("step 2: careers page", () => {
  const DOMAIN = "acmelabs.example";
  const TITLE = "Senior Frontend Engineer";
  function setup() {
    const c = addCompany("Acme Labs", { domain: DOMAIN });
    const p = addPosting("remotive", TITLE, c, "Acme Labs");
    return { c, p };
  }

  it.each([
    {
      name: "Greenhouse embed script",
      body: `<div id="grnhse_app"></div><script src="https://boards.greenhouse.io/embed/job_board/js?for=acmelabs"></script>`,
      api: () =>
        http.get("https://boards-api.greenhouse.io/v1/boards/acmelabs/jobs", () =>
          ghJobs([TITLE], "https://acmelabs.example/jobs/search?gh_jid="),
        ),
      expected: { ats_type: "greenhouse", ats_slug: "acmelabs" },
      url: "https://acmelabs.example/jobs/search?gh_jid=/jobs/1",
    },
    {
      name: "Greenhouse hosted board link",
      body: `<a href="https://job-boards.greenhouse.io/acmelabs">Open roles</a>`,
      api: () =>
        http.get("https://boards-api.greenhouse.io/v1/boards/acmelabs/jobs", () =>
          ghJobs([TITLE], "https://job-boards.greenhouse.io/acmelabs"),
        ),
      expected: { ats_type: "greenhouse", ats_slug: "acmelabs" },
      url: "https://job-boards.greenhouse.io/acmelabs/jobs/1",
    },
    {
      name: "Lever hosted link",
      body: `<a href="https://jobs.lever.co/acmelabs">Jobs</a>`,
      api: () =>
        http.get("https://api.lever.co/v0/postings/acmelabs", () =>
          HttpResponse.json([
            {
              text: TITLE,
              hostedUrl: "https://jobs.lever.co/acmelabs/abc-1",
              descriptionPlain: "",
            },
          ]),
        ),
      expected: { ats_type: "lever", ats_slug: "acmelabs" },
      url: "https://jobs.lever.co/acmelabs/abc-1",
    },
    {
      name: "Ashby embed script",
      body: `<div id="ashby_embed"></div><script src="https://jobs.ashbyhq.com/acmelabs/embed?version=2"></script>`,
      api: () =>
        http.get("https://api.ashbyhq.com/posting-api/job-board/acmelabs", () =>
          ashbyJobs([{ title: TITLE, id: "j1" }]),
        ),
      expected: { ats_type: "ashby", ats_slug: "acmelabs" },
      url: "https://jobs.ashbyhq.com/acmelabs/j1",
    },
    {
      name: "Workable hosted link",
      body: `<a href="https://apply.workable.com/acmelabs/">Join us</a>`,
      api: () =>
        http.get("https://apply.workable.com/api/v1/widget/accounts/acmelabs", () =>
          HttpResponse.json({
            name: "Acme Labs",
            jobs: [
              { title: TITLE, shortcode: "AB12", shortlink: "https://apply.workable.com/j/AB12" },
            ],
          }),
        ),
      expected: { ats_type: "workable", ats_slug: "acmelabs" },
      url: "https://apply.workable.com/j/AB12",
    },
    {
      name: "Recruitee subdomain link",
      body: `<a href="https://acmelabs.recruitee.com/">Jobs</a>`,
      api: () =>
        http.get("https://acmelabs.recruitee.com/api/offers/", () =>
          HttpResponse.json({
            offers: [
              {
                title: TITLE,
                careers_url: "https://acmelabs.recruitee.com/o/fe",
                company_name: "Acme Labs",
              },
            ],
          }),
        ),
      expected: { ats_type: "recruitee", ats_slug: "acmelabs" },
      url: "https://acmelabs.recruitee.com/o/fe",
    },
  ])(
    "$name -> ats via careers_page, no blind slug probes",
    async ({ body, api, expected, url }) => {
      const { c, p } = setup();
      server.use(
        http.get(`https://${DOMAIN}/careers`, () => html(body)),
        api(),
      );
      const r = await run();
      expect(r.out).toBe(summary(1, { careers_page: 1 }, { ats: 1 }, 2));
      expect(link(p)).toMatchObject({
        apply_type: "ats",
        method: "careers_page",
        apply_url: url,
        ...expected,
      });
      expect(requested).toEqual([
        `https://${DOMAIN}/careers`,
        expect.stringContaining(expected.ats_slug),
      ]);
      expect(company(c)).toMatchObject({
        ats_type: expected.ats_type,
        ats_slug: "acmelabs",
        verified: true,
      });
    },
  );

  it("falls back to /jobs when /careers shows no ATS", async () => {
    const { p } = setup();
    server.use(
      http.get(`https://${DOMAIN}/careers`, () => html("<p>We are hiring</p>")),
      http.get(`https://${DOMAIN}/jobs`, () =>
        html(`<a href="https://jobs.lever.co/acmelabs">Jobs</a>`),
      ),
      http.get("https://api.lever.co/v0/postings/acmelabs", () =>
        HttpResponse.json([
          { text: TITLE, hostedUrl: "https://jobs.lever.co/acmelabs/z9", descriptionPlain: "" },
        ]),
      ),
    );
    await run();
    expect(link(p)).toMatchObject({
      method: "careers_page",
      apply_url: "https://jobs.lever.co/acmelabs/z9",
    });
  });

  it("non-pollable ATS: a job link whose text is the title -> ats", async () => {
    const { p } = setup();
    server.use(
      http.get(`https://${DOMAIN}/careers`, () =>
        html(
          `<a href="https://acmelabs.teamtailor.com/jobs/77-other-role">Other Role</a>
           <a href="https://acmelabs.teamtailor.com/jobs/78-fe"> Senior  Frontend Engineer </a>`,
        ),
      ),
    );
    const r = await run();
    expect(r.out).toBe(summary(1, { careers_page: 1 }, { ats: 1 }, 1));
    expect(link(p)).toMatchObject({
      apply_type: "ats",
      method: "careers_page",
      apply_url: "https://acmelabs.teamtailor.com/jobs/78-fe",
      ats_type: "teamtailor",
      ats_slug: "acmelabs",
    });
  });

  it("non-pollable ATS: a board link only -> company_form with the board URL", async () => {
    const { p } = setup();
    server.use(
      http.get(`https://${DOMAIN}/careers`, () =>
        html(`<a href="https://acmelabs.jobs.personio.de/job/5?language=en">Other Role</a>`),
      ),
    );
    await run();
    expect(link(p)).toMatchObject({
      apply_type: "company_form",
      method: "careers_page",
      apply_url: "https://acmelabs.jobs.personio.de/",
      ats_type: "personio",
    });
  });

  it("a ?gh_jid= job link on the company site whose text is the title -> ats (greenhouse)", async () => {
    const { p } = setup();
    server.use(
      http.get(`https://${DOMAIN}/careers`, () =>
        html(`<a href="/jobs/search?gh_jid=8172510">${TITLE}</a>`),
      ),
    );
    await run();
    expect(link(p)).toMatchObject({
      apply_type: "ats",
      method: "careers_page",
      apply_url: "https://acmelabs.example/jobs/search?gh_jid=8172510",
      ats_type: "greenhouse",
    });
  });

  it("makes at most 2 page requests, then goes on with the slug guesses", async () => {
    const { p } = setup();
    allBoardsMissing();
    server.use(http.get(`https://${DOMAIN}/*`, notFound));
    const r = await run();
    expect(requested.filter((u) => u.startsWith(`https://${DOMAIN}/`))).toEqual([
      `https://${DOMAIN}/careers`,
      `https://${DOMAIN}/jobs`,
    ]);
    expect(r.out).toBe(summary(1, { source: 1 }, { unknown: 1 }, 2 + MAX_SLUG_CANDIDATES * 6));
    expect(link(p)?.reason).toBe("no ATS board found; careers page: HTTP 404, HTTP 404");
  });

  it("does not follow a redirect to another host", async () => {
    const { p } = setup();
    allBoardsMissing();
    let evilHits = 0;
    server.use(
      http.get(`https://${DOMAIN}/careers`, () =>
        HttpResponse.redirect("https://careers-elsewhere.example/careers", 302),
      ),
      http.get(`https://${DOMAIN}/jobs`, notFound),
      http.get("https://careers-elsewhere.example/*", () => {
        evilHits++;
        return html(`<a href="https://jobs.lever.co/acmelabs">x</a>`);
      }),
    );
    await run();
    expect(evilHits).toBe(0);
    expect(hostCount("careers-elsewhere.example")).toBe(0);
    expect(link(p)).toMatchObject({ apply_type: "unknown" });
    // Nothing found on the page: the slug guesses ran and the redirect is named in the reason.
    expect(link(p)?.reason).toContain("redirected off-site");
  });

  it("never requests a LinkedIn domain", async () => {
    const c = addCompany("Acme Labs", { domain: "linkedin.com", discovered_via: "config" });
    addPosting("remotive", TITLE, c, "Acme Labs");
    allBoardsMissing();
    await run();
    expect(requested.filter((u) => new URL(u).hostname.endsWith("linkedin.com"))).toEqual([]);
  });

  it("domain trust: an HN-only domain that does not resemble the company is not fetched", async () => {
    const c = addCompany("Zephyr Systems", { domain: "unrelated-example.test" });
    const p = addPosting("hn", TITLE, c, "Zephyr Systems", {
      applyUrl: "https://unrelated-example.test/jobs",
    });
    allBoardsMissing();
    await run();
    expect(hostCount("unrelated-example.test")).toBe(0);
    expect(link(p)?.reason).toContain("careers page skipped");
    expect(link(p)?.reason).toContain("HN comments");
  });

  it("domain trust: an HN-only domain that resembles the company name is fetched", async () => {
    const c = addCompany("Zephyr Systems", { domain: "zephyr.example" });
    addPosting("hn", TITLE, c, "Zephyr Systems");
    allBoardsMissing();
    server.use(http.get("https://zephyr.example/*", notFound));
    await run();
    expect(hostCount("zephyr.example")).toBe(2);
  });

  it("domain trust: a domain a non-HN posting links to is fetched even when the name differs", async () => {
    const c = addCompany("Zephyr Systems", { domain: "unrelated-example.test" });
    addPosting("hn", TITLE, c, "Zephyr Systems");
    addPosting("remotive", "Backend Engineer", c, "Zephyr Systems", {
      applyUrl: "https://unrelated-example.test/apply/1",
    });
    allBoardsMissing();
    server.use(http.get("https://unrelated-example.test/*", notFound));
    await run();
    expect(hostCount("unrelated-example.test")).toBe(2);
  });

  it("skips the careers pages when the company was fully checked within 30 days", async () => {
    const c = addCompany("Acme Labs", { domain: DOMAIN, ats_checked_at: T0.toISOString() });
    addPosting("remotive", TITLE, c, "Acme Labs");
    await run();
    expect(requested).toEqual([]);
  });
});

describe("step 3: apply links in the posting text", () => {
  const DOMAIN = "acmelabs.example";
  function setup(
    description: string,
    extra: { source?: string; applyUrl?: string; domain?: string | null } = {},
  ) {
    const c = addCompany("Acme Labs", {
      domain: extra.domain === undefined ? DOMAIN : extra.domain,
      discovered_via: "config",
    });
    const p = addPosting(extra.source ?? "hn", "Senior Frontend Engineer", c, "Acme Labs", {
      description,
      ...(extra.applyUrl ? { applyUrl: extra.applyUrl } : {}),
    });
    allBoardsMissing();
    server.use(http.get(`https://${DOMAIN}/*`, notFound));
    return p;
  }

  it("HN comment with a jobs.lever.co link (entity-escaped, as HN serves it) -> ats via posting_text", async () => {
    const p = setup(
      `Acme Labs | Senior Frontend Engineer | REMOTE<p>Apply at <a href="https:&#x2F;&#x2F;jobs.lever.co&#x2F;acmelabs&#x2F;1f2e3d4c" rel="nofollow">https:&#x2F;&#x2F;jobs.lever.co&#x2F;acmelabs&#x2F;1f2e3...</a>`,
    );
    await run();
    expect(link(p)).toMatchObject({
      apply_type: "ats",
      method: "posting_text",
      apply_url: "https://jobs.lever.co/acmelabs/1f2e3d4c",
      ats_type: "lever",
      ats_slug: "acmelabs",
    });
  });

  it("an ATS job URL beats a company-domain link", async () => {
    const p = setup(
      `Apply at https://acmelabs.example/careers or directly https://jobs.ashbyhq.com/acmelabs/0a1b2c3d-0a1b-4c3d-8e9f-0a1b2c3d4e5f`,
    );
    await run();
    expect(link(p)).toMatchObject({ apply_type: "ats", ats_type: "ashby", method: "posting_text" });
  });

  it("works for a posting without a company row", async () => {
    const id = addPosting("remoteok", "Senior Frontend Engineer", null, "Nobody", {
      description: "<p>Apply at https://boards.greenhouse.io/nobody/jobs/123.</p>",
    });
    await run();
    expect(link(id)).toMatchObject({
      apply_type: "ats",
      method: "posting_text",
      apply_url: "https://boards.greenhouse.io/nobody/jobs/123",
    });
  });

  it("only a mailto: link at the company domain -> company_form", async () => {
    const p = setup(
      `Acme Labs | Engineer<p>Questions? <a href="mailto:jobs@acmelabs.example">write to us</a>`,
    );
    await run();
    expect(link(p)).toMatchObject({
      apply_type: "company_form",
      method: "posting_text",
      apply_url: "mailto:jobs@acmelabs.example",
    });
  });

  it("an e-mail in 'send your resume to' wording at the company domain -> company_form", async () => {
    const p = setup(`Please send your resume and a short cover letter to hiring@acmelabs.example.`);
    await run();
    expect(link(p)).toMatchObject({
      apply_type: "company_form",
      apply_url: "mailto:hiring@acmelabs.example",
    });
  });

  it("a company-domain link after apply wording -> company_form", async () => {
    const p = setup(`Apply here: https://acmelabs.example/open-roles/frontend`);
    await run();
    expect(link(p)).toMatchObject({
      apply_type: "company_form",
      method: "posting_text",
      apply_url: "https://acmelabs.example/open-roles/frontend",
    });
  });

  it("board, shortener and LinkedIn links and other people's mailboxes never count as the company's own", async () => {
    const p = setup(
      `Apply at https://bit.ly/abc123 or https://www.linkedin.com/jobs/view/1 or https://remoteok.com/remote-jobs/1 or send your resume to someone@example.org`,
    );
    await run();
    expect(link(p)).toMatchObject({ apply_type: "unknown", method: "source" });
  });

  it("a YC link in the posting text is never requested and the run finishes", async () => {
    const p = setup(
      `Apply at https://www.ycombinator.com/companies/x/jobs/y or https://www.workatastartup.com/jobs/1`,
    );
    await run();
    expect(
      requested.filter((u) => /(^|\.)(ycombinator|workatastartup)\.com$/.test(new URL(u).hostname)),
    ).toEqual([]);
    expect(link(p)).toBeDefined();
  });

  it("a careers page redirecting to a YC host is not followed and the run finishes", async () => {
    const p = setup(`No link here.`);
    server.use(
      http.get(`https://${DOMAIN}/careers`, () =>
        HttpResponse.redirect("https://www.ycombinator.com/companies/x/jobs", 302),
      ),
    );
    await run();
    expect(requested.filter((u) => new URL(u).hostname.endsWith("ycombinator.com"))).toEqual([]);
    expect(link(p)).toMatchObject({ apply_type: "unknown" });
  });

  it("a link on another company's domain is not the company's own", async () => {
    const p = setup(`Apply at https://other-company.example/careers`);
    await run();
    expect(link(p)).toMatchObject({ apply_type: "unknown" });
  });

  it("only a paid-only host -> paid_aggregator", async () => {
    const p = setup(`Apply through https://www.flexjobs.com/jobs/12345`);
    await run();
    expect(link(p)).toMatchObject({
      apply_type: "paid_aggregator",
      apply_url: "https://www.flexjobs.com/jobs/12345",
    });
  });

  it("a paid-only source link with no other route -> paid_aggregator", async () => {
    const p = setup("No link here.", { source: "remotive", applyUrl: "https://remote.co/job/9" });
    await run();
    expect(link(p)).toMatchObject({
      apply_type: "paid_aggregator",
      apply_url: "https://remote.co/job/9",
    });
  });

  it("a free route beats the paid-only host", async () => {
    const p = setup(
      `See https://www.flexjobs.com/jobs/1 or apply at https://jobs.lever.co/acmelabs/abc`,
    );
    await run();
    expect(link(p)).toMatchObject({ apply_type: "ats", method: "posting_text" });
  });

  it("a Himalayas listing with no other route -> signup_required, never fetched", async () => {
    const p = setup("Great job.", {
      source: "himalayas",
      applyUrl: "https://himalayas.app/companies/acme/jobs/frontend",
    });
    await run();
    expect(link(p)).toMatchObject({
      apply_type: "signup_required",
      method: "source",
      apply_url: "https://himalayas.app/companies/acme/jobs/frontend",
    });
    expect(hostCount("himalayas.app")).toBe(0);
  });

  it("a Himalayas listing whose text names an ATS job URL -> ats", async () => {
    const p = setup("Apply at https://jobs.lever.co/acmelabs/xyz", {
      source: "himalayas",
      applyUrl: "https://himalayas.app/companies/acme/jobs/frontend",
    });
    await run();
    expect(link(p)).toMatchObject({ apply_type: "ats", method: "posting_text" });
  });

  it("with no company domain a mailto does not count", async () => {
    const p = setup(`<a href="mailto:jobs@acmelabs.example">mail</a>`, { domain: null });
    await run();
    expect(link(p)).toMatchObject({ apply_type: "unknown" });
  });
});
