import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { postings, type Db } from "@job-agent/core";
import type { PlanContext } from "../greenhouse/filler.ts";
import {
  startFixtureServer,
  type FixtureReply,
  type FixtureServer,
} from "../greenhouse/fixture.ts";
import { leverFixtureContext } from "../lever/fixture.ts";

/**
 * The committed Ashby fixture (packages/apply/fixtures/ashby/): a synthetic JS page (`app.html` + `app.js`) that loads its
 * form through a GraphQL POST, and fake GraphQL answers (`form.json` and the variants below) served from 127.0.0.1. It asks
 * the same questions as the Lever fixture under Ashby's own labels, so the Lever persona (approved answers, choice mappings,
 * tier ask) fits. Ashby has no questions API, so nothing is pre-stored: the filler stores what the page shows. Nothing here
 * is real data.
 */
export const ASHBY_FIXTURE_POSTING_ID = "fixture-ashby-3001";
const POSTING_UUID = "7c3d2b18-5a4e-4f19-b6c0-9e8d1a2f3b04";
export const ASHBY_FIXTURE_FORM_PATH = `/acme/${POSTING_UUID}/application`;
export const ASHBY_FIXTURE_CAPTCHA_PATH = `/acme/${POSTING_UUID}-captcha/application`;
export const ASHBY_FIXTURE_CHANGED_PATH = `/acme/${POSTING_UUID}-changed/application`;
export const ASHBY_FIXTURE_DATE_PATH = `/acme/${POSTING_UUID}-date/application`;

const FIXTURES_DIR = fileURLToPath(new URL("../../../fixtures/ashby/", import.meta.url));

const PAGES: Record<string, string> = {
  [ASHBY_FIXTURE_FORM_PATH]: "app.html",
  [ASHBY_FIXTURE_CAPTCHA_PATH]: "app.html",
  [ASHBY_FIXTURE_CHANGED_PATH]: "app.html",
  [ASHBY_FIXTURE_DATE_PATH]: "app.html",
  "/app.js": "app.js",
};

const GRAPHQL_PATH = "/api/non-user-graphql";
const FORM_OPERATION = "ApiJobPostingForApplicationRequest";

interface Entry {
  id: string;
  isRequired: boolean;
  isHidden: boolean;
  field: {
    path: string;
    type: string;
    title: string;
    selectableValues?: { label: string; value: string }[];
  };
}
interface Posting {
  recaptchaAction: string | null;
  applicationForm: { sections: { fieldEntries: Entry[] }[] };
}
interface Answer {
  data: { jobPosting: Posting | null };
}

const entries = (p: Posting): Entry[] => p.applicationForm.sections[0]?.fieldEntries ?? [];
const byTitle = (p: Posting, title: string): Entry => {
  const e = entries(p).find((x) => x.field.title === title);
  if (e === undefined) throw new Error(`fixture field not found: ${title}`);
  return e;
};

/** The variants of the fake form: each is `form.json` with a small, named change (the page itself is the same). */
const VARIANTS: Record<string, (p: Posting) => void> = {
  [POSTING_UUID]: () => undefined,
  // Real Ashby pages carry a recaptchaAction and load reCAPTCHA (research t_d0698332): the page adds the script.
  [`${POSTING_UUID}-captcha`]: (p) => {
    p.recaptchaAction = "fixture_apply";
  },
  // A changed form: a field gone, a new one, a changed label and a changed option set.
  [`${POSTING_UUID}-changed`]: (p) => {
    const section = p.applicationForm.sections[0] as { fieldEntries: Entry[] };
    section.fieldEntries = entries(p).filter(
      (e) => e.field.title !== "Expected salary (USD per year)",
    );
    section.fieldEntries.push({
      id: "x1",
      isRequired: false,
      isHidden: false,
      field: {
        path: "4a1f0c52-7e1d-4b8a-9a31-0c2d5e6f7b01",
        type: "Boolean",
        title: "Do you need visa sponsorship?",
      },
    });
    byTitle(p, "LinkedIn URL").field.title = "LinkedIn profile";
    const zone = byTitle(p, "Preferred time zone").field;
    zone.selectableValues = (zone.selectableValues ?? []).filter((o) => o.value !== "tz-berlin");
  },
  // A question type the filler does not fill (a date).
  [`${POSTING_UUID}-date`]: (p) => {
    entries(p).push({
      id: "x2",
      isRequired: false,
      isHidden: false,
      field: {
        path: "4a1f0c52-7e1d-4b8a-9a31-0c2d5e6f7b02",
        type: "Date",
        title: "Available start date",
      },
    });
  },
};

/** What the fixture server received on the GraphQL endpoint: the operation name (`op`) and whether the body was a query or a mutation. */
export interface GraphqlCall {
  op: string;
  kind: "query" | "mutation";
}

export interface AshbyFixtureServer extends FixtureServer {
  graphql: GraphqlCall[];
}

const json = (body: unknown): FixtureReply => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

function formAnswer(jobPostingId: string): Answer {
  const patch = VARIANTS[jobPostingId];
  if (patch === undefined) return { data: { jobPosting: null } };
  const answer = JSON.parse(readFileSync(`${FIXTURES_DIR}form.json`, "utf8")) as Answer;
  if (answer.data.jobPosting) patch(answer.data.jobPosting);
  return answer;
}

/** Plan inputs of the fixture persona: the Lever persona (same questions, Ashby's labels). */
export const ashbyFixtureContext = (dataDir: string): PlanContext => leverFixtureContext(dataDir);

/** Inserts the fixture posting (idempotent). Its questions are stored by the first run, from the page. */
export function seedAshbyFixture(db: Db, now: Date = new Date()): string {
  const at = now.toISOString();
  db.insert(postings)
    .values({
      id: ASHBY_FIXTURE_POSTING_ID,
      source: "ashby",
      external_id: POSTING_UUID,
      url: `https://jobs.ashbyhq.com/acme/${POSTING_UUID}`,
      title: "Senior Backend Engineer (fixture)",
      company_name: "Fixture Co",
      first_seen_at: at,
      last_seen_at: at,
    })
    .onConflictDoNothing()
    .run();
  return ASHBY_FIXTURE_POSTING_ID;
}

/**
 * Serves the committed Ashby page and its fake GraphQL answers on 127.0.0.1 (ephemeral port). Records every request
 * (`requests`, `nonGet()`) and, for the GraphQL endpoint, the operation and whether the body was a query or a mutation
 * (`graphql`): a mutation that reaches this server is a guard failure. Any operation but the form query gets an empty answer.
 */
export async function startAshbyFixtureServer(): Promise<AshbyFixtureServer> {
  const graphql: GraphqlCall[] = [];
  const server = await startFixtureServer(FIXTURES_DIR, PAGES, ({ method, url, body }) => {
    if (method !== "POST" || url.pathname !== GRAPHQL_PATH) return undefined;
    const op = url.searchParams.get("op") ?? "";
    let query = "";
    let variables: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(body) as { query?: unknown; variables?: Record<string, unknown> };
      query = typeof parsed.query === "string" ? parsed.query : "";
      variables = parsed.variables ?? {};
    } catch {
      // not JSON: recorded as a query with no variables, answered empty
    }
    graphql.push({ op, kind: /^\s*mutation\b/.test(query) ? "mutation" : "query" });
    if (op === FORM_OPERATION) return json(formAnswer(String(variables["jobPostingId"] ?? "")));
    return json({ data: {} });
  });
  return Object.assign(server, { graphql });
}
