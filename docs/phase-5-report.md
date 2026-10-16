# Phase 5 report: Assisted applying (dry-run)

Date: 2026-10-17. Author: PM (card t_552a5d42). Status: ready for owner review (t_7a87ffba).

**Summary.** All 17 Phase 5 cards (13 dev cards, 2 research cards, the decisions card and C1) are merged on `main`. You now have:
- `pnpm job-agent dry-run <posting-id>`: it opens a Greenhouse, Lever or Ashby application form in a Chromium window, fills
  what your approved answers cover, takes a screenshot and records the run. It **never submits**.
- choice mapping in the Inbox: you see the form's options and pick the matching ones once;
- a "Dry runs" tab in the dashboard, where you mark each run Correct or Wrong (with a reason), plus the done-when line;
- per-job failure counting for LinkedIn descriptions (L1), so one failing job no longer stops the details run;
- one typed-answer validation used on every answer-bank write path (P1), and the missing salary wordings (P2);
- `bin/agent-step` now commits PM and researcher doc edits instead of stashing them, and never moves an audit tag (A5).

No Phase 5 path calls an LLM, submits a form, logs in or contacts anyone.

The phase-end audit (t_2a8ba526, report `docs/audits/phase-14.md`, tag `audit-14`) **passed**: no blocker, no major, 5 minor
findings. On a clean checkout of `593656d`, `pnpm check` passed: **151 test files, 2796 tests**.

Before you approve, read these three items:
1. **Your real dry runs may all stop with `captcha`.** Real Greenhouse pages load an invisible reCAPTCHA Enterprise script,
   real Lever pages carry an hCaptcha widget, and real Ashby pages load reCAPTCHA. The harness stops on any CAPTCHA script or
   widget, before anything is filled. If that happens on every run, the done-when (20 correct, 10 full fills) cannot be
   reached. This is your decision (open since D2). See "Decision needed from you".
2. **The done-when is not met yet.** Only you can run the real dry runs (0 so far). See "Done-when status".
3. **R1 found that fully automatic submitting is not reachable on any of the five ATSs** without passing a CAPTCHA, which is
   forbidden. This changes what Phase 6 should be. See "R1 findings" and "Recommendations for Phase 6".

## What shipped

Merge commits are on `main` between `audit-12` (`30c1dcd`) and `audit-14` (`5162ebd`). Full per-card plan:
`docs/phase-5-backlog.md`. Decisions: `docs/decisions.md`, entries dated 2026-10-17.

| # | Card (dev / QA / audit) | Risk | Commit | What it does |
|---|---|---|---|---|
| L1 | t_70b5308f / t_b1ce9af8 / t_eb71ae30 | **high** | `2b0db3a` | LinkedIn descriptions: failures are counted per job. One job failing (a 429 included) never starts the 6 h details backoff; only blocks from 2 different jobs do. A job that fails on 2 runs while others succeed is given up (stays `description_missing` in Needs a look). Migration 0007 (adds columns) |
| A5 | t_38874a17 / t_c24266c4 / t_c21b1585 | **high** | `f56b225` | `bin/agent-step`: PM / researcher doc edits are committed, not stashed. Audit tags are set only on PASS and never moved. The next free number is used when the title's number is taken |
| P1 | t_dcde0fbd / t_d0180ffe / t_efd0523a | **high** | `2f9cec0` | Answer bank: one typed-answer validation on every write path (import, POST / PATCH answers, Inbox) |
| P2 | t_c5f69e5a / t_a65bc420 / t_b385be63 | **high** | `a7eb115` | Salary detector catches the re-audit #11 M2 wordings (asking number, minimum acceptable offer, ...) |
| C1 | t_ab72b1a1 / t_af00a4db | low | `23915ba` | Re-audit #12 minors: dead two-letter `DOMAIN_TLDS` entries removed; a text answer is shown once in the detail panel |
| DC | t_a9f809f5 / t_38a0384f | low | `365d0e2` | The Phase 5 plan decisions recorded in `docs/decisions.md` |
| R1 | t_ec2ae4c6 (research) | low | `78b7911` | Terms and bot checks of Greenhouse, Lever, Ashby, Workable, Recruitee: `docs/research/t_ec2ae4c6-ats-submission-terms.md` |
| R2 | t_d0698332 (research) | low | `39296fd` | Form structure of Greenhouse, Lever, Ashby, for the fillers and fixtures: `docs/research/t_d0698332-ats-form-structure.md` |
| D1 | t_918664ed / t_275d5920 | medium | `c22a352` | Migration 0008: tables `dry_runs`, `dry_run_fields`, `choice_mappings`, plus a small store module |
| D2 | t_e4ef741b / t_c04cc9cb / t_b316552e | **high** | `13866af` | Playwright harness that cannot submit:<br>- every non-GET / HEAD request is aborted (only exception: Ashby's read-only GraphQL allowlist);<br>- WebSockets, beacons and service workers are blocked;<br>- `submit` / `requestSubmit` are cancelled;<br>- no click on a submit control;<br>- fixture mode aborts every host other than `127.0.0.1`.<br>One test proves zero POSTs reach the server; a twin test without the guard proves that test can fail |
| D4 | t_84aa4b70 / t_925ffae1 | medium | `4608832` | Choice mapping: the Inbox shows a choice question's options; you map them to an approved answer once. A new option set needs a new mapping. Salary questions never get one |
| D6 | t_4fbf1521 / t_c203b466 | medium | `dd56b3c` | Dashboard "Dry runs" tab: list, screenshot, filled fields with their source, Correct / Wrong with a reason, the done-when line (also in Stats and `review-stats`) |
| D3 | t_f083066c / t_f4f2dacb / t_fabe0c14 | **high** | `cbf639a` | Fill plan in plain code: form fields + approved answers + choice mappings + tier ask -> a value per field, `needs_input`, or a stop reason |
| D5 | t_5ffb85b7 / t_68a1ad3b / t_3361aa6e | **high** | `66dd5de` | Greenhouse filler and the `dry-run <posting-id>` / `dry-run --fixture greenhouse` command |
| D7 | t_9e9cfe1e / t_f801b8c9 / t_8c49fd0f | **high** | `566ffef` | Lever filler: reads the questions from the apply page it opened, stores and matches them, then fills |
| D8 | t_3b60e4e8 / t_43f8d421 / t_d0d1123d | **high** | `d8706e5` | Ashby filler: waits for the GraphQL-drawn form, reads the fields from the page, fills. Draft writes (`ApiSetFormValue`), uploads and "Autofill from resume" are aborted |
| D9 | t_772e5705 / t_8fcf3732 | medium | `de6bdcc` | `e2e.phase5` test (three fixture runs, a CAPTCHA stop, a mapped choice, an uncovered question, reviews); `bin/smoke --demo` ends with the three fixture dry runs; `docs/running.md` "Dry runs" section |

Your gate answers (t_2c20b3fa) were built as given. The one change from the PM's proposal is answer 4, the stop rule. A dry run
now fills every covered field, leaves uncovered fields empty and marks them `needs_input`, and still takes the screenshot. A full
stop happens only on: a CAPTCHA, a login wall, an unexpected page, an unexpected field type, an ambiguous match or a scam flag. The
strict rule (every question covered) becomes the rule for submitting in Phase 6.

**Out of scope, as you decided:** the semi-automated JobStreet / YC filler, and the second half of the PLAN 8 done-when
("semi-automated fills correct on 10+ real forms").

## How to run a real dry run

Full instructions: `docs/running.md`, sections "Dry-run harness browser", "Greenhouse / Lever / Ashby dry run" and "Dry runs".
In short:

1. **Back up** `data/job-agent.db` if you did not do it before L1 (migration 0007) and D1 (migration 0008) merged. Both
   migrations only add tables and columns.
2. **Install the browser once:** `pnpm playwright:install`.
3. **Check the flow on fixtures:** `bin/smoke --demo`. It ends with three lines
   `dry-run: status=filled reason=- fields=13/13 screenshot=...` (Greenhouse, Lever, Ashby: synthetic forms on 127.0.0.1).
4. **Prepare answers:** approve your answers in the Answers tab, including `profile.resume_file`, the local path to your CV as a PDF
   under 10 MB. Then map choice questions in the Inbox.
5. **Pick a posting** with a Greenhouse, Lever or Ashby job link that is not scam-flagged. For Greenhouse, run `pnpm job-agent
   fetch-questions` first.
6. **Run:** `pnpm job-agent dry-run <posting-id>`. It opens one visible window; add `--headless` for no window. It prints one line
   (`status`, `reason`, `fields=<filled>/<total>`, the screenshot path) and never a value. The window closes after the screenshot.
7. **Review** the run in the dashboard's Dry runs tab: Correct, or Wrong with a reason. The table "What each result means" in
   `docs/running.md` says what to do for each status.

Screenshots and filled values are personal data. They stay under `data/dryruns/` (folders 0700, files 0600); never commit or share them.

## Test status

From the phase-end audit (t_2a8ba526), on a fresh checkout of `593656d`:

- `pnpm install --frozen-lockfile`: ok. `pnpm playwright:install`: ok.
- `pnpm check`: exit 0, **Test Files 151 passed (151), Tests 2796 passed (2796)**. At the previous audit: 137 / 2612. It covers
  typecheck, lint, the web build, the pre-commit hook test, `bin/test-hold.sh`, `bin/test-agent-step.sh` (27 passed) and the
  Python tests.
- `bin/smoke --demo`: three fixture dry runs `status=filled ... fields=13/13`; smoke `dryruns/` dirs `700`, screenshot `600`.
- `bin/smoke dash <dir> --self-check`: `/api/health 200`, `/api/queue 200 items=63`, `/api/dry-runs 200 runs=5`.

**Break checks** (each change was reverted after the check):

| Check | Result |
|---|---|
| Route guard lets every method through | caught: 43 tests failed |
| A filler presses Enter after filling | caught: 18 tests failed |
| Fixture host check disabled | caught: 2 tests failed |
| L1 backoff forced on | caught: 9 tests failed |
| Ashby allowlist widened by `ApiSetFormValue` | **not caught**: MINOR 1 below. Still harmless: the body check blocks it |

**Audit tags (A5 live test).** The phase-end audit's card said "#13", but `audit-13` already existed. The automation set
**`audit-14`** on `5162ebd` and left `audit-1..13` unchanged. I checked this on 2026-10-17 (`git for-each-ref refs/tags/`):
`audit-1 f5ea894`, `audit-12 30c1dcd` and `audit-13 32274ac` are the values the auditor recorded before the run, and so are all
the others. A5 works.

## Phase-end audit findings

Report: `docs/audits/phase-14.md`. The audit checked eight things; all eight held:
- no submit, anywhere;
- agents use fixtures only;
- the stop rule;
- dry-run output stays private;
- the LinkedIn L1 rule;
- A5;
- the done-when computation;
- no drift from PLAN, `decisions.md` or the backlog decisions.

The only wording drift is the stop rule, which follows your answer 4.

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | No test pins the contents of the Ashby read-only allowlist (`request-guard.ts:14`). Widening it passes every test; the `mutation` / `submit` body check is then the only barrier | MINOR | **open**: fix card recommended (low, dev) |
| 2 | Outside fixture mode, a page script can GET any host, so a typed value could leave in a query string (`request-guard.ts:105`). Carried over from audit 13 MINOR 1; no decision has been recorded yet | MINOR | **open**: needs your decision (see below) |
| 3 | `docs/audit-ledger.md` is never cleared by automation. It still holds every row since Phase 1, and the batch threshold keeps firing. AGENTS.md also does not say that `bin/agent-step` stashes and commits docs in main for you. Carried over from audit 13 MINOR 2 and 3 | MINOR, process | **open**: fix card recommended (low, PM / dev) |
| 4 | `takeBackBlocks` (`fetch-descriptions.ts`) gives an attempt back also to postings with an old, stale 429 mark. A poison job can then be given up one run later | MINOR | open, no harm; fold into a later LinkedIn card |
| 5 | `commit_docs` (`bin/step-git.sh`) commits everything under `docs/` in main, your own edits included. Only the pre-commit hook guards personal data | MINOR | open; covered by the AGENTS.md line in fix 3 |

The L1 audit (t_eb71ae30) adds one more minor point. A given-up poison job keeps its `description_blocked_at` mark. For up to 6 h,
that mark plus one 429 from another job can start the backoff. No harm.

No fix cards have been created yet. The audit report lists three; I recommend creating them before Phase 6 (see below). None of
them blocks your dry runs.

## Done-when status

PLAN 8, as you narrowed it at the gate: **20-30 owner-run dry runs reviewed and correct**. The exact rule (Decision 9): at least
20 runs marked correct, and at least 10 of those are full fills (status `filled`, no `needs_input` field). Fixture runs never count.

Today's line on the demo DB: `dry runs: 0 correct of 0 reviewed (0 full fills); done when 20 correct, at least 10 full fills:
not met`.

**Not met. This is your job.** The code that computes the line is tested and audited (only `fixture = false` rows count). The
condition itself can only be met by your own real dry runs. See item 1 under "Decision needed from you" first: if the CAPTCHA stop
stays as it is, most or all real runs will stop with `captcha`.

## Decision needed from you

1. **Should a passive CAPTCHA script alone stop a dry run?** (open since D2; `docs/decisions.md` D2 note 3, D5 note 5, D7
   note 4)
   - Today the harness stops on any CAPTCHA script, iframe or widget, even when no challenge is shown.
   - Per R1 and R2, every real Greenhouse, Lever and Ashby form loads one, so real runs will likely all stop with `captcha` and
     fill nothing.
   - Options:
     - **(a) Keep it.** Safest, but the Phase 5 done-when is then unreachable.
     - **(b) Stop only on a visible challenge** (a challenge iframe or a visible widget asking you to act), and fill when only the
       invisible script or badge is present.

   PM recommendation: **(b), for dry runs only.** Nothing submits in Phase 5, so an invisible script that never gets a token or
   a submit is never passed or bypassed. The stop on a visible challenge, and "never click through a challenge", stay as they are.
   If you agree, I plan one high-risk card (detector change + fixture tests: script-only fills, visible challenge stops). Try 2-3
   real runs first, to see whether they really all stop.
2. **Live-mode GET policy** (finding 2):
   - **(a)** Record that real dry runs may GET any host. The risk is low: the runs are headed, one at a time, on three ATS hosts.
   - **(b)** Add a per-ATS host allowlist with a test.

   PM recommendation: (b) before Phase 6 adds any submit path, and (a) is fine for Phase 5 dry runs.

## R1 findings (input for Phase 6)

From `docs/research/t_ec2ae4c6-ats-submission-terms.md` (checked 2026-10-17; not legal advice):

- **Terms.** None of the ATS terms read (Greenhouse MSA, Lever ToS, Ashby customer ToS, Workable terms) says anything about a
  candidate, or a tool acting for one, filling or submitting the public apply form. These terms bind the employer, not
  candidates. The closest clauses ban getting around protective measures and overloading the service. Recruitee's own ToS could
  not be read (the page returned 404).
- **Bot checks on every hosted form:**
  - Greenhouse: invisible reCAPTCHA Enterprise, sometimes an e-mailed code, sensitivity set per employer;
  - Lever: hCaptcha at submit;
  - Ashby: reCAPTCHA plus a server-side score, so a low score can reject an application silently after submit;
  - Workable: Cloudflare Turnstile key on the page;
  - Recruitee: invisible captcha, on by default.
- **Submit APIs are employer-side.** They need the employer's key, so we cannot use them. Recruitee's public candidate endpoint
  skips its captcha. Using it would be exactly the circumvention we must not do, so R1 treats it as forbidden.
- **Conclusion:** no ATS is explicitly allowed or forbidden, but auto-submit is not reachable without passing a CAPTCHA (forbidden
  by AGENTS.md and PLAN 6). R1 recommends **semi-automated for all five: the tool prefills, you click submit**. A silent bot score
  (Ashby, Greenhouse) is one more reason for a human to submit from a real session.
- **Open questions for you in R1:**
  1. Are you comfortable that a tool prefills and you submit, given that the terms are silent on candidates? (OWNER)
  2. Confirm we never use Recruitee's public candidate endpoint (recommended: never). (OWNER)
  3. Fraud checks on prefilled but human-submitted applications are unknown; test only after Phase 6 approval.
  4. Read Recruitee's current ToS from a real careers page footer.

## LinkedIn status after L1

L1 merged on 2026-10-17 (`2b0db3a`, audit PASS). One job that keeps failing can no longer start the details backoff, and it is
given up after 2 failed runs while other jobs succeed.

**Whether LinkedIn detail pages still stay blocked is not known yet.** Agents never send a request to LinkedIn, so only your
hourly runs can show it. Watch Source health in the dashboard / digest, where the descriptions line reads `details N (K failed)`,
for about a day of hourly runs.

- **If** descriptions arrive for most pending LinkedIn postings, **L2 is not needed**.
- **If** the details step keeps going into backoff (`blocked:` rows from different jobs), or almost every LinkedIn posting stays
  `description_missing`, tell me on the owner review card. I then create **L2** "Descriptions from the company's ATS posting found
  by resolve-apply" (dev, high; draft in `data/handoff/p5/L2-draft.md`, summary in `docs/phase-5-backlog.md`). It takes the text
  from the employer's public Greenhouse / Lever / Ashby / Workable / Recruitee posting, with no LinkedIn request.

## Known limitations

- **The CAPTCHA stop** may stop every real run (above).
- **Ashby field ids are unverified on the real site.** R2 could not read a real form without POSTing, so the fixture is built from
  R2's notes. If your first Ashby runs show `form_changed`, or fields marked "page kept a different value", send me the field
  labels (never values).
- **Ashby draft writes are blocked.** `ApiSetFormValue` is aborted, so a real Ashby page may drop a typed value or show an error
  toast. The field is then recorded as not filled, never as a wrong value.
- **Lever "Current location"** is an autocomplete that clears a typed value, so it is always `needs_input`. Pick the suggestion
  yourself.
- **Lever resume parsing** (`POST /parseResume`) is aborted. The file still attaches locally.
- **Fields the fillers never touch:** EEO / self-identification blocks, the phone country, pronouns, marketing and texting
  consent.
- **Workable and Recruitee have no filler.** Their questions are fetched (Phase 4), but `dry-run` refuses those links.
- **No review history.** Changing a review in the Dry runs tab overwrites it.
- **Ledger noise.** Until fix 3, the ledger keeps firing the batch threshold, and the automation may create duplicate batch-audit
  cards.

## Recommendations for Phase 6

PLAN 8 Phase 6 is "Auto-apply + learning: submitting for fully covered forms, outcome tracking, tiers recalculated from data".

1. **Before Phase 6:**
   - Settle the CAPTCHA decision and finish your 20-30 dry runs; Phase 6 should not start before the Phase 5 done-when is met.
   - Create the three audit fix cards:
     - pin the Ashby allowlist (low);
     - the live-mode GET policy (high if (b));
     - reset the ledger, make automation clear it on a PASS, and add the AGENTS.md line (low).
2. **Reshape the applying tier, based on R1.** PLAN 6's "Auto-apply" tier (Playwright fills **and submits**) is not reachable:
   every form has a bot check.
   - I recommend that Phase 6 plan a **prefill-and-hand-over** mode instead: the filler fills a fully covered form in a headed
     window, leaves the window open, and **you** click submit.
   - The strict rule (every question covered by an approved answer or mapping, no CAPTCHA challenge) decides which forms get
     there.
   - This changes PLAN 6 / 8 / 10 (guardrail "the agent never clicks submit" extended to every ATS), so it needs your decision
     and a `decisions.md` entry at the Phase 6 gate.
   - The submit guard from D2 stays on for every agent and test path.
3. **Answer the R1 owner questions 1 and 2** at the Phase 6 gate (comfort with prefill + human submit; never use Recruitee's
   public endpoint).
4. **Outcome tracking first.** The "learning" half of Phase 6 (applications, responses, interviews, offers -> tiers recalculated
   from data) needs no automation risk. It can start in parallel with the applying work and gives the done-when ("tiers based on
   real postings and outcomes") its data.
5. **Correct the selectors from your recordings.** Use your first real runs (labels only) to fix the Ashby and Lever selectors,
   one small card per ATS, before any hand-over mode is built on them.
6. **Workable / Recruitee fillers** only if your digest shows enough fully covered postings on those ATSs. Recruitee only through
   the hosted form, never the public endpoint.
7. **Open LinkedIn items:**
   - L2 if needed (above);
   - audit MINOR 4 and the L1 audit note (clear `description_blocked_at` when a posting is given up) as one low card.
