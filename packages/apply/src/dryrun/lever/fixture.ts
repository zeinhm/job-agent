import { fileURLToPath } from "node:url";
import { postings, type Db } from "@job-agent/core";
import type { PlanContext } from "../greenhouse/filler.ts";
import {
  CAPTCHA_RECORDER_PAGE,
  CAPTCHA_VARIANTS,
  ensureFixtureResume,
  fixtureAnswers,
  fixtureChoiceMappings,
  startFixtureServer,
  type CaptchaVariant,
  type FixtureServer,
} from "../greenhouse/fixture.ts";

/**
 * The committed Lever fixture (packages/apply/fixtures/lever/): synthetic apply pages built from R2's selector map, and
 * the same fake persona as the Greenhouse fixture (the form asks the same questions, so its approved answers and choice
 * mappings fit). Lever has no questions API, so nothing is pre-stored: the filler stores what the page shows. Agents and
 * `bin/smoke` run the filler on this, served from 127.0.0.1. Nothing here is real data.
 */
export const LEVER_FIXTURE_POSTING_ID = "fixture-lever-2001";
const POSTING_UUID = "2f6e9a54-3c1b-4d7e-8a20-5b9c4e1d7f03";
export const LEVER_FIXTURE_FORM_PATH = `/acme/${POSTING_UUID}/apply`;
export const LEVER_FIXTURE_CAPTCHA_PATHS: Record<CaptchaVariant, string> = {
  passive: `/acme/${POSTING_UUID}-captcha-passive/apply`,
  "visible-checkbox": `/acme/${POSTING_UUID}-captcha-visible-checkbox/apply`,
  "visible-challenge": `/acme/${POSTING_UUID}-captcha-visible-challenge/apply`,
  "hidden-challenge": `/acme/${POSTING_UUID}-captcha-hidden-challenge/apply`,
  "late-challenge": `/acme/${POSTING_UUID}-captcha-late-challenge/apply`,
};
/** The CAPTCHA page the stop tests use: a visible challenge (a passive widget alone no longer stops a run). */
export const LEVER_FIXTURE_CAPTCHA_PATH = LEVER_FIXTURE_CAPTCHA_PATHS["visible-challenge"];
export const LEVER_FIXTURE_CHANGED_PATH = `/acme/${POSTING_UUID}-changed/apply`;
export const LEVER_FIXTURE_DATE_PATH = `/acme/${POSTING_UUID}-date/apply`;
export const LEVER_FIXTURE_LOCATION_PATH = `/acme/${POSTING_UUID}-location/apply`;

const FIXTURES_DIR = fileURLToPath(new URL("../../../fixtures/lever/", import.meta.url));

const PAGES: Record<string, string> = {
  [LEVER_FIXTURE_FORM_PATH]: "form.html",
  [LEVER_FIXTURE_CHANGED_PATH]: "changed.html",
  [LEVER_FIXTURE_LOCATION_PATH]: "location.html",
  [LEVER_FIXTURE_DATE_PATH]: "date.html",
  ...CAPTCHA_RECORDER_PAGE,
  ...Object.fromEntries(
    CAPTCHA_VARIANTS.map((v) => [LEVER_FIXTURE_CAPTCHA_PATHS[v], `form.html+captcha/${v}.html`]),
  ),
};

/** Plan inputs of the fixture persona: approved answers (plus the company question Lever asks), mappings, an ask, no scam flag. */
export function leverFixtureContext(dataDir: string): PlanContext {
  return {
    answers: [
      ...fixtureAnswers(ensureFixtureResume(dataDir)),
      {
        key: "experience.current_role",
        question: "Current company",
        alternatives: null,
        answer: "Example Corp",
        type: null,
        choices: null,
        approved: true,
      },
      {
        key: "contact.location",
        question: null,
        alternatives: null,
        answer: "Jakarta, Indonesia",
        type: null,
        choices: null,
        approved: true,
      },
    ],
    choiceMappings: fixtureChoiceMappings(),
    ask: { askIdrMonth: 30_000_000, askUsdYear: 24_000, askText: null },
    scamFlagged: false,
  };
}

/** Inserts the fixture posting (idempotent). Its questions are stored by the first run, from the page. */
export function seedLeverFixture(db: Db, now: Date = new Date()): string {
  const at = now.toISOString();
  db.insert(postings)
    .values({
      id: LEVER_FIXTURE_POSTING_ID,
      source: "lever",
      external_id: POSTING_UUID,
      url: `https://jobs.lever.co/acme/${POSTING_UUID}`,
      title: "Senior Backend Engineer (fixture)",
      company_name: "Fixture Co",
      first_seen_at: at,
      last_seen_at: at,
    })
    .onConflictDoNothing()
    .run();
  return LEVER_FIXTURE_POSTING_ID;
}

/** Serves the committed Lever pages on 127.0.0.1 (ephemeral port) and records every request it receives. */
export const startLeverFixtureServer = (): Promise<FixtureServer> =>
  startFixtureServer(FIXTURES_DIR, PAGES);
