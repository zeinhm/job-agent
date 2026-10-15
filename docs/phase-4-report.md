# Phase 4 report: Review workflow

Date: 2026-10-16. Author: PM (card t_4b0651e2). Status: ready for owner review (t_acf2f9cd).

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
3. **Two answer-bank findings matter before Phase 5:**
   - Some salary wordings are not recognized as salary questions, so you could approve a bank answer for them (finding A2).
   - Editing the wording of an approved answer keeps it approved (finding A3).

   Neither matters while nothing is filled or submitted.

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
| Batch 8 MINOR-3 | `questions/index.ts:63` follows redirects through the shared `httpGet` with no host pinning | open (public JSON GET, low impact) |
| Batch 9 (t_a7215a83) | `registry.ts:15`: the `owner:` entry in `PROTECTED_SOURCE` cannot be reached and no test covers it | open, harmless |
| Batch 9 | no `typecheck` script | not a real gap (see Test status) |

### New finding from this report (PM)

| # | Finding | Severity |
|---|---|---|
| R1 | The test suite starts the real JobSpy worker on a machine where the worker is installed. Path: `cli.test.ts:68` -> `discover --force` -> `jobspy/worker.ts:46`. This breaks the rule that tests never hit live HTTP, and it can send logged-out LinkedIn/Indeed requests from your IP every time `pnpm check` runs in the main checkout. Fix: tests must inject a fake worker path, or the CLI test must exclude JobSpy sources. Add `workers/jobspy/.venv/` to `.prettierignore` | **major** (guardrail; not caught by any audit because review worktrees have no venv) |

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
3. **Fix round for A1-A4** (fix tasks are always high risk). A2 and A3 at least must land before Phase 5 fills any form.
4. **Apply `config/answers.example.yaml` and `config/README.md`** from the dev reports listed under "How to run it", or tell
   me to drop them.
5. **Audit housekeeping (A5):** set the ledger's last tag, clear the covered rows, and decide whether the Phase 4 tag is `audit-4`
   (as now) or `audit-11`.

## Recommendations for Phase 5: Assisted applying (dry-run)

PLAN 8 Phase 5: Greenhouse, Lever and Ashby fillers in dry-run (fill, screenshot, do not submit), and CAPTCHA goes to manual. The
semi-automated JobStreet and YC part is **dropped** (your Phase 3 decisions; `decisions.md` 2026-10-14). The done-when therefore
becomes "20-30 dry runs reviewed and correct" only. The Phase 5 plan records this as a decision entry.

1. **Prerequisites from Phase 4:**
   - fix R1 and A1-A4 first;
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
