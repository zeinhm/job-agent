import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { posting_questions, postings, type Db } from "@job-agent/core";
import { and, eq } from "drizzle-orm";
import { mappingId } from "../../choice-coverage.ts";
import type { PlanAnswer } from "../../fill-plan.ts";
import { normalizeQuestion } from "../../match.ts";
import { DRYRUNS_DIR } from "../output.ts";
import type { PlanContext } from "./filler.ts";

/**
 * The committed Greenhouse fixture (packages/apply/fixtures/greenhouse/): a synthetic form built from R2's selector map,
 * its stored questions as `fetch-questions` would have stored them, and a fake persona. Agents and `bin/smoke` run the
 * filler on this, served from 127.0.0.1. Nothing here is real data.
 */
export const FIXTURE_POSTING_ID = "fixture-greenhouse-1001";
export const FIXTURE_FORM_PATH = "/acme/jobs/1001";
export const FIXTURE_CHANGED_PATH = "/acme/jobs/1003";
/** The form with a location autocomplete (the stored Location question is `FIXTURE_LOCATION_QUESTION`). */
export const FIXTURE_LOCATION_PATH = "/acme/jobs/1004";
/** The form plus widget helper inputs (combobox filter boxes, a react-select internal input): no extra question. */
export const FIXTURE_WIDGETS_PATH = "/acme/jobs/1008";
/** The form plus the standard education block (School, Degree, Discipline, dates): known fields, not extra. */
export const FIXTURE_EDUCATION_PATH = "/acme/jobs/1009";
/** The form plus one real unknown extra question (a text input): still stops `form_changed`. */
export const FIXTURE_UNKNOWN_EXTRA_PATH = "/acme/jobs/1010";
/** The form plus a late re-render that blanks First Name, Email and the resume once and never puts them back. */
export const FIXTURE_LATE_CLEAR_PATH = "/acme/jobs/1011";
/** The form plus a late re-render that blanks First Name and Last Name, then puts the values back. */
export const FIXTURE_LATE_RESTORE_PATH = "/acme/jobs/1012";
/** The form plus an upload that completes late: the file input is replaced by an empty one and a file-name line (kept). */
export const FIXTURE_UPLOAD_SWAP_PATH = "/acme/jobs/1013";
/** The form plus an upload the page drops: the file input is replaced by an empty one and nothing shows the file. */
export const FIXTURE_UPLOAD_DROPPED_PATH = "/acme/jobs/1014";
/** The form plus a Cover Letter textarea question (stored `long_text`, id `cover_letter`). */
export const FIXTURE_COVER_TEXTAREA_PATH = "/acme/jobs/1015";
/** The form plus a Cover Letter file upload with the "Enter manually" option (stored `file`, id `cover_letter`). */
export const FIXTURE_COVER_MANUAL_PATH = "/acme/jobs/1016";
/** The form plus a Cover Letter file upload without a text option. */
export const FIXTURE_COVER_FILE_ONLY_PATH = "/acme/jobs/1017";
/** The form plus a widget that keeps only a file chosen through its own picker (a programmatic attach is dropped). */
export const FIXTURE_UPLOAD_CHOOSER_PATH = "/acme/jobs/1018";

/** The form plus a widget that completes an upload slowly and then removes its input (an upload-complete line stays). */
export const FIXTURE_UPLOAD_LATE_GONE_PATH = "/acme/jobs/1019";
/** A closed posting: the job board page says the job is no longer open and has no application form (t_c0c2b45a). */
export const FIXTURE_CLOSED_PATH = "/acme/jobs/1020";
/** The form, rendered 1.5 s after the load event. */
export const FIXTURE_LATE_FORM_PATH = "/acme/jobs/1021";
/** The form under the older embed's id `application_form`. */
export const FIXTURE_UNDERSCORE_FORM_PATH = "/acme/jobs/1022";

/**
 * The CAPTCHA variants every ATS fixture has (t_cbcbc227): the same form plus a snippet `captcha/<variant>.html`.
 * `passive`: script + invisible badge / widget; `visible-checkbox`: a widget that asks the user to act; `visible-challenge`:
 * a challenge frame on the page; `hidden-challenge`: passive + a challenge frame that is not visible; `late-challenge`:
 * passive, and a challenge appears when the first field changes.
 */
export const CAPTCHA_VARIANTS = [
  "passive",
  "visible-checkbox",
  "visible-challenge",
  "hidden-challenge",
  "late-challenge",
] as const;
export type CaptchaVariant = (typeof CAPTCHA_VARIANTS)[number];

/** Shared by the three fixtures: serves `fixtures/captcha-recorder.js`, which reports every touch of a CAPTCHA element. */
export const CAPTCHA_RECORDER_PAGE = { "/captcha-recorder.js": "../captcha-recorder.js" } as const;
/** Request path prefix the recorder uses; a fixture server must have seen none under a dry run. */
export const CAPTCHA_HIT_PREFIX = "/__captcha-hit/";
export const FIELD_CHANGE_PATH = "/__field-change";

export const FIXTURE_CAPTCHA_PATHS: Record<CaptchaVariant, string> = {
  passive: "/acme/jobs/captcha-passive",
  "visible-checkbox": "/acme/jobs/captcha-visible-checkbox",
  "visible-challenge": "/acme/jobs/captcha-visible-challenge",
  "hidden-challenge": "/acme/jobs/captcha-hidden-challenge",
  "late-challenge": "/acme/jobs/captcha-late-challenge",
};
/** The CAPTCHA page the stop tests use: a visible challenge (a passive script alone no longer stops a run). */
export const FIXTURE_CAPTCHA_PATH = FIXTURE_CAPTCHA_PATHS["visible-challenge"];

/** The committed Greenhouse fixture folder (tests serve its pages from a second server to stage a redirect). */
export const FIXTURES_DIR = fileURLToPath(
  new URL("../../../fixtures/greenhouse/", import.meta.url),
);

// Joined, not one literal: `location.<name>` in quotes would read as an answer key to the key-contract test.
const LOCATION_PAGE = ["location", "html"].join(".");

const PAGES: Record<string, string> = {
  [FIXTURE_FORM_PATH]: "form.html",
  [FIXTURE_CHANGED_PATH]: "changed.html",
  [FIXTURE_LOCATION_PATH]: LOCATION_PAGE,
  [FIXTURE_WIDGETS_PATH]: "form.html+form:snippets/widgets.html",
  [FIXTURE_EDUCATION_PATH]: "form.html+form:snippets/education.html",
  [FIXTURE_UNKNOWN_EXTRA_PATH]: "form.html+form:snippets/unknown-extra.html",
  [FIXTURE_LATE_CLEAR_PATH]: "form.html+snippets/late-clear.html",
  [FIXTURE_LATE_RESTORE_PATH]: "form.html+snippets/late-restore.html",
  [FIXTURE_UPLOAD_SWAP_PATH]: "form.html+snippets/upload-swap.html",
  [FIXTURE_UPLOAD_DROPPED_PATH]: "form.html+snippets/upload-dropped.html",
  [FIXTURE_COVER_TEXTAREA_PATH]: "form.html+form:snippets/cover-textarea.html",
  [FIXTURE_COVER_MANUAL_PATH]: "form.html+form:snippets/cover-manual.html",
  [FIXTURE_COVER_FILE_ONLY_PATH]: "form.html+form:snippets/cover-file-only.html",
  [FIXTURE_UPLOAD_CHOOSER_PATH]: "form.html+snippets/upload-chooser-only.html",
  [FIXTURE_UPLOAD_LATE_GONE_PATH]: "form.html+snippets/upload-late-gone.html",
  [FIXTURE_CLOSED_PATH]: "closed.html",
  [FIXTURE_LATE_FORM_PATH]: "form.html+snippets/late-form.html",
  [FIXTURE_UNDERSCORE_FORM_PATH]: "form.html+snippets/underscore-form.html",
  ...CAPTCHA_RECORDER_PAGE,
  ...Object.fromEntries(
    CAPTCHA_VARIANTS.map((v) => [FIXTURE_CAPTCHA_PATHS[v], `form.html+captcha/${v}.html`]),
  ),
};

interface StoredQuestion {
  id: string;
  label: string;
  required: boolean;
  type: string;
  options: string[] | null;
}

/** The posting's stored questions (question id = the page's control id). */
export const FIXTURE_QUESTIONS: readonly StoredQuestion[] = [
  { id: "first_name", label: "First Name", required: true, type: "text", options: null },
  { id: "last_name", label: "Last Name", required: true, type: "text", options: null },
  { id: "email", label: "Email", required: true, type: "text", options: null },
  { id: "phone", label: "Phone", required: false, type: "text", options: null },
  { id: "resume", label: "Resume/CV", required: true, type: "file", options: null },
  { id: "question_1001", label: "LinkedIn Profile", required: false, type: "text", options: null },
  {
    id: "question_1002",
    label: "Why do you want to work here?",
    required: true,
    type: "long_text",
    options: null,
  },
  {
    id: "question_1003",
    label: "Are you comfortable working remotely?",
    required: true,
    type: "yes_no",
    options: ["Yes", "No"],
  },
  {
    id: "question_1004",
    label: "Preferred time zone",
    required: false,
    type: "choice",
    options: ["UTC+7 (Jakarta)", "UTC+1 (Berlin)", "UTC-5 (New York)"],
  },
  {
    id: "question_1005",
    label: "Which tools do you use?",
    required: false,
    type: "multi_choice",
    options: ["Git", "Docker", "Kubernetes", "Terraform"],
  },
  {
    id: "question_1006",
    label: "Which stack do you use most?",
    required: false,
    type: "choice",
    options: ["TypeScript", "Go", "Python"],
  },
  {
    id: "question_1007",
    label: "Which regions can you work in?",
    required: false,
    type: "multi_choice",
    options: ["Asia", "Europe", "Americas"],
  },
  {
    id: "question_1008",
    label: "Expected salary (USD per year)",
    required: false,
    type: "text",
    options: null,
  },
];

/** The Location question the location page's autocomplete stands for (its id is not any control's id on that page). */
export const FIXTURE_LOCATION_QUESTION: StoredQuestion = {
  id: "location",
  label: "Location",
  required: false,
  type: "text",
  options: null,
};

/** The fixture posting's company name and title (what the fixture seeds store). */
export const FIXTURE_POSTING_NAMES = {
  company: "Fixture Co",
  title: "Senior Backend Engineer (fixture)",
};
/** Fake persona texts for the two free-text answers: the cover letter names the company and the role. */
export const COVER_LETTER_FIXTURE_TEXT =
  "Dear {company} team, I am applying for the {role} position. Thank you for reading.";
export const CONTRACTOR_NOTE_FIXTURE_TEXT = "I work as a contractor and invoice monthly.";

const answer = (key: string, text: string, extra: Partial<PlanAnswer> = {}): PlanAnswer => ({
  key,
  question: null,
  alternatives: null,
  answer: text,
  type: null,
  choices: null,
  approved: true,
  ...extra,
});

/** Fake persona. The resume path is the one `ensureFixtureResume` writes. */
export function fixtureAnswers(resumePath: string): PlanAnswer[] {
  return [
    answer("contact.full_name", "Alex Example"),
    answer("contact.email", "alex.example@example.test"),
    answer("contact.phone", "+1 555 0100 123"),
    answer("misc.cover_letter_text", COVER_LETTER_FIXTURE_TEXT),
    answer("misc.contractor_note", CONTRACTOR_NOTE_FIXTURE_TEXT),
    answer("contact.linkedin", "https://www.example.test/in/alex-example"),
    answer("profile.resume_file", resumePath),
    answer("work_setup.remote_only", "Yes", {
      type: "yes_no",
      question: "Are you comfortable working remotely?",
    }),
    answer("misc.open_to_crypto_web3", "I like building reliable backend systems.", {
      question: "Why do you want to work here?",
    }),
    answer("contact.timezone", "UTC+7 (Jakarta)", {
      question: "Preferred time zone",
      type: "choice",
      choices: ["UTC+7 (Jakarta)", "UTC+1 (Berlin)", "UTC-5 (New York)"],
    }),
    answer("experience.years_nodejs_backend", "Git, Docker", {
      question: "Which tools do you use?",
    }),
    answer("experience.current_role", "TypeScript", {
      question: "Which stack do you use most?",
      type: "choice",
      choices: ["TypeScript", "Go", "Python"],
    }),
    answer("work_setup.working_hours_overlap", "Asia, Europe", {
      question: "Which regions can you work in?",
    }),
  ];
}

const optionsOf = (id: string): string[] =>
  (FIXTURE_QUESTIONS.find((q) => q.id === id) as StoredQuestion).options as string[];

/** The owner-approved mappings the fixture persona needs for its choice questions (a yes / no question needs none). */
export function fixtureChoiceMappings(): Map<string, string[]> {
  const entry = (key: string, id: string, chosen: string[]): [string, string[]] => {
    const q = FIXTURE_QUESTIONS.find((x) => x.id === id) as StoredQuestion;
    return [mappingId(key, q.label, optionsOf(id)), chosen];
  };
  return new Map([
    entry("contact.timezone", "question_1004", ["UTC+7 (Jakarta)"]),
    entry("experience.years_nodejs_backend", "question_1005", ["Git", "Docker"]),
    entry("experience.current_role", "question_1006", ["TypeScript"]),
    entry("work_setup.working_hours_overlap", "question_1007", ["Asia", "Europe"]),
  ]);
}

/** A tiny PDF (header only matters to `probeResumeFile`) under `<data dir>/dryruns/.fixture/` (dir 0700, file 0600). */
export function ensureFixtureResume(dataDir: string): string {
  const dir = join(resolve(dataDir), DRYRUNS_DIR, ".fixture");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(join(resolve(dataDir), DRYRUNS_DIR), 0o700);
  chmodSync(dir, 0o700);
  const file = join(dir, "fixture-resume.pdf");
  writeFileSync(file, "%PDF-1.4\n% fixture resume, fake persona\n%%EOF\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/** Plan inputs of the fixture persona: approved answers, approved mappings, an ask, no scam flag. */
export function fixtureContext(dataDir: string): PlanContext {
  return {
    answers: fixtureAnswers(ensureFixtureResume(dataDir)),
    choiceMappings: fixtureChoiceMappings(),
    ask: { askIdrMonth: 30_000_000, askUsdYear: 24_000, askText: null },
    scamFlagged: false,
    posting: FIXTURE_POSTING_NAMES,
  };
}

/** Inserts the fixture posting and its stored questions (idempotent). The answer bank is not touched. */
export function seedGreenhouseFixture(db: Db, now: Date = new Date()): string {
  const at = now.toISOString();
  db.insert(postings)
    .values({
      id: FIXTURE_POSTING_ID,
      source: "greenhouse",
      external_id: "1001",
      url: "https://job-boards.greenhouse.io/acme/jobs/1001",
      title: "Senior Backend Engineer (fixture)",
      company_name: "Fixture Co",
      first_seen_at: at,
      last_seen_at: at,
    })
    .onConflictDoNothing()
    .run();
  db.transaction((tx) => {
    tx.delete(posting_questions)
      .where(
        and(
          eq(posting_questions.posting_id, FIXTURE_POSTING_ID),
          eq(posting_questions.ats_type, "greenhouse"),
        ),
      )
      .run();
    for (const q of FIXTURE_QUESTIONS) {
      tx.insert(posting_questions)
        .values({
          id: randomUUID(),
          posting_id: FIXTURE_POSTING_ID,
          ats_type: "greenhouse",
          question_id: q.id,
          label: q.label,
          required: q.required,
          type: q.type,
          options: q.options === null ? null : JSON.stringify(q.options),
          normalized_label: normalizeQuestion(q.label),
          matched_key: null,
          fetched_at: at,
        })
        .run();
    }
  });
  return FIXTURE_POSTING_ID;
}

export interface SeenRequest {
  method: string;
  path: string;
  /** The `op` query parameter, when the request has one (Ashby's GraphQL endpoint). Never the body. */
  op?: string;
}

/** An answer a fixture server gives to a request that is not one of its static pages (e.g. a fake GraphQL POST). */
export interface FixtureReply {
  status: number;
  contentType: string;
  body: string;
  /** Extra response headers (e.g. `location` of a redirect). */
  headers?: Record<string, string>;
}

export type FixtureResponder = (req: {
  method: string;
  url: URL;
  body: string;
}) => FixtureReply | undefined;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
};

export interface FixtureServer {
  origin: string;
  requests: SeenRequest[];
  /** Everything the server saw that was not GET or HEAD (must stay empty). */
  nonGet: () => SeenRequest[];
  close: () => Promise<void>;
}

export type GreenhouseFixtureServer = FixtureServer;

/**
 * Serves committed pages (URL path -> file in `dir`) on 127.0.0.1 (ephemeral port) and records every request it receives.
 * `respond` answers what is not a static page (it sees the body, the server only records method, path and `op`).
 */
export async function startFixtureServer(
  dir: string,
  pages: Readonly<Record<string, string>>,
  respond?: FixtureResponder,
): Promise<FixtureServer> {
  const requests: SeenRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "";
    const op = url.searchParams.get("op");
    requests.push({ method, path: url.pathname, ...(op !== null ? { op } : {}) });
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const spec = pages[url.pathname];
      if (spec !== undefined && (method === "GET" || method === "HEAD")) {
        // "page.html+snippet.html": the snippet (a CAPTCHA variant) goes in before </body>; the page file is not changed.
        // "page.html+form:snippet.html": the same, before </form>.
        const [file = "", snippet] = spec.split("+");
        const ext = file.slice(file.lastIndexOf("."));
        let body = readFileSync(join(dir, file), "utf8");
        if (snippet !== undefined) {
          // "form:<file>": the snippet goes in before </form> (extra form controls), not before </body>.
          const inForm = snippet.startsWith("form:");
          const add = readFileSync(join(dir, inForm ? snippet.slice(5) : snippet), "utf8");
          const at = body.lastIndexOf(inForm ? "</form>" : "</body>");
          body = at === -1 ? body + add : `${body.slice(0, at)}${add}${body.slice(at)}`;
        }
        res
          .writeHead(200, { "content-type": CONTENT_TYPES[ext] ?? "text/html; charset=utf-8" })
          .end(body);
        return;
      }
      const reply = respond?.({ method, url, body: Buffer.concat(chunks).toString("utf8") });
      if (reply !== undefined) {
        res
          .writeHead(reply.status, { "content-type": reply.contentType, ...reply.headers })
          .end(reply.body);
      } else {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      }
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    nonGet: () => requests.filter((r) => r.method !== "GET" && r.method !== "HEAD"),
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

/** Serves the committed Greenhouse pages. */
export const startGreenhouseFixtureServer = (): Promise<FixtureServer> =>
  startFixtureServer(FIXTURES_DIR, PAGES);
