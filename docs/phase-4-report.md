# Phase 4 report: Review workflow

Date: 2026-10-16. Author: PM (card t_4b0651e2). Status: ready for owner review (t_acf2f9cd).

**Update 2026-10-16 (card t_1267839f):** the fix round is merged and re-audit #11 passed. R1 and A1-A4 are closed; A5 is still
open. See "Fix round" at the end. Items closed by the fix round are marked **[resolved]** below.

**Summary.** All 20 dev cards and the research card are merged on `main`. You now have:
- a local dashboard (127.0.0.1 only) with four tabs: Queue, Answers, Inbox and Stats;
- one-key review actions, with your corrections fed back into the apply-link and pay-policy registries;
- an answer bank loaded from your `answers.yaml`;
- application questions fetched from public Greenhouse, Workable and Recruitee APIs and matched to your approved answers;
- an inbox for questions that no approved answer covers;
- `review-stats` for the done-when check;
- two owner-run eval scripts.

Nothing in Phase 4 submits, signs up or contacts anyone, and no product path calls an LLM.

The phase-end audit #4 (t_ca5ce6c3) **passed**: no blocker, no major, five minor findings. On the auditor's clean checkout of
`33b53d0`, `pnpm check` passed: 116 files, 2160 tests.

Before you approve, read these three items:
1. **The done-when has no real proof yet.** `review-stats` computes it correctly on demo data. Only one real review day by
   you can prove "a day's matches processed in under 30 minutes". See "Done-when status".
2. **`pnpm check` fails in your main checkout. The cause is your JobSpy `.venv`, not the code:**
   - Prettier checks 4 files inside `workers/jobspy/.venv` (`.prettierignore` does not list it).
   - One CLI test (`cli.test.ts:68`, `discover --force` over every adapter) **starts the real JobSpy worker** when
     `workers/jobspy/.venv/bin/python` exists (`worker.ts:46` only skips when it is missing). The test then times out.
   
   My `pnpm test` runs on this machine (3 runs at about 03:08-03:10 WIB) therefore may have run logged-out LinkedIn/Indeed
   searches from your IP. That is the same kind of search the hourly run makes, but a test must never do it. I recommend a
   high-risk fix card (below).

   **[resolved]** by F1 (t_af1e9656) and `.prettierignore` (your commit `f6b0146`). See "Fix round".
3. **Two answer-bank findings matter before Phase 5:**
   - Some salary wordings are not recognized as salary questions, so you could approve a bank answer for them (finding A2).
   - Editing the wording of an approved answer keeps it approved (finding A3).

   Neither matters while nothing is filled or submitted.

   **[resolved]** A2 by F2 (t_e8dd3801; a lexical residual is left, see M2 under "Fix round"), A3 by F3 (t_aaa0bf00).

## What shipped

Merge commits are on `main` between tags `audit-9` and `c6be95d`. Full per-card plan: `docs/phase-4-backlog.md`.

| # | Card (dev / QA) | Risk | What it does |
|---|---|---|---|
| R1 | t_5c4e4567 research | low | Decides where application questions are public:<br>**in:** Greenhouse, Workable, Recruitee (public JSON GET);<br>**out:** Lever (only in apply-page HTML), Ashby and SmartRecruiters (no public source).<br>`docs/research/t_5c4e4567-ats-application-questions.md` |
| D1 | t_1099c9eb / t_3cef0999 | medium | Migration 0004 adds `reviews`, `answer_bank`, `posting_questions` and `unknown_questions`. SQLite in WAL mode, so cron and the dashboard can write at the same time |
| D4 | t_05df2eda / t_c9c1b338, audit t_9dddc022 | **high** | Hono server on a hard-coded 127.0.0.1:4510 with:<br>- Host guard (421) against DNS rebinding;<br>- same-origin + JSON-only checks on every write (403);<br>- no CORS, plus CSP, `nosniff` and `no-referrer`;<br>- `--self-check`;<br>- `bin/smoke dash` |
| D2 | t_2d987b85 / t_59a62308 | medium | `answers.yaml` loader (new optional fields `question`, `alternatives`, `type`, `choices`) and `answers import`. An answer edited in the dashboard is never overwritten by an import |
| D3 | t_99deaa3f / t_8e2c363f | medium | `seed-demo` fills a smoke DB with fake queue data and refuses the real DB |
| D5 | t_c269b5ab / t_ea646225 | medium | Vite + React + TanStack Query web app with four tabs. Its build and jsdom tests run inside `pnpm check` |
| D6 | t_53073918 / t_5f17e853 | medium | Shared day-selection module (the digest and the queue pick the same postings), queue and detail API, `POST /api/reviews` with strict Zod bodies |
| D7 | t_add8c02f / t_8aeeedc2 | medium | Queue UI: a table per digest section, a detail panel (fit reasons, flags, scam reasons, history) and action buttons with a reason picker |
| D9 | t_ff411096 / t_43ff11af | medium | `wrong_apply_link` stores your link as `method = owner`; `resolve-apply` never overwrites it |
| D10 | t_49015ee6 / t_55857677, audit t_f1b9c247 | **high** | A `pay_policy` mark sets the company's policy (`owner:<date>`) and recomputes tier and ask with the existing pure tier code, in one transaction. The salary floor still applies; no LLM, no network |
| D8 | t_731c5fc6 / t_c08c1916 | medium | Fast triage:<br>- keys `j k o i a l x s u ?`;<br>- auto-advance;<br>- bulk actions on ticked rows;<br>- 10 s undo (appends a row, history kept);<br>- elapsed timer from the first action of the day |
| D11 | t_da6ce498 / t_2e40122d | medium | Answers tab: list, edit, approve, alternatives and YAML export to `data/exports/answers-<date>.yaml` |
| D12 | t_22e91591 / t_bfdcbaf5 | medium | `fetch-questions`:<br>- public GET only, 2 s per host;<br>- stops a host after 401/403/429;<br>- at most 50 fetches per run;<br>- part of `bin/run-hourly` after `resolve-apply` |
| D13 | t_8140d1bc / t_f1a0d174 | medium | Plain-code matching of questions to **approved** answers on normalized wording. Salary questions are never answered from the bank. Queue rows show `covered/total` |
| D14 | t_bb962b1b / t_e119a538 | medium | Inbox tab: answer, link as an alternative wording, or dismiss. Each action re-matches the open postings |
| D15 | t_55e60eeb / t_65b66c9e | medium | `review-stats` CLI and Stats tab:<br>- done-when line;<br>- median seconds per posting;<br>- action and reason counts;<br>- ask checks per tier;<br>- last 7 days |
| D16 | t_8f401a3b / t_49ad3959 | medium | Reviewed postings leave the digest's Top matches. The digest gains a review line with counts and the dashboard link |
| D17 | t_f413f9ea / t_481091fb | medium | `eval:extract` with a committed golden set. Calls the model only with `--live` and a key |
| D18 | t_33bd7696 / t_7a95db90 | medium | `eval:fit` on the fake-persona set, and `eval:export-reviews`, which builds your own set from your reviews into `data/eval/` (mode 0600) |
| D19 | t_3b914bae / t_b9197c40 | medium | `e2e.phase4` test, plus `bin/smoke --demo` covering the dashboard, answers import and match-questions |
| D20 | t_c5832945 / t_607d7abb | low | `docs/running.md` "Dashboard and review flow" section |

Also merged during the phase (process): t_ce49d729 (holds that only you can clear are labelled OWNER) and t_627338ac (agents never
touch `config/`; dev reports carry "Owner applies" proposals instead).

Your gate answers (t_10be94d5) were built as given:
- dashboard only, no Telegram or e-mail;
- the action list and not-interested reasons from conventions section 5;
- the answer-bank fields from section 7, with dashboard edits kept in the DB;
- $1/day cap and no LLM drafting;
- t_b90a4fc1 archived.

## How to run it

Full guide: `docs/running.md`, section "Dashboard and review flow".

```sh
# 1. Answer bank: copy the example shape into config/answers.yaml, fill in truthful answers, mark approved: true
pnpm job-agent answers import          # run again after every edit of the file

# 2. Dashboard (127.0.0.1 only; Ctrl-C stops it)
pnpm dashboard                         # http://127.0.0.1:4510/
pnpm dashboard --self-check            # one line per health/queue request, then exits

# 3. Try it on fake data first, no real DB touched
bin/smoke --demo                       # prints the smoke dir
bin/smoke dash <smoke dir>

# 4. Questions: run by bin/run-hourly; by hand:
pnpm job-agent fetch-questions
pnpm job-agent match-questions         # after changing approvals outside the dashboard

# 5. Done-when check after one real review day
pnpm job-agent review-stats            # today, Asia/Jakarta

# 6. Evals (cost money, count against the $1/day cap, --max-usd default 0.50)
pnpm --filter @job-agent/pipeline eval:extract --live
pnpm --filter @job-agent/pipeline eval:fit --live
pnpm --filter @job-agent/pipeline eval:export-reviews
pnpm --filter @job-agent/pipeline eval:fit --set data/eval/reviews-<date>.json --live
```

Review keys:

| Key | Action |
|---|---|
| `j` / `k` | next / previous posting |
| `o` | open the apply link |
| `i` | interested |
| `a` | applied manually |
| `l` | later |
| `x` then `1`-`9` / `0` | not interested, with a reason |
| `s` | scam |
| `u` | undo |
| `?` | list the keys |

Keys act on all ticked rows when any row is ticked.

**Owner applies (still open):** `config/answers.example.yaml` is unchanged since the first commit. It does not show the new
optional fields (`question`, `alternatives`, `type`, `choices`). Agents cannot edit `config/`. The proposed content is in the D2 and
D14 dev reports (`data/handoff/t_2d987b85-comment.md`, `data/handoff/t_bb962b1b-comment.md`). A proposed `config/README.md` update
is in `data/handoff/t_c5832945-comment.md`. The example shape is also documented in `docs/running.md` ("Answer bank").

**[resolved]** for `config/answers.example.yaml`: you committed it in `f6b0146`. The `config/README.md` proposal is not in that
commit; apply it or tell me to drop it.

## Test status

**Auditor, clean detached checkout of `33b53d0` (the code on `main` now; `c6be95d` only adds the audit report):**
```
pnpm check: exit 0
Test Files 116 passed (116)
Tests 2160 passed (2160)        (typecheck, lint, web build, tests, pre-commit hook tests, Python worker tests)
```
Phase 3 ended at 1554 tests, so Phase 4 adds 606.

**PM, main checkout at `c6be95d`, 2026-10-16 03:07-03:10 WIB** (this checkout has your `workers/jobspy/.venv`):
```
$ pnpm check
$ tsc -b
$ eslint . && prettier --check .
[warn] workers/jobspy/.venv/lib/python3.12/site-packages/pip/_vendor/bom.cdx.json
[warn] workers/jobspy/.venv/lib/python3.12/site-packages/pip/_vendor/urllib3/contrib/emscripten/emscripten_fetch_worker.js
[warn] workers/jobspy/.venv/lib/python3.12/site-packages/pydantic_core-2.50.1.dist-info/sboms/pydantic-core.cyclonedx.json
[warn] workers/jobspy/.venv/lib/python3.12/site-packages/urllib3/contrib/emscripten/emscripten_fetch_worker.js
[warn] Code style issues found in 4 files. Run Prettier with --write to fix.
[ELIFECYCLE] Command failed with exit code 1.

$ pnpm build:web          -> ✓ built in 116ms
$ pnpm test               (run twice, same result)
 FAIL  packages/pipeline/src/cli.test.ts > discover command > exits 0 when every registered adapter returns no postings
Error: Test timed out in 20000ms.
 Test Files  1 failed | 115 passed (116)
      Tests  1 failed | 2159 passed (2160)
```
- Typecheck and ESLint pass. Prettier flags only files in the gitignored venv.
- The failing test passes where no venv exists (auditor run). It times out here because `packages/sources/src/jobspy/worker.ts:46`
  spawns `workers/jobspy/.venv/bin/python run.py` whenever that file exists. The msw mock cannot intercept a Python process.
- I could not run the hook, hold and Python test scripts on their own: they needed approval in this unattended run. The auditor's
  green `pnpm check` covers them.
- Note on batch audit #9's "no `typecheck` script": the root `package.json` has one (`tsc -b`, first step of `pnpm check`). The
  auditor ran `pnpm -r typecheck`, which looks in the workspace packages. This is not a real gap.

## Phase-end audit #4 (t_ca5ce6c3): PASS

Report: `docs/audits/phase-4.md`.

**Live checks.** The auditor ran these on a fresh `bin/smoke --demo` database:

| Check | Result |
|---|---|
| Foreign `Host` | 421 |
| Cross-origin POST | 403 |
| `text/plain` POST | 403 |
| POST with no Origin | 403 |
| IPv6 `[::1]` | connection refused |
| CSP, `nosniff`, `no-referrer` headers | present |
| CORS headers | none |
| Scripted review pass | 9 x `201`; bad inputs rejected without echoing them |
| `review-stats` | `done-when: 0 min for 5 matches (met)` |

**Break-the-code tests.** The auditor broke each of these five protections on purpose; tests caught every one:
- the Host guard;
- the not-interested reason rules;
- the owner pay-policy guard;
- the owner apply-link guard;
- the approved-only matching.

**Guardrail searches:**
- no submit or apply path;
- no `config/` writes;
- no raw HTML rendering;
- no personal data in the Phase 4 paths.

### Findings from the phase-end audit (all open, no fix cards yet)

Fix round status: A1-A4 **[resolved]**, A5 still open. Details in "Fix round".

| # | Finding | Severity |
|---|---|---|
| A1 | `seed-demo.ts:34-41` refuses the real DB by path string only. A symlink into `data/`, or a real DB kept outside `data/`, would get fake rows. Fix: realpath, and refuse any DB holding non-`demo-` postings (same as batch 8 MINOR-2) | minor |
| A2 | `match.ts:74-75` misses some salary wordings, so they are treated as ordinary questions. Missed: "How much do you expect to be paid?", "What is your expected base?", "Desired annual pay", "Berapa gaji yang Anda harapkan?". These reach the inbox with an answer form, and an approved answer would then cover a salary question (conventions section 7 forbids this). Harmless while nothing fills forms; **must be fixed before Phase 5** | minor |
| A3 | `answers-store.ts:152`, `inbox.ts:179-180`: approval is cleared only when the answer text changes. Editing wording, alternatives, type or choices of an approved answer, or linking an inbox wording to it, keeps it approved. **Fix before Phase 5** | minor |
| A4 | `answers-store.ts:199`: the answers export is written 0644 (the eval export uses 0600) | minor |
| A5 | Audit housekeeping: `docs/audit-ledger.md` still says `Last audit tag: (none yet)`, has broken table lines, and lists about 90 rows already covered by audits 1-10. Tag `audit-10` has no report | minor (process) |

**Tag status I see now:**
- No `audit-11` tag exists.
- `audit-4` points at `c6be95d` (the commit that saved this audit report). The automation probably named the tag after "phase-end
  audit #4". If an earlier `audit-4` existed, it was moved.
- The ledger is not cleared yet.

The next batch audit should diff from `33b53d0`, the audited commit.

### Earlier Phase 4 batch-audit findings

| From | Finding | Status |
|---|---|---|
| Batch 8 (t_be35d3bc) MINOR-1 | `e2e.test.ts` / `smoke.test.ts` 5 s timeouts flake under full parallel runs | not seen in the auditor's or my runs; open as hardening |
| Batch 8 MINOR-2 | `seed-demo` path check | same as A1 |
| Batch 8 MINOR-3 | `questions/index.ts:63` follows redirects through the shared `httpGet` with no host pinning | **[resolved]** by F4: redirects are never followed |
| Batch 9 (t_a7215a83) | `registry.ts:15`: the `owner:` entry in `PROTECTED_SOURCE` cannot be reached and no test covers it | **[resolved]** by F4: kept as a guard, now with a test |
| Batch 9 | no `typecheck` script | not a real gap (see Test status) |

### New finding from this report (PM)

| # | Finding | Severity |
|---|---|---|
| R1 | The test suite starts the real JobSpy worker on a machine where the worker is installed. Path: `cli.test.ts:68` -> `discover --force` -> `jobspy/worker.ts:46`. This breaks the rule that tests never hit live HTTP, and it can send logged-out LinkedIn/Indeed requests from your IP every time `pnpm check` runs in the main checkout. Fix: tests must inject a fake worker path, or the CLI test must exclude JobSpy sources. Add `workers/jobspy/.venv/` to `.prettierignore` | **major** (guardrail; not caught by any audit because review worktrees have no venv). **[resolved]** by F1 |

## Known limitations

- **The 30-minute goal is unproven on real volume.** No agent has seen a real day; agents do not read `data/`. The timer runs from
  the first to the last review action of the day, so breaks count against you.
- **Question coverage:**
  - Only Greenhouse, Workable and Recruitee questions are fetched.
  - Lever, Ashby, SmartRecruiters and non-ATS postings show `0/0` questions, which means "unknown", not "covered".
- **Matching is exact on normalized wording.** A new phrasing goes to the inbox once; you then link it to an answer. There is no
  fuzzy or LLM matching (by design).
- **Bulk keys need no confirmation.** `i`, `a`, `l` and `x` act on every ticked row; undo is offered for 10 s.
- **Scam verdicts are stored only.** They do not change decisions yet.
- **Owner-run only, never run by an agent:** the evals with `--live`, your real `answers import`, a real dashboard day, and
  `eval:fit` on your own review set.
- **Phase 3 live checks are still yours:** one day of hourly runs with the JobSpy worker (Phase 3 report, "Done-when status").

## Done-when status (PLAN 8: "A day's matches processed in under 30 minutes")

The code is in place and the auditor verified it: `stats.ts:151` reports met when all of these hold:
- the day has more than 0 matches;
- every match is processed;
- elapsed time is at most 30 minutes.

On demo data it reads `done-when: 0 min for 5 matches (met)`.

**To prove it, review one real day:**
1. Let the hourly run fill a day (Asia/Jakarta date), then `pnpm dashboard`. Work Top matches first.
2. Process every match with `i`, `a` or `x`+reason. `l` (later) does not count as processed.
3. Run `pnpm job-agent review-stats`. The last line must read:
   ```
   done-when: <n> min for <m> matches (met)
   ```
   Please also note `matches: <m>`. It is the first real daily volume number we get.
4. If it says `not met`:
   - many matches: raise the fit threshold or extend the deny-list (a decision for you);
   - slow per posting: look at the median seconds in the Stats tab.

## Before you approve

1. **One real review day** and the `review-stats` line (above).
2. **Fix card for R1** (tests start the real JobSpy worker). I recommend creating it before any more `pnpm check` runs in the
   main checkout. Until then, any QA or merge step that runs tests in the repo root, rather than a worktree, can trigger it.
   **[resolved]** (F1).
3. **Fix round for A1-A4** (fix tasks are always high risk). A2 and A3 at least must land before Phase 5 fills any form.
   **[resolved]** (F2, F3, F4).
4. **Apply `config/answers.example.yaml` and `config/README.md`** from the dev reports listed under "How to run it", or tell
   me to drop them. **[resolved]** for `answers.example.yaml`; `config/README.md` still open.
5. **Audit housekeeping (A5):** set the ledger's last tag, clear the covered rows, and decide whether the Phase 4 tag is `audit-4`
   (as now) or `audit-11`. **Still open**, see "Fix round", "Still open".

## Recommendations for Phase 5: Assisted applying (dry-run)

PLAN 8 Phase 5: Greenhouse, Lever and Ashby fillers in dry-run (fill, screenshot, do not submit), and CAPTCHA goes to manual. The
semi-automated JobStreet and YC part is **dropped** (your Phase 3 decisions; `decisions.md` 2026-10-14). The done-when therefore
becomes "20-30 dry runs reviewed and correct" only. The Phase 5 plan records this as a decision entry.

1. **Prerequisites from Phase 4:**
   - fix R1 and A1-A4 first (**[resolved]** in the fix round);
   - your answer bank needs real approved answers (PLAN 9 list: notice period, work authorization, relocation, time zone,
     years per skill, degree, how you heard).

   Without the answer bank, every form is "needs input".
2. **No-submit enforced in code, not only by convention.** The filler should:
   - run Playwright with request interception that aborts every non-GET request to the ATS host;
   - never call `click` on submit-type elements;
   - have a test that fails if a POST leaves the browser.

   This should be a high-risk card with an individual audit.
3. **Order of ATSs by what we already know:**
   - **Greenhouse first:** its questions are already fetched as JSON, so the filler can be checked against stored questions.
   - **Lever second:** its questions are only in apply-page HTML. R1 found that page to be a plain public GET, and robots.txt
     allows it with a 1 s crawl delay.
   - **Ashby last:** its questions load from a GraphQL POST inside the page, so they are only visible inside a real browser.
   - Workable and Recruitee have questions but are not in PLAN's Phase 5 list. Add them only if your real volume shows many.
4. **Dry-run output stays private.** Screenshots and the filled values go under `data/dryruns/<date>/` (gitignored, mode 0600).
   A dashboard "Dry runs" tab lets you mark each run correct or wrong with a reason. That gives the done-when count and feeds
   the inbox when a field was missing.
5. **The salary field always comes from the posting's tier ask, never from the bank.** It stays in review, and the filler stops
   ("needs input") on any question not covered by an approved answer, on a CAPTCHA, on a login wall or on an unexpected field type.
6. **No LLM drafting by default.** If you want drafted answers for unknown questions (PLAN 6 "Needs input"), that is a separate
   decision with its own cost line. Drafts must never be approved automatically.
7. **Run Playwright in a worktree-safe way.** Agents use only fake demo postings served from fixtures (recorded HTML of a
   Greenhouse/Lever form). Agents never point the filler at a real employer form. Your 20-30 real dry runs are owner-run
   commands.

## Fix round

Planned in t_2c956655 (`docs/phase-4-fixround-backlog.md`) from your decisions on this report. All four fix cards are merged.
Re-audit #11 (t_7811202c) **passed** on `af8f72e`: no blocker, no major, three minors (M1-M3).

**Where the reports are:**
- Re-audit #11: `docs/audits/phase-11.md`. The automation saved it under `phase-` because its title contains "Phase".
- `docs/audits/batch-11.md` is a different report: batch audit #11 (t_36412184), started automatically during the round. It
  covered `audit-10..a392311`, after F1 and F4 merged and before F2 and F3 merged.

### Cards and what each changed

| Card | Dev / QA / audit | Risk | Commit | What changed |
|---|---|---|---|---|
| F1 | t_af1e9656 / t_f9416d19 / t_1f11c7d9 | high | `15837e4` | R1:<br>- the JobSpy worker spawn is injectable (`spawnFn` through `jobspy/index.ts` and `registry.ts`);<br>- `worker.ts:55` refuses the default spawn whenever `VITEST` is set, before it checks the venv, with no off switch;<br>- every test that reaches the adapters injects a fake worker;<br>- `docs/running.md` says so |
| F2 | t_e8dd3801 / t_fdd8278c / t_cb0b85be | high | `f006da7` | A2:<br>- one salary detector, `packages/apply/src/salary.ts` (`isSalaryWording`), used by matching, the answer index and the inbox;<br>- English and Indonesian pay words, plus "how much ... expect/want/make";<br>- 89 golden cases;<br>- a salary wording of any answer, approved or not, never enters the answer index;<br>- `match-questions` reclassifies stored rows (open inbox rows that are pay questions are removed);<br>- the Inbox tab offers no answer or link form for them |
| F3 | t_aaa0bf00 / t_71b92c4c / t_71cebab7 | high | `af8f72e` | A3:<br>- any real change to answer, question, alternatives, type or choices clears approval, even when the same request says `approved: true`;<br>- linking an inbox wording goes through the same path;<br>- `PATCH /api/answers/:key` re-matches, so stored coverage never outlives a cleared approval;<br>- the Answers tab approves as a separate action.<br>A4: the export is written to a 0600 temp file, then renamed (an old 0644 file does not keep its mode); a missing dir is created 0700 |
| F4 | t_22582616 / t_ab8227b6 / - | medium | `d968504` | A1:<br>- `seed-demo` resolves the realpath (dangling symlinks too) before the `data/` check;<br>- it refuses any DB holding a non-`demo-` posting;<br>- `bin/smoke --demo` now seeds before discover.<br>Batch 8 MINOR-3: `fetch-questions` never follows a redirect.<br>Batch 9: the `owner:` guard in `registry.ts` stays, now with a test |

Also in the round: your commit `f6b0146` (`.prettierignore` gets `workers/jobspy/.venv/`, `config/answers.example.yaml` gets the
optional fields).

### Status of every item (from re-audit #11)

| Item | Status | Proof |
|---|---|---|
| R1 tests start the real JobSpy worker | **closed** | Guard at `worker.ts:55`. Tests in `jobspy/index.test.ts` and `cli.test.ts`.<br>Break (a), guard removed: 3 tests fail |
| A1 seed-demo path check | **closed** | `seed-demo.ts:31` realpath; `seed-demo.ts:114` non-demo check.<br>Live: on a smoke DB holding public postings, `bin/smoke run <dir> seed-demo` exits 1 with `refusing to write, the database holds 1634 non-demo posting(s)`.<br>Break (d): 2 tests fail |
| A2 salary wordings | **closed for every wording you listed; partly closed overall** | All four missed wordings from this report are now caught. The detector is still a word list, so the auditor found new misses (M2 below).<br>Break (b), one alternative removed: a golden test fails |
| A3 edits keep approval | **closed** | `answers-store.ts:174`; `inbox.ts:177`.<br>Break (c): 8 tests fail |
| A4 export mode | **closed** | `answers-store.ts:220-227`.<br>Break (e): the 0600 test fails |
| A5 ledger and tags | **open** | See "Still open" |
| Batch 8 MINOR-3 redirects | **closed** | `questions/index.ts:65` `followRedirects: false`.<br>Test "never follows a redirect (to another host / the same host)" |
| Batch 9 `registry.ts:15` | **closed** | `registry.ts:19` keeps the guard with a comment.<br>`registry.test.ts` "never overwrites an owner:<date> source even when its policy is unknown" |

Live run by the auditor (`bin/smoke --demo`, no `--with-jobspy`):
```
seed-demo 2026-10-16: added 8 postings, 3 questions
processed 1631, kept 42, rejected 1589 (...)
answers import: 16 added, 0 updated, 0 unchanged, 0 kept
match-questions: 3 questions, 2 covered, 0 salary, 1 unknown (1 wordings), 0 changed
self-check /api/health 200
self-check /api/queue 200 items=49
```

### Test totals

| Point | Where | Files | Tests |
|---|---|---|---|
| Phase-end audit #4, `33b53d0` | auditor, clean checkout | 116 | 2160 |
| Batch audit #11, `a392311` (F1 + F4 merged) | auditor, clean checkout | 116 | 2172 |
| Re-audit #11, `af8f72e` (all fix cards merged) | auditor, clean checkout, full `pnpm check` exit 0 | 117 | 2286 |

The fix round adds 126 tests. I did not run tests in this report run. The numbers are the auditors' runs.

### Will `pnpm check` pass in your main checkout now?

**Expected: yes.** Nobody has run it there since the fix, so this is not proven yet. Both causes of the earlier failure are fixed:
- **Prettier:** `.prettierignore:9` lists `workers/jobspy/.venv/`, so the 4 venv files are no longer checked. ESLint already passed.
- **The timeout:** under vitest the default spawn is refused before the venv check, so `cli.test.ts` "discover" can no longer
  start your real worker. The auditor proved it by breaking the guard. With a fake venv present, 3 tests failed.
- The only test that looks at your venv is `smoke.test.ts` "--with-jobspy adds one forced linkedin ...". It runs `bin/smoke` against
  a fake CLI that only logs its arguments. With your executable venv it takes the "venv present" branch and still makes no request.
  The auditor's fake venv was not executable and made this test fail; that was an artifact of the fake.
- `scripts/test-python.sh` runs the worker unit tests with JobSpy mocked, using the system `python3`.

Caveat:
- The auditor could not create an executable fake `python`: `chmod` needs approval in unattended runs.
- So the "marker file never written" proof is weak on its own.
- The strong proof is break (a).
- Your first `pnpm check` in the main checkout is the real confirmation. If anything there looks like a JobSpy run (a long pause in
  `cli.test.ts`, or a `jobspy` log line), stop it and tell me.

### Still open

1. **A5 ledger and tags: open, and worse than before.** The automation caused this; no agent did.
   - **My planning edits never reached `main`.** These were the A5 ledger reset and the decisions.md entries ("Audit tags", "Phase
     4 fix round", F4 medium risk) from t_2c956655.
   - **Cause:** `bin/agent-step:25-28` (`main_ready`) runs `git stash` on modified tracked files before it commits PM docs. So a
     PM run can only add new files. Its edits to existing files go to the stash.
   - **`git stash list` in the main checkout has 4 of these entries:**
     - `stash@{0}` t_2c956655: `docs/audit-ledger.md`, `docs/decisions.md`;
     - `stash@{1}` t_a8e6e464: `docs/phase-3-report.md`, so the Phase 3 fix round section was lost the same way;
     - `stash@{2}` t_c15a704d: `docs/phase-3-fixround-backlog.md`;
     - `stash@{3}` t_f48dace6: `docs/audit-ledger.md`.
   - **Ledger:** `docs/audit-ledger.md` still says `Last audit tag: (none yet)` and has the broken `||` lines. It still holds every
     old row, plus t_22582616.
   - **Duplicate batch audit:** the stale counts (`medium 6 / 5`) are probably why batch audit #11 (t_36412184) started during
     the round.
   - **Tag moved:** `audit-11` was moved by `bin/agent-step:160` (`git tag -f`). It was on `365a7e8` (batch audit #11) and now
     points at `ccdb5ee` (re-audit #11 report). The batch-11 point no longer has a tag. That is the move the round was meant to
     prevent.
2. **M2, A2 residual (minor):** the salary detector is a word list. Re-audit #11 found these pay questions not caught:
   - "What is your asking number?"
   - "What is your minimum acceptable offer?"
   - "What are your financial requirements?"
   - "What is your price?"
   - "Current OTC"

   This matters only if such a wording becomes a bank answer's wording; without one it lands in your inbox. The fix is optional:
   one more high-risk card that adds these wordings with golden cases. It should land before Phase 5 fills forms.
3. **M3 (minor, noted only):** the R1 guard keys on `VITEST`; vitest is the only test runner.
4. **Batch audit #11 minors, from before F2 and F3:**
   - Its approval and salary findings are closed by F3 and F2.
   - **Still open:**
     - typed-answer validation (yes_no must be yes/no, a number must be numeric, a choice must be in `choices`) runs only in the
       inbox path (`inbox.ts:130`). `POST /api/answers` and `PATCH /api/answers/:key` can store and approve an answer like `banana`
       for a yes_no question. Fix before Phase 5 fills forms (small high-risk card).
     - the inbox answer/link steps are not one transaction. It heals itself on the next re-match and is documented in
       decisions.md (2026-10-16 inbox entry).
5. **Batch 8 MINOR-1** (5 s timeouts in `e2e`/`smoke` tests under load): not seen in any fix-round run. It stays open as hardening.
6. **`config/README.md` proposal** (`data/handoff/t_c5832945-comment.md`): not applied yet.

### What you still have to do before Phase 5

1. **Real approved answers** in `config/answers.yaml`, then `pnpm job-agent answers import`. Cover the PLAN 9 list: notice period,
   work authorization, relocation, time zone, years per skill, degree, how you heard.
   - An answer you edit in the dashboard needs a fresh approval (F3).
   - Salary is never answered from the bank (F2).
2. **One real review day** and the `review-stats` line (see "Done-when status"). This is still the only open done-when proof.
3. **Run `pnpm check` once in your main checkout** to confirm the expectation above.
4. **`bin/agent-step`:** only you can change this file.
   - **Tags:** drop `-f` from `git tag -f` at line 160, so an audit tag can never move again. Also tag only on PASS (today a FAIL is
     tagged too). Better still, take the number from the next free `audit-<n>`, not from the card title. The title approach gave
     #11 twice this round, and phase reports land under `phase-<n>.md`. This recommendation was meant for decisions.md
     ("Audit tags"), but that entry was lost in the stash (above). It is recorded only here until it is re-applied.
   - **PM commits (`main_ready`, lines 25-28):** let a PM or researcher run commit its own changes to tracked files under `docs/`
     before it stashes the rest. Without that, report updates like this one are lost too.
5. **A5 cleanup:**
   - re-apply or redo the ledger reset: `Last audited commit: af8f72e`, every row covered by audits 1-11 removed (t_22582616
     included), counts `medium 0 / 5 - low 0 / 10`;
   - restore the decisions.md entries from `stash@{0}` (`git stash show -p 'stash@{0}'`), with the tag facts updated: `audit-11`
     is now on `ccdb5ee`, and the next free number is 12;
   - decide whether to re-tag `365a7e8` (for example `audit-11-batch`) or leave it untagged;
   - look at the other stashes (`stash@{1}` holds the lost Phase 3 fix round report section) and drop the ones you do not want.

   Tell me if you want a PM card for the docs part; I cannot fix the automation.
6. **Optional before Phase 5:** fix cards for M2 (more salary wordings) and the shared typed-answer validation (item 4 under
   "Still open"). I recommend both, as high-risk cards, before any filler uses the bank.
