# Re-audit #15: Phase 5 fix round

Audited commit: `origin/main` = `6e8bb9d` (detached worktree). Range `audit-14..origin/main` (74 files, +4245/-921) plus the ledger. Verdict **PASS**: no BLOCKER, no MAJOR, 3 MINOR.

## Totals (step 1)
`pnpm install --frozen-lockfile`, `pnpm playwright:install`, `pnpm check`: exit clean, `Test Files 156 passed (156)`, `Tests 2964 passed (2964)` (audit #14: 151 / 2796), shell tests `34 passed, 0 failed`, python `Ran 25 tests ... OK`.

## Status table (step 3)

| Item | Status | Where / proof |
|---|---|---|
| 1 CAPTCHA (dry runs only) | **closed** | `detectors.ts` `detectCaptcha` / `classifyElement` (passive vs visible; `strict` kept, `captchaMode` required, no default); `session.ts` `recheck()` after every fill and before the screenshot; `filler.ts` Ashby stops filling when `session.stop`. Proof: `captcha.matrix.test.ts` (5 variants x 3 ATS), `detectors.test.ts`, `harness.test.ts`. Break checks (a), (b). |
| 2 gh_jid | **closed** | `ats-links.ts` `effectiveApplyUrl` + `greenhouseJobIdOf`; `questions/index.ts` `resolveTarget` / `saveVerifiedSlug`; `greenhouse-board.ts` `resolveGreenhouseSlug` (verified id, 5 GETs max, no redirects); `dry-run.ts` `storedGreenhouseSlug`. Proof: `questions.test.ts` "Greenhouse career-page links", `dry-run.test.ts` golden rows. Break check (c). |
| 3 Ashby phone | **closed** (fixture-only, see note) | `ashby/form.ts` tel-input pick + consent group skipped; `fill-plan.ts` stop detail carries `(type, dom)` (tags/input types, never a value). Proof: `ashby/filler.test.ts` (phone filled, country and consent untouched, `phonepair` stop detail). Break check (d). The agents cannot see the real Ashby form: the owner's next real run is the final proof. |
| 4a L2a root cause | **closed** | Documented in decisions.md (dedupe merged the same-job rows; title tags; domain links; apply_links created later). `ats-match.ts` `jobTitleKey` / `boardJobRef`, `fetch-descriptions.ts` `atsDescription` (miss labels). Proof: `fetch-descriptions.ats.test.ts`. |
| 4b L2b | **closed** | `ats-description.ts` `atsJobOf` / `AtsDescriptionFetcher`; `fetch-descriptions.ts` second route (cap 50, 6 h retry gap, never to LinkedIn, no LinkedIn request). Uses the G1 resolver (`resolveGreenhouseSlug`), same function. Proof: `fetch-descriptions.ats-link.test.ts`, `ats-job.test.ts`. |
| 4c audit #14 MINOR 4 | **closed** | `takeBackBlocks(db, at)` gives an attempt back only to marks newer than `DETAIL_BACKOFF_HOURS`; older cleared. Proof: `fetch-descriptions.ats.test.ts` "a block gives an attempt back only to the 429s of that block". Break check (f). |
| 4d L1 note (given-up rows keep a 429 mark) | **closed** | `fetch-descriptions.ts` clears `description_blocked_at` on given-up rows at start and on give-up. Tested in the same file. |
| 5 GET policy | **closed** | Option (a) recorded in `docs/decisions.md` ("Live-mode GET policy for Phase 5 dry runs"); option (b) is named a Phase 6 prerequisite there and in the backlog. No code change, as planned. |
| 6a allowlist pin | **closed** | `request-guard.test.ts` "Ashby allowlist is pinned" (exact list, `ApiSetFormValue` aborted). Break check (e). |
| 6b ledger automation | **closed** | `bin/step-git.sh` `clear_ledger` (rows whose commit is an ancestor; PASS with a tag only; header guard); 34 shell tests including FAIL / no tag / malformed. |
| 6c AGENTS.md | **closed** | two lines under "Merging". |
| #14 MINOR 1 | closed | 6a. |
| #14 MINOR 2 | closed (recorded) | decision 5. |
| #14 MINOR 3 | closed | 6b. |
| #14 MINOR 4 | closed | 4c. |
| #14 MINOR 5 | closed (documented) | AGENTS.md line on docs commits in main. |

## Cross-card consistency (step 2)
- C1 and A1 both touch the Ashby fixture: CAPTCHA variants are separate files (`fixtures/ashby/captcha/*.html`, composed `app.html+captcha/<v>.html` by `fixture.ts`); `ASHBY_FIXTURE_CAPTCHA_PATH` now points at the visible-challenge variant, and the phone/phonepair variants share the same `app.html`. No conflict; the whole ashby filler suite passes. The old whole-page `captcha.html` fixtures were deleted for all three ATS and nothing references them.
- G1 resolver is the one L2b uses (`ats-description.ts` imports `greenhouseSlugCandidates` / `resolveGreenhouseSlug`; `dry-run.ts` and `questions/index.ts` share `greenhouseJobIdOf`).
- L2a and L2b in `fetch-descriptions.ts`: order free route, ATS link, LinkedIn is as documented; postings with an ATS job link never reach LinkedIn; the summary line matches `docs/running.md:120`.
- D2 guard unchanged: `request-guard.ts` / `page-guard.ts` not in the diff except the test pin. The harness adds no page script for CAPTCHA (polling, read-only `isVisible` / `boundingBox` / `evaluate`).
- `docs/decisions.md` has two entries titled "Dry-run CAPTCHA rule" (PM's and the dev's, the dev's says why); consistent in substance, append-only, fine.

## Live run (step 4)
```
dry-run: status=filled reason=- fields=13/13 screenshot=<smoke>/dryruns/2026-10-17/.../screenshot.png   (greenhouse, lever, ashby fixtures)
self-check /api/health 200
self-check /api/queue 200 items=67
self-check /api/dry-runs 200 runs=5
fetch-questions: selected 0, attempted 0
fetch-questions: matched 18 covered, 1 need a choice mapping, 3 salary, 21 unknown (8 wordings)
fetch-questions: requests 0
fetch-descriptions: nothing to fetch
```
Demo data has no LinkedIn rows and no gh_jid links, so the new routes were exercised by the tests only (recorded fixtures), not by the smoke run. No `captcha=passive` appears on fixture runs, as expected (plain fixtures).

## Break checks (step 5, each reverted; `git status` clean afterwards)
| Check | Change | Result |
|---|---|---|
| (a) passive CAPTCHA stops | `if (anyUrl) return stop` in `detectCaptcha` | **15 failed** (`captcha.matrix.test.ts` case 1 and 4 on all ATS, plus others) |
| (b) visible challenge ignored | visible iframe returns passive | **11 failed** (`captcha.matrix` cases 2, 3, 5) |
| (c) unverified slug accepted | dropped `String(id) === jobId` | **fails** `questions.test.ts` "a 200 for a different job id is not verified" |
| (d) Ashby phone mapping dropped | `const els = all` | **12 failed** in `ashby/filler.test.ts` |
| (e) `ApiSetFormValue` allowlisted | added to the set | **2 failed** "Ashby allowlist is pinned" |
| (f) stale 429 gets an attempt back | removed the `gte(...since)` filter | **fails** `fetch-descriptions.ats.test.ts` "a block gives an attempt back only to the 429s of that block" |

(Vitest filter runs also matched stale `dist/` copies that fail on a src edit; ignore, `pnpm check` does not run them.)

## Ledger (step 6)
`docs/audit-ledger.md` is `Last audit tag: audit-14` with exactly two rows: t_9e75a5d6 (H1, `cfb4a4c`) and t_bfe5e86b (H2, `b192747`), both ancestors of `6e8bb9d`. On this PASS I expect the automation to clear both rows and set the line to `audit-15`. (The five high cards are not in the ledger, as they were individually audited.)

## Personal-data sweep (step 7)
Diff added lines scanned for emails, phones, secrets: only the fixture's "Indonesia (+62)" country option (a fake select option, fine). The owner's Lever posting uuid and the other uuid on t_e3f354ae appear nowhere in `origin/main` (git grep) or in commit messages. No `config/`, `data/` (except handoff) or `.env` read.

## Findings

1. **[MINOR] `packages/pipeline/src/dry-run.test.ts:383-393`, `questions/questions.test.ts:734-921`**: golden rows use the owner's second real example URL (a `posit.co` company page and its gh_jid) from t_e3f354ae. The card rule allows public company URL shapes such as the instacart one, and a job URL of a public company is not personal data, so this is not a BLOCKER; but it ties the repo to the owner's own application targets. Fix later: swap for an invented company and id.
2. **[MINOR] `fetch-descriptions.ts` ATS route (`recordFailure` then `MAX_DESCRIPTION_ATTEMPTS`)**: a transient network or HTTP error counts as an attempt like a closed job. 3 failures over ~12 h (6 h gap) make a posting `description_unavailable` for good, and it is never sent to LinkedIn. A day-long ATS outage can permanently lose descriptions of open jobs. Fix: count only 404 / not-on-board / id mismatch / empty text; leave network and 5xx as "try again" like a deferred host.
3. **[MINOR] `ats-description.ts` / `fetch-descriptions.ts`**: a `?gh_jid=` posting with no stored board costs up to 5 paced lookups (2 s each) per posting; with 50 postings per run that is up to ~10 min of the step, repeated every 6 h per failing posting for 3 attempts. Not harmful (GET only, paced, capped) but slow; consider caching a board-not-found by host for the run.

Also noted, not findings: the free route can attach one description to two different roles with the same location-stripped title at the same company (same trade-off as before, now slightly wider by `jobTitleKey`).

## Fix tasks
None required. Optional low-risk cards for MINOR 1-3 if the PM wants them.

## Owner applies
None.
