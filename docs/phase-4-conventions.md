# Phase 4 conventions (PM decisions, binding for Phase 4 cards)

Phase 4 = Review workflow (PLAN 8): dashboard, review queue, answer bank, unknown-questions inbox.
Done when (PLAN 8): **a day's matches are processed in under 30 minutes.**

Everything in `docs/phase-1-conventions.md`, `docs/phase-2-conventions.md` and `docs/phase-3-conventions.md` still
applies (worktrees, HTTP client, errors, Zod, fixtures, DB, LLM rules, the $1/day cap, QA FAIL loop) unless this file
says otherwise. Changing anything here takes a PM comment on the card plus a decisions.md entry. If a card and this file
disagree, this file wins; if this file and PLAN.md disagree, block. Items marked **(gate)** are PM proposals the owner
confirms or changes on the gate card; an `Answer:` comment there overrides this file and the PM records it in
decisions.md.

## 0. What Phase 4 never does
- **Never submits, applies, signs up or contacts anyone.** No form is opened in a browser, nothing is POSTed to an ATS.
  "Applied" in the review queue only records what the owner did by hand.
- No new sources. YC, JobStreet and Threads are dropped; `linkedin_posts` stays default-off. Nothing is planned for them.
- No LLM call in any Phase 4 product path (queue, answers, inbox, feedback, stats). Question matching is plain code.
  The only new LLM use is the owner-run eval scripts (section 8).
- The product never writes `config/`. Answers edited in the dashboard live in the DB; exports go to `data/exports/`.

## 1. Live runs, keys and personal data (unchanged, repeated)
- Agents use `bin/smoke` and `bin/smoke run <dir> <command...>`. The dashboard has its own smoke entry (section 3):
  `bin/smoke dash <dir> [args]`. Never env-prefixed commands, never `--with-jobspy`, never read `.env`, `config/` or
  `data/`.
- Answers, reviews, review notes, unknown questions and exports are personal data. They exist only in the DB under
  `data/` and in `config/answers.yaml`. Tests, fixtures, the demo seed and `config/*.example.*` use the fake persona
  ("Alex Example") only.
- Logs and CLI output print counts, ids, keys of answer-bank entries and action names. Never answer text, note text,
  question text from a real form, or salary numbers.

## 2. Layout and dependencies
- `packages/apply/` (new, `@job-agent/apply`, PLAN 7): answer-bank loader and store, question fetchers, matching,
  reviews and feedback services. Plain functions over `Db`; no HTTP server code.
- `apps/dashboard/` (new, `@job-agent/dashboard`; `pnpm-workspace.yaml` gains `apps/*`):
  - `src/server/` Hono app (`createApp(db, opts)`, testable with `app.request()`), `main.ts` entrypoint.
  - `src/web/` React app (Vite build to `apps/dashboard/dist/web`, served by the Hono app).
- Root script `pnpm dashboard` -> `tsx apps/dashboard/src/server/main.ts`. `pnpm check` builds the web app and runs its
  tests too.
- Allowed new dependencies (each still gets its one-line justification in the evidence): `hono`, `@hono/node-server`,
  `react`, `react-dom`, `@tanstack/react-query`, `@tanstack/react-table`, `vite`, `@vitejs/plugin-react`,
  `@testing-library/react`, `@testing-library/user-event`, `jsdom`, their `@types/*`. No UI kit, no CSS framework, no
  router library (four tabs, plain state), no state library beyond TanStack Query.
- Queue selection (which postings are "the day's matches", their sections and rank) is **one shared module** used by
  both the digest and the dashboard. Moving it out of `digest/index.ts` keeps the digest output byte-identical
  (existing digest tests unchanged).

## 3. Dashboard server (high risk: a local server holding personal data)
- Binds **127.0.0.1 only**, default port `4510`, `--port <n>`. No flag or env opens another interface. Startup prints
  `dashboard: http://127.0.0.1:<port>/` and nothing else about the data.
- **Host guard:** every request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` gets 421 (DNS
  rebinding).
- **Mutations** (POST/PUT/PATCH/DELETE) need `Content-Type: application/json` and an `Origin` header equal to the
  server's own origin (or absent `Origin` with `Sec-Fetch-Site: same-origin`); otherwise 403. No CORS headers, ever.
- Every request body and query is Zod-validated (400 with issue paths, never echoing values).
- Errors are logged as `dashboard error <route> <code>`; never request bodies or row content.
- Security headers on every response: `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- `--self-check`: starts on an ephemeral 127.0.0.1 port, requests `/api/health` and `/api/queue`, prints one line per
  request (`self-check /api/health 200`, `self-check /api/queue 200 items=<n>`), stops, exits 0 (1 on any failure).
  This is how QA and `bin/smoke` check the server live.
- DB: `openDb` sets `journal_mode = WAL` and `busy_timeout = 5000` (the hourly cron and the dashboard write the same
  file). Dashboard writes are single short transactions.

## 4. Web app rules
- Posting text, questions, answers and notes are rendered as **text** only. No `dangerouslySetInnerHTML`, no markdown
  renderer. Links are rendered only for `http:`/`https:` URLs, with `rel="noopener noreferrer"` and `target="_blank"`.
- Tabs: **Queue**, **Answers**, **Inbox**, **Stats**. The day is the Asia/Jakarta date (same `jakartaDate` as the
  digest); a date picker shows earlier days.
- Tests: Vitest + jsdom + Testing Library; the API is mocked with msw at the HTTP layer (same as the rest of the repo).

## 5. Review queue and reviews (gate: action list)
"The day's matches" = what the digest for that date lists in Top matches, Needs a look and Suspicious, plus postings
still waiting for scoring (shown, but not counted for the done-when). One row per canonical posting.

`reviews` table (append-only history; the newest row per posting is its current state):
`id, posting_id (canonical), action, reason, note, apply_url, pay_policy, reviewed_at, review_day,
fit_score, final_decision, tier, apply_type, extract_prompt_version, fit_prompt_version` (the last six are a snapshot of
what the tool said at review time, for learning; PLAN 5.5).

Actions (PM proposal, owner confirms on the gate):

| Action | Meaning | Extra field |
|---|---|---|
| `interested` | Shortlisted; the owner will apply by hand or in Phase 5 | - |
| `applied_manually` | The owner applied by hand outside the tool | - |
| `not_interested` | Skip | `reason` (required, fixed list below) |
| `later` | Look again tomorrow (stays in the queue) | - |
| `wrong_apply_link` | Stored apply link is wrong | `apply_url` (optional corrected URL) |
| `pay_policy` | The company's pay policy is known | `pay_policy`: `location_agnostic` / `location_adjusted` |
| `scam` / `not_scam` | Owner's scam verdict | - |
| `ask_ok` / `ask_too_high` / `ask_too_low` | Check of the salary ask (PLAN 5.6: 20-30 checks per tier) | - |

`not_interested` reasons (fixed enum): `location`, `timezone`, `role`, `seniority`, `stack`, `salary`, `company`,
`domestic_company`, `language`, `duplicate`, `expired`, `scam_suspected`, `other` (`other` needs a note).
Status actions (`interested`, `applied_manually`, `not_interested`, `later`) set the posting's review state; correction
and ask actions are extra rows and do not change it. A posting counts as **processed** when it has a status action other
than `later`.

Fast triage (t_731c5fc6): keyboard `j`/`k`, `o`, `i`, `a`, `l`, `x` + number, `s`, `u`, `?`; the selection moves to the next
open row after a status action; ticked rows take a bulk action (`POST /api/reviews/bulk`); undo within 10 s
(`POST /api/reviews/undo`, appends a restoring row, `reopen` when the posting had no earlier status); the queue response
carries `firstReviewAt` for the elapsed timer. Details and limits: decisions.md, 2026-10-15 entry for t_731c5fc6.

## 6. Feedback into the registries (Phase 3 report recommendation 4)
- `wrong_apply_link` with a URL: the `apply_links` row becomes `method = owner` (new enum value), type decided by the
  existing code (`decideApplyType` / host lists), `reason = "owner correction <date>"`. `resolve-apply` never overwrites
  an `owner` row. Without a URL: the row is cleared to `unknown` and re-resolved on the next run, once.
- `pay_policy`: `companies.pay_policy` set, `pay_policy_source = "owner:<YYYY-MM-DD>"`, `pay_policy_checked_at = now`.
  Company research never overwrites an `owner:` source. Then tier and ask are recomputed with the existing pure tier
  function for every kept posting of that company (no LLM, no network). Floor and every PLAN 5 rule still apply.
- Scam verdicts are stored only (learning data); they do not change `final_decision` in Phase 4.

## 7. Answer bank and unknown questions (gate: answer-bank fields)
- `config/answers.yaml` stays the owner's file (read-only for the product). Its current shape stays valid:
  `<group>: <key>: { answer, approved }`. New optional fields per entry: `question` (canonical wording),
  `alternatives` (list of other phrasings), `type` (`text | long_text | yes_no | number | choice`), `choices` (for
  `choice`). Strict Zod schema; errors name the key path, never values.
- `answer_bank` table: `key (group.key, unique), group, question, answer, type, choices, alternatives, approved,
  approved_at, source (config | dashboard), updated_at`. `answers import` upserts config entries; a row last edited in
  the dashboard is never overwritten by the import (it prints `kept dashboard version: <key>`).
- **Only approved answers ever count as covering a question.** Nothing is approved automatically; approving is an
  explicit owner click. Salary questions are never answered from the bank: they map to the per-posting tier ask and
  stay in review (PLAN 5.6, 10).
- Questions come only from public, read-only ATS job APIs that the research card confirms (no apply-page HTML unless
  the research shows it is a plain public GET with no terms problem). Stored per posting in `posting_questions`.
- Matching is plain code: normalize (case, punctuation, whitespace, trailing "?" and "*"), exact match against the
  canonical question and alternatives; standard ATS fields (name, e-mail, phone, resume, cover letter, LinkedIn URL)
  map to fixed keys. Unmatched questions go to `unknown_questions` (one row per normalized text, with the count of
  postings that ask it and first/last seen). No fuzzy or LLM matching in Phase 4.
- Inbox actions: answer (creates a `dashboard` answer, approved only if the owner ticks approve), link to an existing
  answer as an alternative phrasing, dismiss. After each action the open postings are re-matched.

## 8. Eval scripts (Phase 3 report recommendation 5)
- `pnpm --filter @job-agent/pipeline eval:extract` and `eval:fit`: need `ANTHROPIC_API_KEY` **and** `--live`; without
  both they print what they would run and exit 0. Agents never pass `--live`.
- They go through the shared client and the $1/day cap (`llm_calls.purpose` gains `eval_extract`, `eval_fit`), plus
  `--max-usd` (default 0.50, can only lower). Output: per-field accuracy, misses by id, cost. No posting text printed.
- Committed golden sets are fake or public postings under `fixtures/eval/` (fake persona CV for fit). `--set <path>`
  reads another set; `eval:export-reviews` writes the owner's set from reviews to `data/eval/` (never committed).

## 9. Done-when measurement
- Each review row has `reviewed_at`; `review-stats [--date]` and the Stats tab show for a day: matches, processed,
  open, elapsed from first to last review action, median seconds per posting, action and reason counts, ask checks per
  tier. The owner's one-day run is the proof; agents prove the numbers with the demo seed.

## 10. Demo data
- `seed-demo` (CLI) writes fake postings, analysis, intel, apply links, questions and answers covering every queue
  section into the DB it is given. It refuses (exit 2) when the DB path is the default `data/job-agent.db` or any path
  under the repo's `data/`. Used through `bin/smoke run <dir> seed-demo`.
