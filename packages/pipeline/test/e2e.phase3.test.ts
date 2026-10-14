import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __testInjectTimeAndSleep,
  analysis,
  apply_links,
  companies,
  fetchAndStoreFx,
  intel,
  llm_calls,
  loadConfig,
  loadCv,
  log,
  openDb,
  postings,
  source_runs,
  type Db,
} from "@job-agent/core";
import {
  createIndeedAdapter,
  createLinkedInAdapter,
  createLinkedinPostsAdapter,
} from "@job-agent/sources";
import { eq } from "drizzle-orm";
import { http, HttpResponse, type HttpHandler } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { APPLY_LINK_MAX_TOKENS } from "../src/apply-links/llm-step.ts";
import { runResolveApply } from "../src/apply-links/index.ts";
import { runDigest } from "../src/digest/index.ts";
import { runDiscover } from "../src/discover.ts";
import { runEnrich } from "../src/enrich.ts";
import { EXTRACT_PROMPT_VERSION } from "../src/intel/extract.ts";
import { runProcess } from "../src/process.ts";

// Phase 3 chain, offline: JobSpy worker output (LinkedIn, Indeed) + Brave results (LinkedIn posts) -> discover ->
// process -> enrich (Anthropic via msw, one re-extraction) -> resolve-apply (ATS boards via msw, one Haiku pick,
// companies.yaml append) -> digest. Only hand-built fixtures and the example configs (fake persona); no live call.
// Not covered because their cards were dropped by the owner or are not merged: YC jobs, JobStreet, Threads.

const repo = new URL("../../../", import.meta.url);
const read = (rel: string, base = repo) => readFileSync(new URL(rel, base), "utf8");
const anthropicFixture = (name: string) =>
  JSON.parse(read(`fixtures/anthropic/${name}`, new URL("./", import.meta.url))) as {
    content: { type: string; text?: string }[];
  };

const NOW = new Date("2026-10-14T06:00:00Z");
const ENV = { ANTHROPIC_API_KEY: "sk-ant-e2e-fake-0000" };
const API = "https://api.anthropic.com/v1/messages";

const COMPANIES_YAML = `# fake e2e config
companies:
  - { name: "Orbit Works", ats: greenhouse, slug: "orbitworks" } # keep this comment
`;

const BODY = (extra: string) =>
  "<p>We build a product UI with React and TypeScript, own Next.js performance and ship weekly. " +
  "Senior engineers work with a small team and a listed pay range. " +
  `${extra}</p>`;

/** JobSpy worker lines (the `Job` shape of packages/sources/src/jobspy/index.ts). */
const jobLine = (
  site: "linkedin" | "indeed",
  id: string,
  title: string,
  company: string,
  description: string,
  extra: Record<string, unknown> = {},
) =>
  JSON.stringify({
    id: `${site === "linkedin" ? "li" : "in"}-${id}`,
    site,
    job_url:
      site === "linkedin"
        ? `https://www.linkedin.com/jobs/view/${id}`
        : `https://www.indeed.com/viewjob?jk=${id}`,
    title,
    company,
    location: "Worldwide",
    date_posted: "2026-10-14T00:00:00.000",
    is_remote: true,
    description,
    ...extra,
  });

const NIMBUS = "Nimbus Labs";
const FORMCRAFT = "Formcraft";
const PAPERLINE = "Paperline";
const HARBORLINE = "Harborline";
const QUILLBASE = "Quillbase";

const LINKEDIN_LINES = [
  // A copy of a job whose ATS board is not in companies.yaml yet: resolve-apply must find the board.
  jobLine("linkedin", "3100001", "Senior Frontend Engineer", NIMBUS, BODY("Hours: Europe.")),
  // Typeform-style: the source says worldwide, the text restricts hiring to countries without Indonesia.
  jobLine(
    "linkedin",
    "3100002",
    "Senior Frontend Engineer",
    FORMCRAFT,
    BODY(
      "We can only hire in the United Kingdom, Ireland, Germany, Portugal, Spain and the Netherlands.",
    ),
  ),
].join("\n");

const INDEED_LINES = [
  // The only route is a paid-only site: stays listed with the label.
  jobLine(
    "indeed",
    "aa11",
    "Senior Full Stack Engineer",
    PAPERLINE,
    BODY("See the posting at https://www.flexjobs.com/jobs/paperline-fullstack for details."),
  ),
  // Two company-site links and no ATS link: one Haiku call picks one of them.
  jobLine(
    "indeed",
    "bb22",
    "Senior React Engineer",
    HARBORLINE,
    BODY(
      "Apply via https://harborline-apps.example.test/apply/react or read " +
        "https://harborline-apps.example.test/about to learn about the team.",
    ),
  ),
].join("\n");

const BRAVE_RESULT = {
  url: "https://www.linkedin.com/posts/example-person_hiring-react-activity-7000000000000000000-AbCd",
  title: `Example Person on LinkedIn: Join ${QUILLBASE}, we are hiring a senior frontend engineer`,
  description: "Remote, worldwide. Senior frontend engineer with React and TypeScript.",
};

const fxFixture = {
  ...(JSON.parse(read("packages/core/test/fixtures/fx/er-api-usd.json")) as Record<
    string,
    unknown
  >),
  time_last_update_unix: NOW.getTime() / 1000,
};

const notFound = () => new HttpResponse("Not Found", { status: 404 });
const srEmpty = () => HttpResponse.json({ offset: 0, limit: 100, totalFound: 0, content: [] });

/** The public ATS APIs that resolve-apply looks up. Unknown boards answer 404 (SmartRecruiters: an empty list). */
function atsHandlers(): HttpHandler[] {
  return [
    http.get("https://boards-api.greenhouse.io/v1/boards/nimbuslabs", () =>
      HttpResponse.json({ name: NIMBUS, content: "" }),
    ),
    http.get("https://boards-api.greenhouse.io/v1/boards/nimbuslabs/jobs", () =>
      HttpResponse.json({
        jobs: [
          {
            id: 7001,
            title: "Senior Frontend Engineer",
            absolute_url: "https://boards.greenhouse.io/nimbuslabs/jobs/7001",
          },
        ],
      }),
    ),
    http.get("https://boards-api.greenhouse.io/v1/boards/:slug/jobs", notFound),
    http.get("https://boards-api.greenhouse.io/v1/boards/:slug", notFound),
    http.get("https://api.lever.co/v0/postings/:slug", notFound),
    http.get("https://api.ashbyhq.com/posting-api/job-board/:slug", notFound),
    http.get("https://api.smartrecruiters.com/v1/companies/:slug/postings", srEmpty),
    http.get("https://apply.workable.com/api/v1/widget/accounts/:slug", notFound),
    http.get("https://*.recruitee.com/api/offers/", notFound),
  ];
}

function baseHandlers(): HttpHandler[] {
  return [
    http.get("https://open.er-api.com/v6/latest/USD", () => HttpResponse.json(fxFixture)),
    http.get("https://api.search.brave.com/res/v1/web/search", () =>
      HttpResponse.json({ web: { results: [BRAVE_RESULT] } }),
    ),
    // Domain-age lookups for the scam stage: the registry is unreachable, which must not break the run.
    http.get("https://data.iana.org/rdap/dns.json", () => new HttpResponse(null, { status: 503 })),
    ...atsHandlers(),
  ];
}

interface LlmRequest {
  model: string;
  max_tokens: number;
  messages: { content: unknown }[];
}
let llmRequests: LlmRequest[] = [];
const applyLinkRequests = () => llmRequests.filter((q) => q.max_tokens === APPLY_LINK_MAX_TOKENS);
const extractRequests = () =>
  llmRequests.filter(
    (q) => q.model !== "claude-sonnet-5-5" && q.max_tokens !== APPLY_LINK_MAX_TOKENS,
  );

const reply = (text: string) => ({
  _handbuilt: true,
  id: "msg_fixture_e2e3",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 1200,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 12,
  },
});

const llmHandler = http.post(API, async ({ request }) => {
  const body = (await request.json()) as LlmRequest;
  llmRequests.push(body);
  if (body.model === "claude-sonnet-5-5") return HttpResponse.json(anthropicFixture("fit-ok.json"));
  if (body.max_tokens === APPLY_LINK_MAX_TOKENS) {
    return HttpResponse.json(reply('{"choice":1,"kind":"company_form"}'));
  }
  const x = anthropicFixture("extract-ok.json");
  const block = x.content[x.content.length - 1];
  if (block?.text === undefined) throw new Error("fixture shape");
  // The Nimbus posting states European working hours (no residence requirement): the digest shows an Hours line.
  const europe = JSON.stringify(body.messages).includes(NIMBUS);
  block.text = JSON.stringify({
    ...JSON.parse(block.text),
    ...(europe ? { hoursZone: "europe", overlapHours: 4 } : {}),
  });
  return HttpResponse.json(x);
});

const server = setupServer();
let dir: string;
let db: Db;
let clock: Date;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "e2e3-"));
  copyFileSync(new URL("config/salary.example.yaml", repo), join(dir, "salary.yaml"));
  writeFileSync(join(dir, "companies.yaml"), COMPANIES_YAML);
  copyFileSync(new URL("config/cv.example.md", repo), join(dir, "cv.md"));
  vi.stubEnv("JOB_AGENT_CONFIG_DIR", dir);
  vi.stubEnv("BRAVE_API_KEY", "fake-brave-key");
  vi.stubEnv("JOB_AGENT_BRAVE_USAGE", join(dir, "brave-usage.json"));
  db = openDb(join(dir, "e2e.db"));
  clock = NOW;
  llmRequests = [];
  let t = NOW.getTime();
  __testInjectTimeAndSleep(
    () => new Date(Math.max(t, clock.getTime())),
    async (ms) => {
      t += ms;
    },
  );
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(log, level).mockImplementation(() => undefined);
  }
  server.use(...baseHandlers(), llmHandler);
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
  server.resetHandlers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  __testInjectTimeAndSleep(
    () => new Date(),
    (ms) => new Promise((r) => setTimeout(r, ms)),
  );
});

const now = () => clock;
const io = (out: string[]) => ({
  out: (t: string) => out.push(t),
  err: (t: string) => out.push(t),
});

/** JobSpy worker stand-in: the first search of each site returns the lines, the second one is empty. */
const worker = (lines: string) => async (search: { location?: string }) => ({
  exitCode: 0,
  stdout: search.location === "Indonesia" ? "" : lines,
});

async function fetchAll(): Promise<number> {
  await fetchAndStoreFx(db, now);
  return runDiscover({
    db,
    adapters: [
      createLinkedInAdapter({ runWorker: worker(LINKEDIN_LINES), sleep: async () => undefined }),
      createIndeedAdapter({
        runWorker: worker(INDEED_LINES),
        sleep: async () => undefined,
        now,
      }),
      createLinkedinPostsAdapter(),
    ],
    force: true,
    now,
    out: () => {},
    err: () => {},
  });
}

async function enrich(extra: { reextractOnly?: boolean } = {}) {
  const out: string[] = [];
  const code = await runEnrich({
    db,
    salary: loadConfig().salary,
    env: ENV,
    cv: loadCv(dir),
    now,
    ...extra,
    ...io(out),
  });
  return { code, out: out.join("") };
}

async function resolveApply() {
  const out: string[] = [];
  const code = await runResolveApply({
    db,
    saveAts: { configDir: dir, backupDir: join(dir, "backups") },
    now,
    out: (t) => out.push(t),
    err: (t) => out.push(t),
    llm: { env: ENV, baseURL: "https://api.anthropic.com" },
  });
  return { code, out: out.join("") };
}

function digest(): string {
  const path = runDigest({ db, outDir: join(dir, "digests"), now, out: () => {} });
  return readFileSync(path, "utf8");
}

function section(md: string, heading: string): string {
  const start = md.indexOf(`## ${heading}`);
  if (start < 0) throw new Error(`no section ${heading}`);
  const rest = md.slice(start + 3);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

const postingOf = (company: string) =>
  db.select().from(postings).where(eq(postings.company_name, company)).get();
const intelOf = (company: string) =>
  db
    .select()
    .from(intel)
    .where(eq(intel.posting_id, postingOf(company)?.id ?? ""))
    .get();
const linkOf = (company: string) =>
  db
    .select()
    .from(apply_links)
    .where(eq(apply_links.posting_id, postingOf(company)?.id ?? ""))
    .get();

/** The `### ` block of one entry in a section. */
const block = (md: string, title: string): string => {
  const entry = section(md, "Top matches")
    .split(/^### /m)
    .find((b) => b.startsWith(title));
  if (entry === undefined) throw new Error(`no entry ${title}`);
  return entry;
};

describe("phase 3 pipeline end to end", () => {
  it("discovers LinkedIn, Indeed and LinkedIn posts, each source ok with postings", async () => {
    expect(await fetchAll()).toBe(0);
    const runs = db.select().from(source_runs).all();
    expect(runs.map((r) => r.source).sort()).toEqual(["indeed", "linkedin", "linkedin_posts"]);
    for (const r of runs) expect(r.status, r.source).toBe("ok");
    const found = Object.fromEntries(runs.map((r) => [r.source, r.found]));
    expect(found).toEqual({ linkedin: 2, indeed: 2, linkedin_posts: 1 });
  });

  it("location text restriction: the Typeform-style posting is rejected by the rules, before any AI call", async () => {
    await fetchAll();
    expect(runProcess({ db, now, ...io([]) })).toBe(0);
    const a = db
      .select()
      .from(analysis)
      .where(eq(analysis.posting_id, postingOf(FORMCRAFT)?.id ?? ""))
      .get();
    expect(a?.decision).toBe("reject");
    expect(a?.location_class).toBe("restricted");
    // The same text without the restriction sentence is kept (control).
    const nimbus = db
      .select()
      .from(analysis)
      .where(eq(analysis.posting_id, postingOf(NIMBUS)?.id ?? ""))
      .get();
    expect(nimbus?.decision).toBe("keep");

    await enrich();
    expect(intelOf(FORMCRAFT)).toBeUndefined();
    expect(JSON.stringify(llmRequests.map((q) => q.messages))).not.toContain(FORMCRAFT);
    expect(section(digest(), "Top matches")).not.toContain(FORMCRAFT);
  });

  it("full run: re-extraction, resolve-apply (ATS found, Haiku pick, paid label), companies.yaml append, short digest", async () => {
    await fetchAll();
    runProcess({ db, now, ...io([]) });
    const first = await enrich();
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/re-extracted 0/);
    const extractsBefore = extractRequests().length;

    // One extraction made by an older prompt version is re-extracted in the next run.
    const outdated = intelOf(QUILLBASE);
    expect(outdated?.status).toBe("done");
    db.update(intel)
      .set({ extract_prompt_version: "extract-old" })
      .where(eq(intel.posting_id, postingOf(QUILLBASE)?.id ?? ""))
      .run();
    const again = await enrich();
    expect(again.out).toMatch(/re-extracted 1 /);
    expect(extractRequests().length - extractsBefore).toBe(1);
    expect(intelOf(QUILLBASE)?.extract_prompt_version).toBe(EXTRACT_PROMPT_VERSION);

    // resolve-apply: ATS board lookup, one Haiku pick, companies.yaml gains one entry with a backup.
    const before = readFileSync(join(dir, "companies.yaml"), "utf8");
    const r = await resolveApply();
    expect(r.code).toBe(0);
    expect(linkOf(NIMBUS)).toMatchObject({
      apply_type: "ats",
      method: "ats_board",
      apply_url: "https://boards.greenhouse.io/nimbuslabs/jobs/7001",
      ats_type: "greenhouse",
      ats_slug: "nimbuslabs",
      found_on: "linkedin",
    });
    expect(linkOf(PAPERLINE)).toMatchObject({
      apply_type: "paid_aggregator",
      apply_url: "https://www.flexjobs.com/jobs/paperline-fullstack",
      found_on: "indeed",
    });
    expect(linkOf(HARBORLINE)).toMatchObject({
      apply_type: "company_form",
      method: "llm",
      apply_url: "https://harborline-apps.example.test/apply/react",
    });
    expect(applyLinkRequests()).toHaveLength(1);
    expect(
      db.select().from(llm_calls).where(eq(llm_calls.purpose, "apply_link")).all(),
    ).toHaveLength(1);
    expect(linkOf(FORMCRAFT)).toBeUndefined();

    const yaml = readFileSync(join(dir, "companies.yaml"), "utf8");
    expect(yaml.startsWith(before)).toBe(true);
    const added = yaml.slice(before.length);
    expect(added).toMatch(/name: "?Nimbus Labs"?, ats: greenhouse, slug: "?nimbuslabs"?/);
    expect(added).toContain("# added by job-agent 2026-10-14 (apply resolve)");
    expect(added.match(/ats: /g)).toHaveLength(1);
    const backups = readdirSync(join(dir, "backups"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, "backups", backups[0] ?? ""), "utf8")).toBe(before);
    expect(loadConfig().companies.map((c) => c.slug)).toEqual(["orbitworks", "nimbuslabs"]);
    expect(
      db.select().from(companies).where(eq(companies.ats_slug, "nimbuslabs")).get()?.verified,
    ).toBe(true);

    // The digest: no Why line; Apply, Found on, Type, Hours; the paid-only job is listed with its label.
    const md = digest();
    const top = section(md, "Top matches");
    expect(top).not.toContain("Why:");
    const nimbus = block(md, `Senior Frontend Engineer — ${NIMBUS}`);
    expect(nimbus).toContain("- Apply: https://boards.greenhouse.io/nimbuslabs/jobs/7001 (ats)");
    expect(nimbus).toMatch(/^- Found on: linkedin — https:\/\/www\.linkedin\.com\//m);
    expect(nimbus).toMatch(/^- Type: contractor$/m);
    expect(nimbus).toMatch(/^- Hours: overlap 4 h with Europe/m);
    const paper = block(md, "Senior Full Stack Engineer");
    expect(paper.split("\n")[0]).toBe(
      `Senior Full Stack Engineer — ${PAPERLINE} (paid-only apply)`,
    );
    expect(paper).toContain("(paid_aggregator)");
    expect(block(md, `Senior React Engineer — ${HARBORLINE}`)).toContain(
      "- Apply: https://harborline-apps.example.test/apply/react (company_form)",
    );
    expect(top).toContain(QUILLBASE);
    expect(top).not.toContain(FORMCRAFT);
    for (const b of top.split(/^### /m).slice(1)) {
      expect(b).toMatch(/^- Apply: \S+ \(\w+\)$/m);
      expect(b).toMatch(/^- Found on: /m);
      expect(b).toMatch(/^- Type: /m);
    }
    expect(section(md, "Source health")).toMatch(/\*\*linkedin\*\*: ok/);
  });

  it("a second resolve-apply run changes nothing: no new Haiku call, no second companies.yaml entry", async () => {
    await fetchAll();
    runProcess({ db, now, ...io([]) });
    await enrich();
    await resolveApply();
    const yaml = readFileSync(join(dir, "companies.yaml"), "utf8");
    const calls = applyLinkRequests().length;
    const r = await resolveApply();
    expect(r.out).toMatch(/checked 0,/);
    expect(applyLinkRequests()).toHaveLength(calls);
    expect(readFileSync(join(dir, "companies.yaml"), "utf8")).toBe(yaml);
    expect(readdirSync(join(dir, "backups")).length).toBeLessThanOrEqual(1);
    expect(existsSync(join(dir, "backups"))).toBe(true);
  });
});
