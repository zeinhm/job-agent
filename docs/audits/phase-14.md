# Phase-end audit of Phase 5 (card title "#13"): PASS

Audited commit: `origin/main` = `593656d` (detached worktree, clean). Range `audit-12..origin/main` (148 files; 142 outside lockfile/snapshots) plus every row in the ledger. Verdict **PASS**: no BLOCKER, no MAJOR, 5 MINOR.

## Numbering and tag (check 6)

The card says "#13", but `audit-13` and `docs/audits/batch-13.md` already exist (the previous audit, t_e6383f77, commit 32274ac). `record_audit` in `bin/step-git.sh` will therefore take the next free number: expect **`audit-14`** and `docs/audits/phase-14.md` (kind `phase` because the title contains "Phase"). I did not set a tag (the automation does). Tags `audit-1..13` currently resolve to the SHAs below and must be unchanged after this run; `audit-12` = `30c1dcd` (matches the previous report):

```
audit-1 f5ea894  audit-2 838942c  audit-3 42cc8a8  audit-4 c6be95d  audit-5 b2d7ef8  audit-6 c7ccd1d
audit-7 c1febd1  audit-8 1915e8c  audit-9 77f5e91  audit-10 d2eb2b7 audit-11 ccdb5ee audit-12 30c1dcd audit-13 32274ac
```

A5 itself: `bash bin/test-agent-step.sh` (part of `pnpm check`) ends `27 passed, 0 failed`, including "existing audit-1 is not moved", "next free number is used and reported", "a tag that exists only on origin is not reused", "FAIL audit sets no tag", "agent-step has no 'git tag -f'", and PM/researcher docs committed instead of stashed. The live test is this audit's own tag: the PM should confirm that `audit-14` appears and 1..13 are untouched.

## Full pipeline on a fresh checkout

- `pnpm install --frozen-lockfile`: ok. `pnpm playwright:install`: ok (Chromium).
- `pnpm check`: exit 0. **Test Files 151 passed (151), Tests 2796 passed (2796)** (previous audit: 137 / 2612). Includes typecheck, lint, web build, `.githooks/test-pre-commit.sh`, `bin/test-hold.sh`, `bin/test-agent-step.sh`, python tests. Log lines with `credit balance`, `jobspy worker failed`, HTTP 500 retries are from tests that fake those failures.
- `bin/smoke --demo`: ok; the three fixture lines:
  ```
  dry-run: status=filled reason=- fields=13/13 screenshot=<smoke dir>/dryruns/2026-10-16/e213980b-.../screenshot.png   (greenhouse)
  dry-run: status=filled reason=- fields=13/13 ...                                                                  (lever)
  dry-run: status=filled reason=- fields=13/13 ...                                                                  (ashby)
  ```
  Smoke dir permissions: `dryruns/` and each date / run dir `700`, `screenshot.png` `600`.
- `bin/smoke dash <dir> --self-check`: `/api/health 200`, `/api/queue 200 items=63`, `/api/dry-runs 200 runs=5` (2 seeded demo runs + 3 fixture runs).

## Deep dives (cards)

D2 dry-run harness (high), D3 fill plan (high), D5/D7/D8 fillers + CLI (high), L1 LinkedIn descriptions (high), A5 agent-step (high), D6 dashboard tab + done-when (medium, in the ledger), D4 choice mapping (medium, in the ledger, already deep-dived in audit 13). D1 migration, C1, DC, D9 at breadth (tests, migration, docs); R1/R2 docs read for what the code relies on. P1/P2 were audited individually before.

## Must-check results

1. **No submit, anywhere: OK.** `grep -rnE "\.click\(|\.press\(|dispatchEvent|requestSubmit|\.submit\(|keyboard\." packages/apply/src` (non-test) finds only: the in-page guard that overrides `submit`/`requestSubmit`; the test page `testing.ts`; and `session.ts:189/192`, the combobox `choose()` which clicks the combobox and a `role=option` item after `inspect()` refused anything that is or sits inside a `button`, `[role=button]`, `[type=submit]`, `input[type=image|button|reset]` or has "submit" in id/name/data-qa. The page is an ES private field (`#page`), `snapshot()` evaluates fixed expressions only. Non-GET requests: aborted by `classifyRequest` except the Ashby read-only allowlist. The D2 test "a page that POSTs on load, change and submit reaches the server with zero..." and its twin "the same page with the guard removed DOES deliver the POSTs" are present.
   Break checks (each reverted with `git checkout -- .`, results from `.vitest/json`):
   - route guard allows every method (`if (method) return {allow:true}`): **caught**, 43 failed / 65 passed in `packages/apply/src/dryrun`.
   - a filler helper presses Enter after `fill` (a submit path): **caught**, 18 failed / 90 passed.
   - fixture host check disabled: **caught**, 2 failed.
   - widen the Ashby allowlist by `ApiSetFormValue` only: **NOT caught** (0 failed, 68 passed) because the body check (`mutation` / `submit` regex) still aborts it. Two layers both have to be removed for harm, so it is safe, but no test pins the list. See MINOR 1.
2. **Fixture-only for agents: OK.** `runDryRun` (`packages/pipeline/src/dry-run.ts`): `--fixture` refuses when `isRealDb` (default DB or a path under `data/`, same test as seed-demo) and on `:memory:`; a posting id on a scratch DB is refused ("a real form is only opened with the real database"). Each filler asserts the URL host again (`127.0.0.1` in fixture mode; `jobs(.eu).lever.co`, `(job-)boards(.eu).greenhouse.io`, `jobs.ashbyhq.com` over https otherwise). All fixture servers listen on `127.0.0.1`; the only `localhost` references are tests that assert it is aborted. In fixture mode the request guard aborts every other host for every method.
3. **Stop rule: OK, with a documented drift.** The card text says "any uncovered field stops before filling", but backlog Decision 4 (owner answer on the gate, question 4) replaced it for Phase 5: covered fields are filled, uncovered ones stay empty with `needs_input`, the run status is `needs_input`; a hard stop stays for CAPTCHA, login wall, unexpected field type, ambiguous match, scam. `planFill` (`fill-plan.ts`) implements exactly that. Salary: `isSalaryWording` is tested first in `coverField`, value only from `salaryNumber` / `salaryText` of the tier ask (source `tier_ask`), wordings are never indexed from the bank, foreign currencies / unclear period need input. Choice fields: covered only through `choiceMappings.get(mappingId(key, label, options))` and the chosen options must exist in the form's options and pass `validateTypedAnswer`. Unapproved answers are filtered out (`approved.filter`, `wordingKeys` skips them). Resume must be an absolute `.pdf` with `%PDF-` header under 10 MB. Plan errors never carry values (`detail` is a fixed string).
4. **Private output: OK.** `output.ts`: `dryruns/` created `0700` and chmod'ed, files `0600` (observed in smoke: `700` / `600`), under `dirname(DB)`. Screenshot route `GET /api/dry-runs/:id/screenshot` serves only the path stored on that run: rejects absolute, `..`, backslash, NUL, non-`dryruns/` and non-`.png`, then realpath must be inside `realpath(<data dir>/dryruns)` and a regular file (symlink escape covered in `dry-runs-routes.test.ts`); no `dataDir` = 404. CLI output prints status, reason, counts and the screenshot path, never a value (`describeError` prints only fixed wording). Personal-data sweep over the whole tree under `packages`, `apps/dashboard/src`, `bin`, `docs/running.md`, `phase-5-backlog`, `decisions`, `docs/research`: no `/Users/`, owner name, domain, `+62`; the only e-mail strings are `*@example.test`, `example.com`, `t@example.invalid`, and public contact addresses quoted from vendor pages in the research notes. No `config/`, `data/` (except handoff) or `.env` read.
5. **LinkedIn L1: OK.** `fetch-descriptions.ts`: a 429 on one posting is `recordFailure(..., block=true)` and the run continues; the backoff starts only if `otherBlockedWithin(db, p.id, ...)` (a different posting with `description_blocked_at` within `DETAIL_BACKOFF_HOURS`). Break check: forcing that condition true (`if (true || ...)`) fails 9 of 34 tests in `fetch-descriptions.test.ts`. A block is stored only in `description_runs`, never in `source_runs`. Poison rule: failed on 2 runs while another posting got its text, or 3 attempts. See MINOR 4 for one edge.
6. **A5: OK** (above). Docs commit uses `git add -- docs[/research]` then `git pull --rebase`; `record_audit` never moves a tag and sets one only on PASS. MINOR 3 below.
7. **Done-when line: OK.** `dryRunDoneWhen` counts only `fixture = false` rows, `correct` = review "correct", full fills = correct with status `filled` (which `runAshbyDryRun` etc. only set when no field is open), met = `>= 20` and `>= 10`. Fixture runs set `fixture: true` in `session.ts` and never count (tested in `dry-run-review.test.ts` / e2e). Status today: **not met** (owner-run; the demo DB shows 0 owner runs). Backlog Decision 9 rule and wording match.
8. **Drift:** none against PLAN 6/8/10 or the backlog Decisions apart from the Decision 4 wording above; Decision 10 (no LLM) holds (no `llm`/Anthropic import in `dryrun/`, `fill-plan*`, `dry-run.ts`); Decision 11 holds (browser missing fails loudly, `BrowserMissingError`); migrations 0006-0008 are additive and have migration tests.

## Findings

1. **[MINOR] `packages/apply/src/dryrun/request-guard.ts:14`**: no test pins the Ashby allowlist contents. The filler and e2e tests use `ASHBY_READ_ONLY_OPERATIONS.has(op)` as their own oracle, so widening the set (e.g. adding `ApiSetFormValue`) passes every test while the `mutation`/`submit` regexes are the only remaining barrier. Reproduce: add `"ApiSetFormValue"` to the set, run `pnpm vitest run packages/apply/src/dryrun`: 0 failed. Fix: assert the exact five names with `toEqual([...].sort())` in `request-guard.test.ts`.
2. **[MINOR] `request-guard.ts:105` (carry-over from audit 13 MINOR 1)**: outside fixture mode every GET/HEAD to any host is allowed, so a script on a real employer page could send a typed value in a query string (`fetch("https://x/?v=...")`). Audit 13 asked the owner-run CLI card to decide and test this; nothing in `docs/decisions.md`, `docs/running.md` or the tests addresses it. Accepted for now because real runs are owner-run, headed, on the three ATS hosts only, but record the decision. Reproduce: `classifyRequest({method:"GET", url:"https://example.com/?v=secret", body:null}, {ats:"greenhouse", fixture:false})` returns `{allow:true}`.
3. **[MINOR, process] `docs/audit-ledger.md`**: still never cleared by automation (`bin/agent-step:141-142` only appends; `record_audit` commits only `docs/audits`). I rewrote the ledger (empty table, counts 0/5 and 0/10) in this detached worktree, but it will not reach main. Same defect as audit 13 MINOR 3 / fix task 1. Until fixed, the ledger keeps firing the batch threshold. Also AGENTS.md still does not mention that `bin/agent-step` stashes/commits in main on the owner's behalf (audit 13 MINOR 2 / fix task 3).
4. **[MINOR] `fetch-descriptions.ts` `takeBackBlocks`**: it decrements `description_attempts` for every posting with a non-null `description_blocked_at`, including stale marks from earlier than the backoff window that were never cleared. A poison job that was 429'd long ago gets an attempt back when an unrelated real block happens, delaying its give-up by one run. No harm to the owner; the window is small.
5. **[MINOR] `bin/step-git.sh` `commit_docs`**: commits everything under `docs/` (pm) or `docs/research/` (researcher) in main, including owner edits made there; only the pre-commit hook guards personal data (unchanged from audit 13 MINOR 2).

## Fix tasks

1. **Pin the Ashby allowlist (low, dev)**: exact-contents test of `ASHBY_READ_ONLY_OPERATIONS` (finding 1).
2. **Decide the live-mode GET policy (low, PM + owner)**: record in `docs/decisions.md` that real dry runs may GET any host, or add a per-ATS host allowlist plus test (finding 2).
3. **Clear the ledger and fix the docs wording (low, PM/QA)**: put the empty ledger from this audit on main (`Last audited commit: 593656d`, counts 0/5, 0/10; the 6 Phase 5 rows D1, D4, D6, D9, C1, DC and all older rows are covered), make QA's merge step or `record_audit` clear rows on a PASS, and add one AGENTS.md line that `bin/agent-step` may stash/commit docs in main (finding 3).

## Ledger

All rows in `docs/audit-ledger.md` are covered by this audit (t_918664ed D1, t_84aa4b70 D4, t_4fbf1521 D6, t_772e5705 D9, t_ab72b1a1 C1, t_a9f809f5 DC, plus the older rows already covered by audits 12 and 13). The cleaned file is in this worktree only (finding 3).

## Done-when status (owner-run)

`dry runs: 0 correct of 0 reviewed (0 full fills); done when 20 correct, at least 10 full fills: not met`. Expected: nothing has been owner-run yet. Next step is the owner's real-form dry runs (`pnpm job-agent dry-run <posting-id>`), after running `pnpm playwright:install`.
