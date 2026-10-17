# Re-audit #16: Phase 5 fix round 2

Audited commit: `origin/main` = `a41523d` (detached worktree). Range `audit-15..origin/main` (26 files, +1240/-33). Verdict **FAIL**: 0 BLOCKER, 1 MAJOR (break check f is not caught by any test), 3 MINOR. The code of all four cards is correct; the one MAJOR is a test gap in B1.

## Checks
`pnpm install --frozen-lockfile`, `pnpm playwright:install`, `pnpm check`: exit 0. `Test Files 156 passed (156)`, `Tests 2980 passed (2980)` (re-audit #15: 156 / 2964), shell tests: pre-commit `31 passed, 0 failed`, hold `15 passed, 0 failed`, agent-step `34 passed, 0 failed`, backup `18 passed, 0 failed` (new), python `OK`.

Live: `bin/smoke --demo` ended with all 7 sources `ok` (postings 1723, dry_runs 5, dry_run_fields 43, llm_calls 0).
`bin/smoke dash <dir> --self-check`:
```
self-check /api/health 200
self-check /api/queue 200 items=70
self-check /api/dry-runs 200 runs=5
```
(Demo data has no Greenhouse location widget or Ashby phone formatter; those paths are proven by the fixtures in the tests.)

## Status table (owner items of t_3e3cb038)
| # | Item | Status | Where / proof |
|---|---|---|---|
| 1 | Lever "ambiguous match": dedupe by key, ambiguity only for two different keys | **partly closed** | `fill-plan.ts:358-370`: keys are a `Set`, standard profile key added once, so same key reached by several routes fills. That was already the behaviour at audit-15; the diff adds the keys to the stop detail only (keys, never values). Proof: `fill-plan.test.ts` "one key reached by the standard route, the bank question and an alternative fills", "the owner's five contact labels, each also carried by a second key, stop naming both keys", `lever/filler.test.ts` "contact fields reached by two routes with one key still fill" and exact detail `ambiguous match, Email (contact.mail, profile.email)`. Why only partly: the real cause of the owner's stop (probably two different keys, e.g. leftover `answer_bank` rows) is not proven or fixed by code; the card now makes the next run name the keys, and `docs/running.md` says how to clear a leftover. Needs the owner's re-run. |
| 2 | Ashby `form_changed "different: Phone Number"` | **closed** | Digits-only phone compare: `lever/filler.ts:160-190` (`phoneKept`, `kept(..., phone)`), Ashby passes `p.answerKey === PROFILE_KEYS.phone` (`ashby/filler.ts:171`). Second cause (row stored as `other` by an older reader): `lever/form.ts` `compareQuestions(..., {upgradeOther})`, label change on such a row still stops, row refreshed (`ashby/filler.ts:114-118`). Proof: `ashby/filler.test.ts` "phone readback by digits" (reformatting fixture `-phonefmt`, old-reader row, label change, required/option change, rule test). |
| 3 | Greenhouse `form_changed "missing: Location; extra: Search, Location (City)"` | **closed** | `greenhouse/form.ts` (`location` kind, helper "Search" input hidden from the controls, `pairLocation`, `compareForm` leaves the pair out); `greenhouse/filler.ts` never types into it (`apply` refuses), row `filled=false`, note `location autocomplete: pick the suggestion yourself`, run `needs_input`. Same precedent as Lever location. Proof: `greenhouse/filler.test.ts` (note, neither input touched, no stored Location -> `form_changed`, Location with no control -> `form_changed`), `form.test.ts` (4 cases incl. an unrelated new control still stops). |
| 4 | Backup before merging a card with the OWNER line | **partly closed** | `bin/step-git.sh:101-132` `backup_before_merge`, called in `squash_merge` (`bin/agent-step:43`) before the squash for both QA and audit merges; `.backup`, non-empty, `integrity_check` = ok, keep 5, failure -> `question "OWNER: ..."`. Proof: `bin/test-backup.sh` (matching, prune, failure cases). Why partly: the "failure merges nothing" wiring is only a text grep (finding 1); break check (f) passes. |

## Cross-card consistency
- P2 compares digits for the phone only: `kept()` takes the flag, Ashby is the only caller that sets it; text fields stay exact (check d fails 22 tests). Lever and Greenhouse callers pass no flag, so their phone stays exact (Greenhouse has its own private `kept`, `greenhouse/filler.ts:152`). See MINOR 1.
- G2 follows the Lever precedent (never typed, not filled, `needs_input`); `docs/running.md` states it.
- M1 stop detail: label plus key names only; the 200-char cut is documented. Key names are owner-chosen identifiers, not answer values.
- `docs/running.md`, AGENTS.md (merging section) and the two new `docs/decisions.md` entries match the code (match rule regex, keep 5, `OWNER:` hold, location note text).
- D2 guard files (`request-guard.ts`, `page-guard.ts`) are not in the diff; no flag added. No LLM on any path. `bin/step-git.sh` touches the DB only through `.backup` and `PRAGMA integrity_check` (compared, not printed; also asserted by a test). The backup file names are `data/job-agent.db.bak-*`, gitignored.

## Break checks (each reverted with `git checkout -- .`)
| Check | Mutation | Result |
|---|---|---|
| (a) same key counted twice | `keys` as array, standard key pushed | **1 failed** (`fill-plan.test.ts` "one key reached by the standard route...") |
| (b) two different keys accepted | `keys.size > 5` | **3 failed** (`a field that matches two approved answers stops`, ...) |
| (c) exact compare for the phone | `if (false && phone ...)` | **2 failed** (`phone readback by digits`: reformat fixture, rule test) |
| (d) digits-only for every text field | `if (true && ...)` | **22 failed** (ashby + lever filler suites) |
| (e) Greenhouse location widget as extra | `pairLocation` returns null | **4 failed** (filler x2, form x2+) |
| (f) B1 merges after a failed backup | `\|\| true; false && { unlock_main; question ...` | **0 failed**: `bin/test-backup.sh` 18/18 and `bin/test-agent-step.sh` 34/34 still pass |

## Findings
1. **[MAJOR] bin/test-backup.sh:68-75 (and bin/agent-step:43)** The only test that the merge stops when the backup fails is `grep -q 'backup_before_merge .*question "OWNER: DB backup before merging $br failed: $STEP_ERR"'` on the source text. Replace the line with `backup_before_merge ... || true; false && { unlock_main; question "OWNER: DB backup before merging $br failed: $STEP_ERR"; }` (failure ignored, merge goes on): the grep still matches, all 18 + 34 shell tests pass. That is exactly owner item 4 (no merge without a backup) and it is not guarded by a behavioural test. Reproduce: edit as above, `pnpm exec bash bin/test-backup.sh` -> `18 passed, 0 failed`. The helper itself is well tested; the missing piece is a test that runs `squash_merge` (or the QA / audit path of `bin/agent-step`) in a temp repo with a failing backup and asserts: no commit on main, lock released, action `question` starting `OWNER: DB backup before merging`.
2. **[MINOR] M1 item 1 root cause unproven.** The change names the keys but the leftover-row theory is a documented guess; the owner re-run decides. Nothing to fix in code now.
3. **[MINOR] lever/filler.ts, greenhouse/filler.ts:270** Lever and Greenhouse still compare the phone exactly, so a page that reformats the number there gives `page kept a different value` (a not-filled row, not a stop). Not reported by the owner; the PM may want a follow-up if it shows up.
4. **[MINOR] `phoneKept` uses `endsWith`:** a very short typed digit string would match any kept number ending with it. Phone answers are full numbers, so low risk.

## Personal-data sweep
`git diff audit-15..origin/main` contains no email, real phone, or posting id; the three UUID-shaped ids from t_3e3cb038 appear nowhere in `origin/main` (`git grep` empty). Fixtures use the fake persona (`jane.doe@example.test`, an obviously sequential fake phone). `config/`, `data/` (except `data/handoff/`) and `.env` were not read.

## Fix tasks
- **Merge automation: behavioural test that a failed backup merges nothing (B1 follow-up).** Add a test in `bin/test-backup.sh` (or `bin/test-agent-step.sh`) that runs the real `squash_merge` path with the OWNER line present and a failing backup (no DB file / corrupt DB, `BACKUP_DB` override) and asserts: no new commit on main, `unlock_main` ran, result is `ACTION: question` with `OWNER: DB backup before merging`. Confirm it fails when the failure is ignored. High risk (fix task). Keep the text-grep tests or drop them.

## Ledger
No ledger rows (all four cards were high and individually audited). `docs/audit-ledger.md` is unchanged by this audit; no tag is set on FAIL.
