# Phase-end audit #4: Phase 4 (review workflow)

Audited commit: `origin/main` at `33b53d0` (chore: audit ledger t_c5832945). Reviewed `git diff audit-9..main` (Phase 4 starts
after audit-9; the tag `audit-10` exists at `d2eb2b7` but has no `docs/audits/` report, see finding 5) and the whole ledger.
Verdict: **PASS** (no BLOCKER, no MAJOR; five MINOR).

## Setup (acceptance 1)
- Detached checkout of main, `pnpm install --frozen-lockfile`: ok.
- `pnpm check`: exit 0. `Test Files 116 passed (116)`, `Tests 2160 passed (2160)` (typecheck, lint, web build and tests included).

## Live checks (acceptance 3 and 4)
Smoke dir: a fresh `bin/smoke --demo` run (exit 0; himalayas, remoteok, remotive, weworkremotely, hn, arbeitnow, greenhouse ok;
`answers import: 10 added`, `match-questions: 3 questions, 2 covered, 0 salary, 1 unknown`, digest written).

- `bin/smoke dash <dir> --self-check`:
  ```
  self-check /api/health 200
  self-check /api/queue 200 items=66
  ```
- `bin/smoke run <dir> seed-demo` (second run after `--demo`): `seed-demo 2026-10-16: added 0 postings, 0 questions` (idempotent).
- Dashboard running on `--port 4511`:
  | request | result |
  |---|---|
  | `GET /api/health`, right Host | 200 |
  | `Host: evil.example:4511` | **421** |
  | POST `Origin: http://evil.example`, `application/json` | **403** |
  | POST `Origin: http://127.0.0.1:4511`, `text/plain` | **403** |
  | POST JSON with no Origin and no Sec-Fetch-Site | **403** |
  | response headers | CSP `default-src 'self'; frame-ancestors 'none'`, `nosniff`, `referrer-policy: no-referrer`, no `access-control-*` |
  | `http://[::1]:4511/` | connection refused (curl exit 7) |
  `server.ts:23` binds `hostname: LOOPBACK` with a comment that no flag or env changes it. (I could not run `lsof`/`netstat`
  here, so the "127.0.0.1 only" check is the IPv6 refusal plus the code.)
- Scripted review pass through the API (`data/handoff/t_ca5ce6c3-review-pass.mjs`, uses a same-origin JSON POST): 9 demo postings
  in the queue (4 are in "waiting", which the done-when does not count), 9 x `201`. API probes: `not_interested` without reason ->
  400 `{"path":"reason"}`; `wrong_apply_link` with `javascript:alert(1)` -> 400 `{"path":"apply_url"}`; no value echoed.
- `bin/smoke run <dir> review-stats`:
  ```
  matches: 5, processed: 5, open: 0
  actions: applied_manually 2, interested 3, not_interested 4
  not_interested reasons: other 2, role 2
  done-when: 0 min for 5 matches (met)
  ```
  The done-when line exists and is computed by `stats.ts:151` (`matches > 0 && processed === matches && elapsed <= 30`; never met with
  zero matches). It only proves the arithmetic; the owner's one-day run is the real proof (conventions section 9).

## Guardrails (acceptance 5)
- No submit/apply path: `git grep` over `apps/`, `packages/apply`, `review/`, `eval/`, `seed-demo.ts` finds only form `type="submit"`
  buttons of the dashboard's own forms. `window.open` (`QueueTab.tsx:212`) opens only a `safeHref` (http/https) link with
  `noopener,noreferrer`. `fetch-questions` uses `httpGet` only, 2 s per host (`questions/index.ts:34`, `:64`).
- No `config/` writes: the only product file writes are `exportAnswers` (to `<db dir>/exports`, `main.ts:24`) and the eval export
  (`data/eval`, mode 0600, refuses repo paths outside `data/`, `export-reviews.ts:152-156`). `eval/fit.ts` reads `config/cv.example.md`
  for the committed set and `config/cv.md` only for a custom `--set` (owner-run, `--live` and key needed).
- Eval scripts: `eval/extract.ts:107` and `eval/fit.ts:201` both require `--live` AND `ANTHROPIC_API_KEY`, otherwise print what they would run.
- Personal data: searched the Phase 4 paths for e-mail addresses (`@x.com/.org/.net/.io/.dev/.id`) and for the owner's name strings; no
  hits except the existing GitHub handle in `package.json` and the `NEEDS-ZEIN.md` file name in the harness scripts. Demo seed, fixtures and
  answer examples use the fake persona.
- No dangerouslySetInnerHTML / innerHTML anywhere in `apps/dashboard/src` (only `ExternalLink` renders `<a href>` after the http(s) check).

## Break-the-code checks (acceptance 6; every change reverted with `git checkout -- .`)
| change | result |
|---|---|
| `guards.ts`: drop the Host comparison | 7 tests fail (`421s a foreign Host`, rebinding, wrong port, static files, headers on 421, real-socket test) |
| `record.ts`: remove the `not_interested` reason/`other`-needs-note rules | 5 tests fail (`record.test.ts` x2, `review-routes.test.ts` x3, incl. bulk) |
| `company-research.ts`: drop the `owner:%` in-flight guard | `never overwrites an owner mark, even when the research disagrees` fails |
| `apply-links/index.ts`: `NOT IN ('llm','owner')` -> `('llm')` | `skips an owner row stored as unknown after the recheck window` fails |
| `match.ts`: drop `if (!e.approved) continue` | 7 tests fail (match, match-questions, inbox route, e2e) |
All guards are covered by tests that fail when the behaviour is broken.

Other owner-protection paths read and found sound: `registry.ts:15,58` (a posting never overwrites `owner:`), `owner.ts` (owner row becomes
`method=owner`, `discover.ts:170` deletes only `method=llm` rows when a posting is edited, so an owner link survives employer edits),
`record.ts` runs the review row, pay-policy recompute and link correction in one transaction.

## Depth (tasks chosen and why)
1. Dashboard server + guards (high risk, local server with personal data): live checks and break test above; `app.ts` error path logs the
   route pattern only; every body is Zod `strictObject`.
2. Review/feedback (`record.ts`): the pay-policy and apply-link side effects change asks and links, so read in full (bulk/undo are
   all-or-nothing in one transaction; undo limited to 15 s server-side).
3. Answer bank, matching, inbox (`answers-store.ts`, `match.ts`, `match-questions.ts`, `inbox.ts`): read in full, source of findings 2 and 3.
Breadth: the remaining ledger rows (schema, demo seed, web skeleton, queue UI, fast triage, stats, digest, evals, e2e, docs) were checked
through the diff list, the full-suite run and the guardrail searches above; nothing stood out beyond the findings below.

## Findings
1. **[MINOR] `packages/pipeline/src/seed-demo.ts:34-41`** `seed-demo` refuses the default DB and paths under `data/` by string path
   (`resolve`, no `realpath`). A symlink into `data/`, or an owner who points `JOB_AGENT_DB` at a real DB kept outside `data/`, would get fake
   demo rows. Reproduce: `refusalReason("/tmp/link-to-data/job-agent.db")` returns null. Suggest `realpath` of the file/parent, and refusing a
   DB that already holds non-`demo-` postings.
2. **[MINOR] `packages/apply/src/match.ts:74-75`** the SALARY regex is narrow. Checked with `matchQuestion`: "How much do you expect to
   be paid?", "What is your expected base?", "Desired annual pay", "Berapa gaji yang Anda harapkan?" return `null` (unknown), not `salary`. They
   land in the inbox with an answer form (`inbox.ts:117`, salary false), so the owner could answer and approve one, and the bank would then cover
   it, against conventions section 7 ("salary questions are never answered from the bank"). Nothing submits in Phase 4, so no harm yet; fix before
   Phase 5 (broader patterns: `paid`, `expected base/pay`, `gaji`, `pay` + expect/desired, `financial`, `compensation` already there).
3. **[MINOR] `packages/apply/src/answers-store.ts:152` and `inbox.ts:179-180`** approval is cleared only when the answer text changes. Editing
   `question`, `alternatives`, `type` or `choices` of an approved answer, or linking an inbox wording to it, keeps `approved = true`, so an approved
   answer starts covering wordings the owner never approved it for. Each is an explicit owner click, so exposure is low; consider re-asking approval
   when the wording set changes, or show it in the UI.
4. **[MINOR] `answers-store.ts:199`** `exportAnswers` writes the owner's answers with the default file mode (0644); the eval export uses 0600.
   Under gitignored `data/exports`, but should match. Suggest `{ mode: 0o600 }`.
5. **[MINOR] housekeeping:** `docs/audit-ledger.md` still says `Last audit tag: (none yet)`, its table is broken by repeated `Counts:` lines, and
   it still lists rows covered by audit-1..audit-10 (~90 rows). `audit-10` (tag at `d2eb2b7`) has no report under `docs/audits/`. Needs the clean-up under "Ledger" below.

Notes (not findings): `i`/`a`/`l`/`x` in the queue apply to every ticked row when any row is ticked (bulk), without extra confirmation (undo for
10 s exists); the done-when elapsed time runs from the first to the last review row of the day, so idle breaks count against the 30 minutes
(conservative); `POST /api/reviews` accepts `reopen`, which looks intended.

## Fix tasks
- Harden `seed-demo` refusal (realpath, and refuse a DB with non-demo postings) and add a test with a symlink.
- Broaden the salary wording regex in `match.ts` (and tests with the phrases above; keep the "never answered from bank" assertion for each).
- Decide and implement: editing wording/type/choices of an approved answer (or linking an inbox wording) clears approval or is flagged; tests.
- Write the answers export with mode 0600.
- Ledger/tag clean-up (below).

## Ledger and tag (for the automation; I did not commit, tag or push)
- Suggested: copy this report to `docs/audits/phase-4.md`, tag the audited commit `audit-11`, set `Last audit tag: audit-11` in
  `docs/audit-ledger.md` and clear every row (all tasks listed there are covered by this audit or by audit-1..audit-10), then record
  the missing `audit-10` report as a known gap.
- Phase-4 parent cards covered: t_2e40122d, t_3cef0999, t_43ff11af, t_481091fb, t_49ad3959, t_59a62308, t_5f17e853, t_607d7abb, t_65b66c9e,
  t_7a95db90, t_8aeeedc2, t_8e2c363f, t_9dddc022, t_b9197c40, t_bfdcbaf5, t_c08c1916, t_e119a538, t_ea646225, t_f1a0d174, t_f1b9c247.
- Acceptance item "report saved as docs/audits/phase-4.md; tag; ledger cleared" is therefore **not done by me** (rule: never merge or push);
  everything else in the card is done and evidenced above.
