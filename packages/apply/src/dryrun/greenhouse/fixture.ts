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
export const FIXTURE_CAPTCHA_PATH = "/acme/jobs/1002";
export const FIXTURE_CHANGED_PATH = "/acme/jobs/1003";

const FIXTURES_DIR = fileURLToPath(new URL("../../../fixtures/greenhouse/", import.meta.url));

const PAGES: Record<string, string> = {
  [FIXTURE_FORM_PATH]: "form.html",
  [FIXTURE_CAPTCHA_PATH]: "captcha.html",
  [FIXTURE_CHANGED_PATH]: "changed.html",
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
    answer("profile.name", "Alex Example"),
    answer("profile.email", "alex.example@example.test"),
    answer("profile.phone", "+1 555 0100 123"),
    answer("profile.linkedin", "https://www.example.test/in/alex-example"),
    answer("profile.resume_file", resumePath),
    answer("work.remote", "Yes", {
      type: "yes_no",
      question: "Are you comfortable working remotely?",
    }),
    answer("work.why", "I like building reliable backend systems.", {
      question: "Why do you want to work here?",
    }),
    answer("work.timezone", "UTC+7 (Jakarta)", {
      question: "Preferred time zone",
      type: "choice",
      choices: ["UTC+7 (Jakarta)", "UTC+1 (Berlin)", "UTC-5 (New York)"],
    }),
    answer("work.tools", "Git, Docker", { question: "Which tools do you use?" }),
    answer("work.stack", "TypeScript", {
      question: "Which stack do you use most?",
      type: "choice",
      choices: ["TypeScript", "Go", "Python"],
    }),
    answer("work.regions", "Asia, Europe", { question: "Which regions can you work in?" }),
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
    entry("work.timezone", "question_1004", ["UTC+7 (Jakarta)"]),
    entry("work.tools", "question_1005", ["Git", "Docker"]),
    entry("work.stack", "question_1006", ["TypeScript"]),
    entry("work.regions", "question_1007", ["Asia", "Europe"]),
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
}

export interface FixtureServer {
  origin: string;
  requests: SeenRequest[];
  /** Everything the server saw that was not GET or HEAD (must stay empty). */
  nonGet: () => SeenRequest[];
  close: () => Promise<void>;
}

export type GreenhouseFixtureServer = FixtureServer;

/** Serves committed pages (URL path -> file in `dir`) on 127.0.0.1 (ephemeral port) and records every request it receives. */
export async function startFixtureServer(
  dir: string,
  pages: Readonly<Record<string, string>>,
): Promise<FixtureServer> {
  const requests: SeenRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({ method: req.method ?? "", path: url.pathname });
    req.resume();
    const file = pages[url.pathname];
    if (file !== undefined && (req.method === "GET" || req.method === "HEAD")) {
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(readFileSync(join(dir, file)));
    } else {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
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
