# Phase-end audit #1 (Phase 1) - t_be4c38f1

Copied from the card comments of t_be4c38f1 (two auditor runs). Audited point: `ced5390` (tag `audit-1`).
Run 1 verdict: FAIL (M1, M2). Fix task t_0c765557. Run 2 verdict: PASS.

---

## Run 1 (FAIL)

Scope: whole of `main` (no `audit-<n>` tag existed; ledger listed 20 medium tasks) merged with the t_55542219 digest branch. Checkout at `bf39f8e`.

### Setup / evidence
- `pnpm install --frozen-lockfile` OK.
- `pnpm check` (typecheck, eslint, prettier, vitest, pre-commit hook tests): 34 files / 456 tests pass; hook tests 31 passed, 0 failed.
- Break-the-code checks (all reverted with `git checkout -- .`):
  - `TO_MONTH.year` 1/12 -> 1 (salary normalization): 4 tests fail (process.test, salary.test x3). Caught.
  - Removed `isNull(analysis.digested_at)` in digest: `digest.test.ts > does not show a posting stamped on an earlier day` fails. Caught.
- Personal data scan: no emails, phones or owner names in fixtures, tests, docs or config examples. Golden sets use public HN data. `config/`, `data/`, `.env*`, `*.db` are gitignored. One local-path leak: see m3.
- Guardrails: no LinkedIn code, no login/cookies, no CAPTCHA handling, no submit. The web3.career token is read from env and kept out of `SourceError` (no `cause`, URL redacted). Per-host rate limit >= 1 s enforced in `http.ts`, default 2 s. Non-SourceError exceptions are reduced to their type name in `source_runs`.

### Findings

#### MAJOR
**M1. packages/sources/src/{greenhouse,lever,ashby}/index.ts: HTTP 404 on a company slug is swallowed and the run is recorded `ok`.**
A mistyped or removed slug yields `[]` plus a `log.warn` only. `source_runs` shows `ok, found 0`, so the digest "Source health" section never shows it. If every configured board 404s, the source looks healthy while returning nothing. `docs/audit-patterns.md` lists exactly this ("returning [] when a source is blocked"). Repro: point `companies.yaml` at a nonexistent slug, run `discover`, read the digest. Fix: surface per-board 404s in `run.error_message`, and error when all boards fail.

**M2. Same three ATS adapters: one failing board aborts the whole source.** The loop in `fetch()` throws on the first non-404 error, so postings already fetched from earlier boards are discarded and later boards are not tried. Fix: per-board try/catch that records failures and throws a combined `SourceError` only after all boards were tried, keeping the successes.

#### MINOR
- m1. `packages/pipeline/src/process.ts`: a posting analysed with `salary_no_fx` (FX table empty at the time) is never re-analysed after rates are fetched.
- m2. `discover.ts storePostings`: an existing (source, external_id) only bumps `last_seen_at`; later edits to salary/location/description are never picked up.
- m3. `docs/phase-1-remaining.md` contained the owner's local home-directory path from pasted kanban events (scrub). `packages/sources/test/config.js.map` and `config.d.ts.map` were stray committed build artefacts (delete).
- m4. `packages/core/src/http.ts`: User-Agent contact URL fell back to a placeholder because root `package.json` had no `repository` field.
- m5. Digest source health: the "latest" row may be a `skipped` run, which reads like a problem.
- m6. Digest counted rejections via the string `"salary: max below floor"`, coupled to the reason text in `salary-floor.ts` with no shared constant.

### Consistency across tasks
Invalid-job thresholds are inconsistent between adapters (`invalid*2 > n` vs `MAX_INVALID_SHARE`); error wrapping is consistent (`SourceError` with cause, except web3.career which deliberately omits it for token safety). 404 handling differed (other sources fail; ATS skip), see M1.

### Deep dive
Salary normalization + floor (domain-critical; mutation caught) and the digest dedupe/stamping transaction. No defect found beyond m1/m6. Not exercised: live network runs.

### Assumptions
No `audit-1` tag existed, so all of `main` was reviewed. `.env.example`, `config/` and `.claude/settings.json` were not read.

### Fix tasks
1. Surface ATS 404s in source health (M1), with tests.
2. Per-board failure isolation (M2), with a test where board 1 succeeds and board 2 returns 500.
3. Cleanups: m1, m3, m4, m5, m6.

Verdict: FAIL (two MAJOR findings, no BLOCKER; no owner-safety problem found).

---

## Run 2 (re-audit after fix task t_0c765557) - PASS

Scope: whole of `main` plus fix commit `b2dbe1b`.

### Evidence
- `pnpm install --frozen-lockfile` OK.
- `pnpm check`: 34 files / 466 tests pass; pre-commit hook tests `31 passed, 0 failed`.
- Mutation checks (reverted, `git status` clean afterwards):
  - `boards.ts`: removed the "all boards 404" error -> 3 tests fail (ashby, lever, greenhouse). Caught.
  - `discover.ts`: disabled the `PartialSourceError` branch -> `discover.test.ts > stores the postings of a PartialSourceError but records an error run` fails. Caught.
- Personal data: `git ls-files` has no `*.map`; `grep /Users/ docs/*.md` is empty. Guardrails unchanged by the fix.

### Previous findings: status
- M1 (404 slug swallowed): FIXED. `fetchAllBoards` (`packages/sources/src/boards.ts`) returns a warning naming the unknown slugs; `discover.ts` stores it in `source_runs.error_message` with status `ok`; if every board is 404 it throws `SourceError`. Tested for all three adapters.
- M2 (one board aborts the source): FIXED. Every board is tried; on a non-404 failure it throws `PartialSourceError` carrying the successes. `discover` stores those postings but records `error`, so `lastOk`/`since` do not advance.
- m1, m3, m4, m5, m6: addressed per the commit message; m3 and the 466-test run verified.

### New findings (MINOR)
- n1. `boards.ts`: on a non-404 board failure the 404 slugs are appended to the error text, but the `warnings` field is lost on the throw path. Acceptable.
- n2. `fetchAllBoards` rethrows non-`SourceError` exceptions immediately, discarding earlier successes. Only affects genuine programming bugs.
- n3. Still open (m2 above): `storePostings` never refreshes an existing posting after the first snapshot. Decide in Phase 2.

No BLOCKER or MAJOR findings. No owner-safety problem found.

### Not exercised
Live network runs (`bin/smoke`); adapters verified through recorded fixtures only.

### Fix tasks
None required. Optional: track n3 for Phase 2.

Verdict: PASS
