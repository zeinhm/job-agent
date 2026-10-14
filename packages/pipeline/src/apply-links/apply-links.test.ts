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
    expect(all.out).toMatch(
      /^resolve-apply: checked 4, ats 0 \(db 0, board 0\), unknown 4, requests \d+\n$/,
    );
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
    expect(r.out).toBe("resolve-apply: checked 1, ats 1 (db 1, board 0), unknown 0, requests 0\n");
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
    expect(r.out).toBe("resolve-apply: checked 2, ats 2 (db 0, board 2), unknown 0, requests 1\n");
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
    expect(r.out).toMatch(/ats 0 \(db 0, board 0\), unknown 1, requests 1/);
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
      http.get("https://boards-api.greenhouse.io/*", notFound),
      http.get("https://api.lever.co/*", notFound),
      http.get("https://api.ashbyhq.com/posting-api/job-board/acmelabs", () =>
        ashbyJobs([
          { id: "j1", title: "Senior Frontend Engineer", text: "Acme Labs builds things." },
        ]),
      ),
    );
    const r = await run();
    expect(r.out).toBe("resolve-apply: checked 1, ats 1 (db 0, board 1), unknown 0, requests 3\n");
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
    expect(r1.out).toMatch(/checked 2, ats 0 \(db 0, board 0\), unknown 2, requests 18\n$/);
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
        "resolve-apply: checked 0, ats 0 (db 0, board 0), unknown 0, requests 0\ncompanies.yaml: not found, nothing added\n",
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
