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

## Fix round

Date: 2026-10-17. Author: PM (card t_8e8e6e9c). Plan: `docs/phase-5-fixround-backlog.md` (card t_e3f354ae, your decisions
1-6). Re-audit #15 (t_bb5c6dc8, report `docs/audits/phase-15.md`, tag `audit-15` on `6e8bb9d`) **passed**: no blocker, no
major, 3 minor findings. Next card: t_4532cd2c "Phase 5: owner review after the fix round" (yours). The first owner review,
t_7a87ffba, stays open until the done-when is met.

**Summary.** All seven fix-round cards are merged:
- a passive CAPTCHA no longer stops a real dry run;
- Greenhouse links on a company career page (`?gh_jid=`) now work;
- the Ashby phone field is filled;
- LinkedIn postings get their description from the company's ATS posting, with no LinkedIn request.

This section settles "Decision needed from you" and "LinkedIn status after L1" above, and updates "Known limitations" and
"Recommendations for Phase 6".

### What shipped

Range `audit-14..audit-15`. Each commit is a squash merge on `main`.

| Key | Your item | Card (dev / QA / audit) | Risk | Commit | What it does |
|---|---|---|---|---|---|
| C1 | 1 | t_cbcbc227 / t_ab88eed4 / t_5753a0fe | **high** | `efb964d` | Dry-run CAPTCHA rule (b): a passive script, badge or invisible widget does not stop a run; a visible challenge stops it before filling, and also when it appears during the run (checked after every fill and before the screenshot). The old rule stays as `strict` mode for Phase 6 |
| G1 | 2 | t_5b6fb1d5 / t_a3e87bce / t_099cbcff | **high** | `069456e` | Greenhouse career-page links: the job id is read from `?gh_jid=`, the resolved apply link is used, and the board is found (stored slug, then the company's board, then at most 5 `boards-api` lookups that must return that exact job id). A guessed board is never used. A verified board is stored |
| A1 | 3 | t_a31b041a / t_8821df67 / t_f8a5834f | **high** | `b058bdb` | Ashby phone: the `tel` input next to the country selector is filled from `profile.phone`; the country selector and texting-consent radios are untouched. A field the run does not understand now stops with its label plus field type and DOM shape (never a value) |
| L2a | 4 | t_bee8ac6e / t_94ad2f08 / t_4871d88a | **high** | `49a8238` | Explains and fixes "from the ATS board 0" (below); clears stale 429 marks (audit #14 MINOR 4 and the L1 note) |
| L2b | 4 | t_3b2d9ff0 / t_e8e1daf6 / t_5bd9eeaa | **high** | `6e8bb9d` | LinkedIn description from the company's public Greenhouse / Lever / Ashby / Workable / Recruitee posting named by the apply link. Such a posting is never sent to LinkedIn |
| H1 | 6 | t_9e75a5d6 / t_3314a12a | low | `cfb4a4c` | A test pins the exact Ashby read-only allowlist (audit #14 MINOR 1) |
| H2 | 6 | t_bfe5e86b / t_5fc21c72 | low | `b192747` | The automation clears covered ledger rows on an audit PASS with a tag; AGENTS.md says `bin/agent-step` commits docs in main (audit #14 MINOR 3 and 5) |
| - | 5 | no card | - | `41c22cc` | Live-mode GET policy (a) recorded in `docs/decisions.md`; option (b) is a Phase 6 prerequisite |

**Why "from the ATS board 0" on every run (L2a).** The free route only looked at LinkedIn postings that were not duplicates.
But `process` had already merged every LinkedIn posting with the same company and title as a board posting before this step
ran. So every match the rule could find was already gone, and the postings that were left never matched, for three reasons:
- the LinkedIn title had a location tag ("Engineer - US");
- the apply link was on the company's domain, so it never equalled the board posting's URL;
- `apply_links` rows exist only after `resolve-apply`, which runs later in the hourly run.

The title key now cuts trailing location / remote tags, and a board posting also matches by the board job id in the apply link.
The summary line now says why a posting was missed: `from the ATS board N (missed: no board posting a, title differs b, board
text empty c)`. "No board posting" usually means the company is not on your company list.

### How to use it

**OWNER: back up `data/job-agent.db` before your next hourly run** if you have not done so since these merges. No card added a
migration, but three rewrite stored rows:
- G1 stores verified Greenhouse boards (`apply_links.ats_slug`, and `companies` for a company with no board yet);
- L2a clears stale 429 marks;
- L2b writes descriptions.

1. **CAPTCHA on real runs.** A run that goes on past a passive CAPTCHA prints `captcha=passive` on its `dry-run:` line (the
   stored detail lists labels only, e.g. `captcha=passive:script,badge`). Only a visible challenge stops it with `captcha`; the
   screenshot is still taken and 0 / 0 fields are stored. The run never clicks, focuses or solves a challenge. **Never solve
   one yourself inside a dry-run window.** If a visible challenge appears, let the run stop and try another posting.
2. **Greenhouse career-page links.** Run `pnpm job-agent fetch-questions` first (the hourly run does this too). For a
   `...?gh_jid=<id>` link it finds the board, and the dry run then opens `https://job-boards.greenhouse.io/<board>/jobs/<id>`,
   never the career page. If `fetch-questions` printed `greenhouse board not found for gh_jid`, the dry run is refused: add
   the company's Greenhouse board to `companies.yaml`, and the next run picks it up.
3. **Ashby phone field.** Nothing to do; make sure `profile.phone` is approved in the Answers tab. If another Ashby field stops
   with `unexpected_field`, the stop detail looks like `Mobile phone (other, input:tel+input:tel)`. **Send me that label and
   shape (never the value)** on the owner review card.
4. **LinkedIn descriptions.** The hourly `fetch-descriptions` line now reads `... from the ATS board N (missed: ...), from the
   ATS link N (failed F), ...`. The ATS-link route sends only GET requests to the ATS's public API, logged out, 2 s apart per
   host, at most 50 postings per run. A closed job or a job missing from the board counts as one failure: the posting is tried
   again after 6 h and given up (`description_unavailable`) after 3 failures. Source health still shows the LinkedIn
   `details N (K failed)` part, which should now be smaller.

### Re-audit #15

Report: `docs/audits/phase-15.md`. All six of your items and audit #14 MINOR 1-5 are **closed**. A1 (Ashby phone) is closed on
fixtures only: the agents cannot see a real Ashby form, so your next real Ashby run is the final proof. A test caught each of the
six break checks:
- passive CAPTCHA stops: 15 tests failed;
- visible challenge ignored: 11 failed;
- unverified Greenhouse board accepted: caught;
- Ashby phone mapping dropped: 12 failed;
- `ApiSetFormValue` allowlisted: 2 failed;
- a stale 429 gets an attempt back: caught.

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Two golden test rows use a real company's career-page URL and job id that came from your examples. A public job URL is not personal data, but it ties the repo to your own targets | MINOR | **open**. Optional low card: swap it for an invented company and id |
| 2 | The ATS-link route counts a network error or 5xx like a closed job. A day-long ATS outage can give up the descriptions of open jobs for good (3 failures, 6 h apart), and they are never sent to LinkedIn | MINOR | **open**. Optional low card: count only 404 / not on the board / other id / empty text |
| 3 | A `?gh_jid=` posting with no known board costs up to 5 paced lookups (2 s each). With 50 postings that is up to ~10 min per run, repeated every 6 h for 3 attempts. GET only, paced and capped: slow but harmless | MINOR | **open**. Optional: remember "board not found" per host for the run |

The auditor requires no fix card. I recommend one low card for findings 1 and 2 together before Phase 6. None of them blocks
your dry runs.

**Ledger.** On this PASS the automation cleared the H1 and H2 rows: `docs/audit-ledger.md` now reads `Last audit tag: audit-15
(6e8bb9d)` with no rows. This is the first live run of H2, and it worked.

### Test status

From re-audit #15, on `6e8bb9d`:
- `pnpm check`: exit 0, **Test Files 156 passed (156), Tests 2964 passed (2964)**. At audit #14: 151 / 2796.
- Shell tests: 34 passed, 0 failed. Python: 25 tests OK.
- `bin/smoke --demo`: three fixture dry runs `status=filled reason=- fields=13/13`. Self-check: `/api/health 200`,
  `/api/queue 200 items=67`, `/api/dry-runs 200 runs=5`.

The demo data has no LinkedIn rows and no `gh_jid` links. So the new description routes and the Greenhouse board lookup were
exercised only by tests on recorded fixtures, not by the smoke run.

### Known limitations (after the fix round)

These replace the CAPTCHA, Ashby-ids, ledger and LinkedIn items of "Known limitations" above. The others still hold: Lever
location autocomplete, aborted uploads and draft writes, untouched EEO / consent fields, no Workable / Recruitee filler, no
review history.
- **CAPTCHA detection is built from fixtures and research.** A real page may show a widget the detector does not know. A
  visible frame of an unknown kind stops the run with `captcha` (fail-safe). If real runs still stop with `captcha` while you
  see no challenge, tell me, and describe what the screenshot shows (do not send the screenshot).
- **Ashby field ids are still unverified on a real form.** The phone fix follows R2 and the code. Expect a few more
  `unexpected_field` / `form_changed` stops on the first real runs.
- **A Greenhouse career page with no verifiable board** is refused until you add the board to `companies.yaml`. It is looked up
  again on every run, because there is no "not found" memory (finding 3).
- **A new LinkedIn posting may still cost one LinkedIn request on its first hourly run.** `resolve-apply` runs after
  `fetch-descriptions`, so on that run only the link JobSpy found is known. If that link is not an ATS job link, the posting
  goes to LinkedIn, within the old limits (3 per run, 45 s apart, last 24 h only).
- **Postings with no ATS job link** (the company's own form, Workday, a link with no job id) still depend on LinkedIn detail
  requests.
- **Transient ATS errors count as failures** (finding 2).

### What you do next

1. **Back up the DB** (above), then let the hourly runs go on.
2. **Run real dry runs toward the done-when:** at least 20 reviewed as correct, at least 10 of those full fills, across
   Greenhouse, Lever and Ashby (`pnpm job-agent dry-run <posting-id>`, then review in the Dry runs tab). `captcha=passive` on
   the line means the new rule is working.
3. **Send me the labels (never values) of any field that still stops a run:** the `unexpected_field` detail (label, type,
   DOM shape) or the labels in a `form_changed` detail. Each one becomes a small filler card.
4. **Watch the LinkedIn descriptions line** for about a day of hourly runs: `from the ATS board N (missed: ...)`, `from the ATS
   link N (failed F)`, and the `details` part in Source health. Tell me on t_4532cd2c whether most LinkedIn postings now get a
   description, and the `missed` counts if `from the ATS board` stays at 0.
5. **Close the reviews** (t_4532cd2c, then t_7a87ffba) once the done-when line in the Dry runs tab says `met`.

### Phase 6 prerequisites still open

Both are recorded in `docs/decisions.md` (2026-10-17) and must be done before Phase 6 adds any submit path:
- **Live-mode GET host allowlist (option (b) of your decision 5):** a per-ATS host allowlist for real (non-fixture) runs,
  pinned by a test. Today a real dry-run page may GET any host (option (a), accepted for owner-run dry runs only).
- **The CAPTCHA rule for any submit path:** the relaxed rule is for dry runs only. A submit path must decide its rule again.
  The code's `strict` mode (any CAPTCHA script, frame or widget stops) is ready and tested.

Also still open from "Recommendations for Phase 6" above:
- the prefill-and-hand-over decision and R1 questions 1 and 2, at the Phase 6 gate;
- selector corrections from your first real runs;
- the done-when itself.

## Fix round 2

Date: 2026-10-17. Author: PM (card t_7ebeda21). Plan: `docs/phase-5-fixround2-backlog.md` (card t_3e3cb038, your items 1-4
from the real dry runs that all stopped at 0 / 0 fields). Re-audit #16 (t_f6cfb948, report `docs/audits/phase-16.md`)
**failed**: no blocker, 1 major, 3 minor. The code of all four cards is correct. The major is a missing test in B1 (the DB
backup), and I found a second B1 problem while writing this report (below). No `audit-16` tag was set. Next card: t_1df7c94a
"Phase 5: owner review after fix round 2" (yours).

### What shipped

Range `audit-15..main`. All four cards were high risk, each audited on its own, then squash-merged.

| Key | Your item | Card (dev / QA / audit) | Commit | What it does |
|---|---|---|---|---|
| B1 | 4 | t_3625211b / t_e954d3fa / t_2d48ed96 | `6c2b34c` | Before QA or the auditor merges, `bin/agent-step` looks for a report line starting with `OWNER: back up data/job-agent.db`. If it finds one, it runs `sqlite3 .backup` and checks the copy with `integrity_check`. It keeps the 5 newest `data/job-agent.db.bak-*`. If the backup fails, nothing is merged and the card is held `[OWNER]` |
| M1 | 1 | t_bd12e1a8 / t_dc0b8789 / t_165f503d | `a6e92d5` | `ambiguous match` now names the keys per label (keys only, never values). The same key reached by several routes still fills; two different keys still stop |
| P2 | 2 | t_73f3d2e8 / t_432edbc9 / t_02369457 | `e7ec3dc` | Ashby phone readback compares digits only. A stored phone row written by the older reader is refreshed, not reported as a changed form |
| G2 | 3 | t_eafe628c / t_9bac4a90 / t_70cf4f09 | `a41523d` | Greenhouse "Location (City)" autocomplete plus its "Search" helper count as the stored Location question. It is never typed into; the run ends `needs_input` |

### Root causes the dev cards found

- **M1: the code was already right; the cause is in your data.** My plan guessed that the same key might be counted twice.
  The dev confirmed the check already collects keys in a set (`fill-plan.ts` ~358), so one key reached by two routes never
  stopped a run. Your stop on all five contact fields therefore means each label is reached by **two different keys**:
  `profile.<field>` (the standard wording) plus another approved answer whose `question` or `alternatives` repeat that
  wording. The dev's test reproduces exactly your five-label stop that way. Without your DB the agents cannot tell which of
  these it is:
  - (a) leftover `answer_bank` rows: the import never deletes rows that are no longer in the YAML;
  - (b) a current answer that repeats a standard wording.

  Nothing in the code was changed on that guess. Instead, the stop detail now names the keys, so your next run tells us.
- **P2: the stop did not come from the phone readback.** A readback mismatch only gives the per-field note `page kept a
  different value`. `form_changed "different: Phone Number"` came from comparing the stored questions with the page.
  - Before fix round 1 (A1), the phone block (country selector + tel + texting radios) was stored as type `other`.
  - After A1, the reader sees only the tel input, as `text`.
  - Same name and label, different type: the run reported "different".

  The fix: Ashby treats a stored `other` row that now reads as a known type with the **same label** as a reader change.
  It refreshes the row and goes on. A changed label, or a changed required flag or options on a known type, still stops.
  The digits-only readback you asked for was added too.
- **G2:** as you described. The reader now recognises the location input and the "Search" helper by their labels and their
  position (the helper must be within 3 parent elements of the location input). The real widget's markup is not known.
  If the real "Search" input sits farther away, the run stops `form_changed` with `extra: Search` (safe, never a wrong
  fill). Send me that detail if it happens.

### How to use it

1. **`ambiguous match`** now looks like `ambiguous match, Email (contact.email, profile.email)` (the detail is cut at 200
   characters, so with five labels you may see only the first three or four). For each label, keep one key:
   - a key that is not in your `config/answers.yaml` is a leftover row: unapprove it in the Answers tab;
   - a key that is in the YAML repeats a standard wording: remove that wording from its `question` / `alternatives`, or
     unapprove it.

   Then run the dry run again. See `docs/running.md` "`ambiguous match`".
2. **Ashby phone.** Nothing to do. On the next Ashby dry run of a posting stored before fix round 1, the phone row is
   refreshed in the DB (this is why the card carried the backup line). The readback accepts a page that reformats the
   number (`+1 555-...`) as long as the digits are equal or the page only added a prefix.
3. **Greenhouse location.** The run fills everything else and ends `needs_input`. The Location row reads `location
   autocomplete: pick the suggestion yourself`. That is expected: in a real application you pick the suggestion. Mark the
   run Correct if the other fields are right.
4. **Automatic DB backup.** When a card's report starts a line with `OWNER: back up data/job-agent.db`, the merge should
   back up the DB first and name the file in the commit body and the card summary (`DB backup: data/job-agent.db.bak-<stamp>`).
   If it cannot (no `sqlite3`, no DB, a bad copy), the card shows `[OWNER]` with the reason and nothing is merged. Restoring
   is manual (`cp` the `.bak-*` file back while no run is active). **But see the warning below: in this round it did not fire.**

**Warning: the P2 merge was not backed up.** P2 carried the backup line in both its dev report and its audit report, and it
merged at 20:46 (after B1 at 20:24). But:
- commit `e7ec3dc` has no `DB backup:` line in its body;
- the audit card summary has no backup note either;
- no `data/job-agent.db.bak-*` file was created after 19:58 (the newest is `bak-202610171958`).

Both report texts match B1's line pattern when checked with `grep -E`. My best guess at the cause, **not reproduced**:
- `bin/agent-step` runs with `set -o pipefail`;
- the helper pipes the dev card text and then the reviewer file into `grep -q`;
- `grep -q` exits on the first match (in the card text), and the later `cat` of the reviewer file gets SIGPIPE;
- under pipefail the pipe then counts as "no line found", and the helper returns "nothing to do".

The tests did not catch it because the helper's tests use short inputs, and the merge wiring is only checked by text greps
(audit finding 1). No data was harmed: P2 rewrites rows only during your next Ashby dry run, not at merge. **Back up
`data/job-agent.db` yourself before your next Ashby dry run.** One way, while no run is active:
`sqlite3 data/job-agent.db ".backup 'data/job-agent.db.bak-manual'"`.

### Re-audit #16

Report: `docs/audits/phase-16.md`. Your items:
- **2 (Ashby phone): closed.**
- **3 (Greenhouse location): closed.**
- **1 (ambiguous match): partly closed.** The stop is now diagnostic, but the cause is in your answer data and needs your re-run.
- **4 (backup before merge): partly closed** (finding 1). After the warning above, I count item 4 as **open**.

Break checks: five of the six were caught by tests:
- (a) same key counted twice: 1 test failed;
- (b) two different keys accepted: 3 failed;
- (c) exact phone compare: 2 failed;
- (d) digits-only for every text field: 22 failed;
- (e) location widget treated as an extra field: 4 failed.

The sixth, (f) "merge after a failed backup", was **not caught**: all shell tests still passed.

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | The only test that a failed backup stops the merge is a text grep on `bin/agent-step`. Ignoring the failure keeps all 18 + 34 shell tests green | MAJOR | **open**. Needs a fix card (below) |
| 2 | M1: the real cause of your five-field stop is not proven; the keys in the next stop detail decide | MINOR | **open**, waits on your re-run |
| 3 | Lever and Greenhouse still compare the phone exactly. A page that reformats it there gives a not-filled row (`page kept a different value`), not a stop | MINOR | **open**. Only if you see it |
| 4 | `phoneKept` uses "ends with": a very short typed number would match any longer kept number ending in it. Real phone answers are full numbers | MINOR | **open**, low risk |
| - | P2 audit: no `docs/decisions.md` entry for the digits/suffix rule and the "stored `other` row is a reader change" rule. Both are in `docs/running.md` | MINOR | **open**. A docs line in the fix card |
| - | PM, this report: the backup did not run on the P2 merge (warning above) | **MAJOR** (my rating) | **open**. Same fix card |

**Fix card needed (not created by this report card).** "Merge automation: the backup line is found reliably, and a failed
backup merges nothing". It should:
- reproduce the missed P2 backup (dev card text with the line, then a reviewer file, under `pipefail`);
- fix the match, for example by collecting the text first and then running `grep` on it, or by dropping `-q`;
- add the behavioural test from audit finding 1: the real `squash_merge` path in a temp repo with a failing backup, which must
  leave no new commit on main, release the lock, and end with a question starting `OWNER: DB backup before merging`;
- break checks for both;
- the missing decisions entry for P2.

It is high risk (a fix task), individually audited. **Until it merges, back up the DB yourself before a run after any merge
whose report carries the backup line.**

### Test status

From re-audit #16, on `a41523d`:
- `pnpm check`: exit 0, **Test Files 156 passed (156), Tests 2980 passed (2980)**. At re-audit #15: 156 / 2964.
- Shell tests: pre-commit 31, hold 15, agent-step 34, backup 18 (new), all passed, 0 failed. Python: OK.
- `bin/smoke --demo`: all 7 sources `ok`, three fixture dry runs filled. Self-check: `/api/health 200`, `/api/queue 200
  items=70`, `/api/dry-runs 200 runs=5`.
- **Flaky:** the CLI end-to-end tests (`packages/pipeline/test/e2e*.test.ts`) time out at 5 s when the machine is busy (G2
  dev: 1-5 failures per run; the P2 audit: one run with 2 failures, then green twice). They pass on a quiet machine. They do
  not touch the fillers.

The demo data has no Greenhouse location widget and no Ashby page that reformats the phone. Both were checked only on the
fixtures in the tests.

### Known limitations (after fix round 2)

- **The automatic DB backup is not reliable yet** (warning above). Back up yourself.
- **`ambiguous match` is diagnostic, not fixed:** your answers decide. The import still never deletes rows that are gone from
  the YAML. If the stop names such leftovers, I can plan a card "import unapproves config rows missing from the YAML".
- **The Greenhouse location widget is matched by its labels and position**, not by its real markup (which no agent can
  see). Your next real run proves it.
- **Phone digits-only readback is Ashby-only** (finding 3).
- The fix-round-1 limitations still hold:
  - CAPTCHA detection is built from fixtures;
  - Ashby field ids are unverified on a real form;
  - Lever location autocomplete;
  - untouched EEO / consent fields;
  - no Workable / Recruitee filler.

### What you do next

1. **Back up `data/job-agent.db` now** (command above), before any real dry run.
2. **Re-run the three dry runs** that stopped (Lever, Ashby, Greenhouse) with `pnpm job-agent dry-run <posting-id>`.
   Expected results:
   - Lever: either it fills, or `ambiguous match` now names keys. Clear the extra key as in "How to use it" 1, then run it
     again.
   - Ashby: it fills the phone, with no `form_changed` for "Phone Number".
   - Greenhouse: it ends `needs_input`, with the Location row left for you.
3. **Send me on t_1df7c94a** (labels and key names only, never values, never posting ids in the repo):
   - the key names from any `ambiguous match`, and whether each was in your YAML;
   - any remaining `form_changed` / `unexpected_field` detail.
4. **Let the PM plan the B1 fix card** above, so that later merges back up the DB on their own.
5. Keep going toward the done-when: at least 20 dry runs reviewed as correct, at least 10 of them full fills, across
   Greenhouse, Lever and Ashby. Then close t_1df7c94a, t_4532cd2c and t_7a87ffba.
