import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { postings, type Db } from "@job-agent/core";
import { mappingId } from "../../choice-coverage.ts";
import type { PlanContext } from "../greenhouse/filler.ts";
import {
  CAPTCHA_RECORDER_PAGE,
  CAPTCHA_VARIANTS,
  startFixtureServer,
  type CaptchaVariant,
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
export const ASHBY_FIXTURE_CAPTCHA_PATHS: Record<CaptchaVariant, string> = {
  passive: `/acme/${POSTING_UUID}-captcha-passive/application`,
  "visible-checkbox": `/acme/${POSTING_UUID}-captcha-visible-checkbox/application`,
  "visible-challenge": `/acme/${POSTING_UUID}-captcha-visible-challenge/application`,
  "hidden-challenge": `/acme/${POSTING_UUID}-captcha-hidden-challenge/application`,
  "late-challenge": `/acme/${POSTING_UUID}-captcha-late-challenge/application`,
};
/** The CAPTCHA page the stop tests use: a visible challenge (a passive script alone no longer stops a run). */
export const ASHBY_FIXTURE_CAPTCHA_PATH = ASHBY_FIXTURE_CAPTCHA_PATHS["visible-challenge"];
export const ASHBY_FIXTURE_CHANGED_PATH = `/acme/${POSTING_UUID}-changed/application`;
export const ASHBY_FIXTURE_DATE_PATH = `/acme/${POSTING_UUID}-date/application`;
export const ASHBY_FIXTURE_PHONE_PAIR_PATH = `/acme/${POSTING_UUID}-phonepair/application`;
export const ASHBY_FIXTURE_PHONE_FORMAT_PATH = `/acme/${POSTING_UUID}-phonefmt/application`;

export const ASHBY_FIXTURE_REALSHAPE_PATH = `/acme/${POSTING_UUID}-realshape/application`;
export const ASHBY_FIXTURE_ORPHAN_PATH = `/acme/${POSTING_UUID}-orphan/application`;

/** The questions of the real-shape variant (fake employer; wording follows the owner's real dry run). */
export const AI_QUESTION =
  "Select a response that accurately describes your level of experience with AI tools";
export const AI_OPTIONS = [
  "I do not use AI tools",
  "I use AI tools occasionally",
  "I use AI tools daily",
  "I build AI-powered tools",
];
export const WORK_AUTH_QUESTION = "Are you legally authorized to work in the United States?";
export const SPONSORSHIP_QUESTION =
  "Will you now or in the future require sponsorship for employment visa status?";
export const FAMILIAL_QUESTION =
  "Do you have any familial relationships with current Fixture Co employees?";

const FIXTURES_DIR = fileURLToPath(new URL("../../../fixtures/ashby/", import.meta.url));

const PAGES: Record<string, string> = {
  [ASHBY_FIXTURE_FORM_PATH]: "app.html",
  [ASHBY_FIXTURE_CHANGED_PATH]: "app.html",
  [ASHBY_FIXTURE_DATE_PATH]: "app.html",
  [ASHBY_FIXTURE_PHONE_PAIR_PATH]: "app.html",
  [ASHBY_FIXTURE_PHONE_FORMAT_PATH]: "app.html",
  [ASHBY_FIXTURE_REALSHAPE_PATH]: "app.html",
  [ASHBY_FIXTURE_ORPHAN_PATH]: "app.html",
  "/app.js": "app.js",
  ...CAPTCHA_RECORDER_PAGE,
  ...Object.fromEntries(
    CAPTCHA_VARIANTS.map((v) => [ASHBY_FIXTURE_CAPTCHA_PATHS[v], `app.html+captcha/${v}.html`]),
  ),
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
    /** The page rewrites the typed value as it is typed (phone: country prefix, dashes). */
    reformat?: boolean;
    /** `radio` / `dropdown` / `checkbox` for the select types. */
    display?: string;
    selectableValues?: { label: string; value: string }[];
  };
}
interface Posting {
  recaptchaAction: string | null;
  surveyForms?: unknown[];
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
  // Real Ashby pages carry a recaptchaAction and load reCAPTCHA (research t_d0698332): the page adds the script. The
  // other CAPTCHA variants (the snippet is added by the server) have the same form as the plain one.
  [`${POSTING_UUID}-captcha-passive`]: (p) => {
    p.recaptchaAction = "fixture_apply";
  },
  ...Object.fromEntries(
    CAPTCHA_VARIANTS.filter((v) => v !== "passive").map((v) => [
      `${POSTING_UUID}-captcha-${v}`,
      (): void => undefined,
    ]),
  ),
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
  // The shape of a real Ashby form (research t_d0698332 + the owner's dry run): a location autocomplete, a four-option radio
  // group, three Yes/No radio groups, the SMS consent radios (already in the base form), an EEO block and a veteran block.
  [`${POSTING_UUID}-realshape`]: (p) => {
    const add = (
      type: string,
      title: string,
      suffix: string,
      extra: Partial<Entry["field"]> = {},
    ) =>
      entries(p).push({
        id: `r${suffix}`,
        isRequired: true,
        isHidden: false,
        field: { path: `4a1f0c52-7e1d-4b8a-9a31-0c2d5e6f7c${suffix}`, type, title, ...extra },
      });
    add("Combobox", "Location", "01", {
      selectableValues: [
        { label: "Jakarta, Indonesia", value: "loc-1" },
        { label: "Springfield, Illinois, United States", value: "loc-2" },
        { label: "Springfield, Missouri, United States", value: "loc-3" },
      ],
    });
    add("ValueSelect", AI_QUESTION, "02", {
      display: "radio",
      selectableValues: AI_OPTIONS.map((label, i) => ({ label, value: `ai-${i}` })),
    });
    add("Boolean", WORK_AUTH_QUESTION, "03");
    add("Boolean", SPONSORSHIP_QUESTION, "04");
    add("Boolean", FAMILIAL_QUESTION, "05");
    const surveys = p.surveyForms ?? [];
    surveys.push({
      title: "Veteran status",
      fieldEntries: [
        {
          id: "s2",
          isRequired: false,
          isHidden: false,
          field: {
            path: "survey-veteran",
            type: "ValueSelect",
            title: "Veteran status",
            display: "radio",
            selectableValues: [
              { label: "I am not a veteran", value: "v-no" },
              { label: "Prefer not to disclose", value: "v-none" },
            ],
          },
        },
        {
          id: "s3",
          isRequired: false,
          isHidden: false,
          field: {
            path: "survey-race",
            type: "ValueSelect",
            title: "Race",
            display: "radio",
            selectableValues: [
              { label: "Prefer not to disclose", value: "r-none" },
              { label: "Other", value: "r-other" },
            ],
          },
        },
      ],
    });
    p.surveyForms = surveys;
  },
  // A question the reader's entry hooks do not cover (a title with buttons, outside any entry): the run must not go on.
  [`${POSTING_UUID}-orphan`]: (p) => {
    entries(p).push({
      id: "x3",
      isRequired: true,
      isHidden: false,
      field: {
        path: "4a1f0c52-7e1d-4b8a-9a31-0c2d5e6f7b03",
        type: "Orphan",
        title: "Do you need an accommodation?",
      },
    });
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
  // A phone input that reformats what is typed (a "+1 " prefix and dashes between digit groups), like real pages do.
  [`${POSTING_UUID}-phonefmt`]: (p) => {
    byTitle(p, "Phone Number").field.reformat = true;
  },
  // A phone question whose DOM is not understood (two tel inputs): the run stops with its label and DOM kinds.
  [`${POSTING_UUID}-phonepair`]: (p) => {
    const f = byTitle(p, "Phone Number").field;
    f.type = "PhonePair";
    f.title = "Mobile phone";
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

/**
 * Plan inputs for the real-shape variant: the Lever persona plus answers (keys from answer-keys.json) for the work
 * authorization, sponsorship and AI-experience questions, and an approved mapping for the AI question. The familial
 * question and the location combobox have no answer: they stay open.
 */
export function ashbyRealShapeContext(
  dataDir: string,
  opts: { mapAi?: boolean } = {},
): PlanContext {
  const base = ashbyFixtureContext(dataDir);
  const answer = (key: string, text: string, question: string, type: "yes_no" | "choice") => ({
    key,
    question,
    alternatives: null,
    answer: text,
    type,
    choices: type === "choice" ? AI_OPTIONS : null,
    approved: true,
  });
  const choiceMappings = new Map(base.choiceMappings);
  if (opts.mapAi !== false)
    choiceMappings.set(mappingId("experience.total_years_professional", AI_QUESTION, AI_OPTIONS), [
      "I use AI tools daily",
    ]);
  return {
    ...base,
    answers: [
      ...base.answers,
      answer("work_setup.work_authorization", "No", WORK_AUTH_QUESTION, "yes_no"),
      answer("work_setup.needs_visa_sponsorship", "Yes", SPONSORSHIP_QUESTION, "yes_no"),
      answer("experience.total_years_professional", AI_OPTIONS[2] as string, AI_QUESTION, "choice"),
    ],
    choiceMappings,
  };
}

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
