# Re-audit #11: Phase 4 fix round

Audited commit: `af8f72e` (= origin/main). Diff reviewed: `git diff 33b53d0..af8f72e` (40 files, code and docs).
Cards covered: t_af1e9656 (R1), t_e8dd3801 (A2), t_aaa0bf00 (A3/A4), t_22582616 (A1, batch 8 MINOR-3, batch 9 registry guard).

**Numbering collision (read first):** the tag `audit-11` already exists (on `365a7e8`) and `docs/audits/batch-11.md` already exists
(an earlier batch audit, t_36412184, covering `audit-10..a392311`). This card's title also says `#11`. The automation must not
re-tag or overwrite: either number this report 12 (tag `audit-12`, `docs/audits/batch-12.md`), or, if it uses `git tag -f`, it
would MOVE the existing tag, which the card forbids. See finding M1.

## Setup
- Fresh detached worktree of main; `pnpm install --frozen-lockfile` ok.
- `pnpm check` (typecheck, eslint, prettier, build:web, vitest, pre-commit hook tests, hold tests, python tests): exit 0.
  `Test Files  117 passed (117)`, `Tests  2286 passed (2286)` (audit #4: 116 files, 2160 tests).

## Status table

| Item | Status | Where / proof |
|---|---|---|
| R1 tests never start the real JobSpy worker | **closed** | `packages/sources/src/jobspy/worker.ts:55` guard (`opts.spawnFn === undefined && process.env["VITEST"]`, before `existsSync`, no off switch); `spawnFn` injection `worker.ts:52,62`, `jobspy/index.ts` and `registry.ts` `BuildAdaptersOptions.jobspy`. Tests: `jobspy/index.test.ts` "the default spawn is refused under the test runner and never starts the process", "the guard holds when the venv is missing too"; `cli.test.ts` "discover ... exits 0". Break (a) fails 3 tests. Caveat on the fake-venv proof below. |
| A1 seed-demo realpath + non-demo refusal | **closed** | `seed-demo.ts:31` `realpathLoose` (dangling symlinks followed), `refusalReason` checks path and realpath against `data/` and its realpath; `seed-demo.ts:114` non-demo check is the first statement of the write transaction. Tests: `seed-demo.test.ts` (refuses DB with non-demo posting; `seedDemo` throws and writes nothing; symlink cases). Break (d) fails 2 tests. Live: refused (below). |
| A2 salary wordings, never covered by bank, no inbox form | **partly closed** | One detector `packages/apply/src/salary.ts` used by `match.ts` (`matchQuestion`, `buildAnswerIndex`), `inbox.ts:104,115`. Tests: `salary.golden.test.ts` (89 cases), `match.test.ts`, `match-questions.test.ts`, inbox route tests. Break (b) fails `positive: Stipend expectation`. Still lexical: residual false negatives, see finding M2. |
| A3 any edit or inbox link clears approval | **closed** | `answers-store.ts:174` (`changed ? false : ...`, even with `approved: true` in the same request); `inbox.ts:177` link goes through `updateAnswer`; `app.ts` PATCH now calls `matchQuestions`. Tests: `answers-routes.test.ts` (6 "still clears approval" cases), `inbox-routes.test.ts`, `answers.test.tsx`, `inbox.test.tsx`. Break (c) fails 8 tests. |
| A4 answers export 0600 | **closed** | `answers-store.ts:220-227` temp file 0600 + `chmodSync` + `renameSync`, dir created 0700. Test: `answers-routes.test.ts` "writes the file 0600, also over an existing 0644 file, and creates the dir 0700". Break (e) fails it. |
| A5 ledger and tags housekeeping | **open** | PM's claimed state is NOT on origin/main, see finding M1. |
| Batch 8 MINOR-3 question fetch redirects | **closed** | `questions/index.ts:65` `followRedirects: false`, 3xx -> `redirect not followed (HTTP n)`. Test: `questions.test.ts` "never follows a redirect (to another host / the same host)": target not requested, no query logged. |
| Batch 9 `registry.ts:15` | **closed** | `registry.ts:19` keeps `owner:` in `PROTECTED_SOURCE` with a comment; `registry.test.ts` "never overwrites an owner:<date> source even when its policy is unknown" (guard test). |

## R1 proof (fake venv)
I could not make a fake `python` executable: `chmod` and `ln -s` were refused in this unattended run (approval required), so I created
`workers/jobspy/.venv/bin/python` as a non-executable shell script that would write `R1-marker.txt` if run, and `pnpm test`
with it in place:
- `Test Files  1 failed | 116 passed`, `Tests  1 failed | 2285 passed`. The one failure is `smoke.test.ts` "--with-jobspy adds one forced linkedin ...":
  it checks that the python file exists AND is executable (`bin/smoke`), which my non-executable fake is not: an artifact of my fake, not of the code.
- `ls R1-marker.txt`: `No such file or directory` (never written).
- Because the fake was not executable, a spawn would also have failed before writing the marker, so the marker alone is weak. The stronger
  evidence is break (a): with the guard disabled and the same fake venv present, tests that reach the spawn fail
  (`index.test.ts` "the default spawn is refused ... never starts the process", "the guard holds when the venv is missing too", `cli.test.ts` "discover ... exits 0").
- Fake venv and logs deleted afterwards (`rm -rf workers/jobspy/.venv`). Worktree left clean.

## Live run (`bin/smoke --demo`, no `--with-jobspy`)
```
== seed-demo
seed-demo 2026-10-16: added 8 postings, 3 questions
== discover ... (himalayas 200, remoteok 18, remotive 1, weworkremotely 17, hn 24, arbeitnow 1432, greenhouse 25)
== process
processed 1631, kept 42, rejected 1589 (...)
== answers import
answers import: 16 added, 0 updated, 0 unchanged, 0 kept
== match-questions
match-questions: 3 questions, 2 covered, 0 salary, 1 unknown (1 wordings), 0 changed
== dashboard --self-check
self-check /api/health 200
self-check /api/queue 200 items=49
```
`bin/smoke dash <dir> --self-check`: `self-check /api/health 200`, `self-check /api/queue 200 items=49`.
`bin/smoke run <dir> match-questions`: `match-questions: 3 questions, 2 covered, 0 salary, 1 unknown (1 wordings), 0 changed`.
`bin/smoke run <dir> seed-demo` (smoke DB now holds public postings): exit 1,
`seed-demo: refusing to write, the database holds 1634 non-demo posting(s) (seed a fresh DB before discover)`.
(`docs/running.md` and the `bin/smoke` header match this behaviour: `--demo` seeds before discover.)

## Break-the-code checks (each reverted with `git checkout -- .`)
| # | Change | Result |
|---|---|---|
| a | disable the VITEST guard in `worker.ts` | 3 failed (`index.test.ts` x2, `cli.test.ts` x1) |
| b | remove the `stipend` alternative | 1 failed (`salary.golden.test.ts` "positive: Stipend expectation") |
| c | `approved = patch.approved ?? (changed ? false : row.approved)` | 8 failed (`answers-routes.test.ts`) |
| d | disable the non-demo posting check in `seed-demo.ts` | 2 failed (`seed-demo.test.ts`) |
| e | plain `writeFileSync` in `exportAnswers` | 1 failed (`answers-routes.test.ts` export 0600) |

## Cross-card consistency
- `inbox.ts` and `answers-store.ts`: both salary and approval cards use the same `updateAnswer`/`isSalaryWording`; `linkInbox` goes through `updateAnswer`
  (clears approval), then `matchQuestions`; `PATCH /api/answers/:key` also re-matches, so stored coverage cannot outlive a cleared approval. Consistent.
- No circular-import problem (`answers-store -> match -> salary`). `match.ts` has an import in mid-file (style only; lint passes).
- `docs/decisions.md` entries (hardening, one salary detector, approval rule) match the code (checked each numbered claim against the files above).
- `config/answers.example.yaml` changed in this range; the commit is authored by the owner (`f6b0146`), consistent with "owner applies config examples".

## Personal-data sweep
`git diff 33b53d0..HEAD -G'<email|phone|key patterns>'` matches only `config/answers.example.yaml` (`alex@example.com`, fake persona). No real
contact data, keys, or `config/`/`data/` content in tests, fixtures, docs or comments.

## Findings
- **[MINOR] M1 (A5 open)**: `docs/audit-ledger.md` on origin/main is not as the card says. Line 6 still reads `Last audit tag: (none yet)`, there is no
  `Last audited commit:` line, the file still carries the old rows (including t_22582616 at the end, `a392311`), the counts lines are stale
  (`medium 6 / 5`), and `docs/decisions.md` has no 2026-10-16 "Audit tags" entry (grep for "Audit tags" finds nothing). The PM's reset commit is evidently not on
  origin/main. Also `audit-11` already exists (`365a7e8`) and `docs/audits/batch-11.md` exists from t_36412184, so this card's `#11` collides.
  Reproduce: `git tag --list 'audit-*'`, `grep -n "Last audit" docs/audit-ledger.md`, `grep -n "Audit tags" docs/decisions.md`.
  I changed nothing (detached worktree, never push); needs the PM/automation.
- **[MINOR] M2 (A2 residual)**: `isSalaryWording` is lexical and misses some pay questions. Probe results (false = not salary): "What is your asking number?",
  "What is your minimum acceptable offer?", "What are your financial requirements?", "What is your price?", "Current OTC". Only matters if the owner writes
  such a wording into a bank entry (then `buildAnswerIndex` would not block it), and unmatched questions go to the owner's inbox with the answer form, but the
  design principle "never covered by a bank answer" is then only as good as the word list. Optional follow-up: add "asking", "offer", "financial requirements", "price" wordings with golden cases, or have the owner review any bank answer that contains a number/currency.
- **[MINOR] M3**: the R1 guard checks `process.env["VITEST"]`; a test runner other than vitest (or a script run with VITEST unset) is not covered. Acceptable here (`vitest` is the only runner; injected `spawnFn` is the documented path), noted only.
- No BLOCKER or MAJOR findings.

## Deep dive
Salary detector and approval rule (the high-risk items): read `salary.ts`, `answers-store.ts`, `inbox.ts`, `match.ts` in full, probed 23 wordings, and did breaks b, c, e. R1/A1 read in full with breaks a and d.

## Fix tasks
1. (PM/automation, not code) Fix the numbering: tag `audit-12` / `batch-12.md` (do not move `audit-11`), and re-apply the PM's ledger reset:
   `Last audited commit: af8f72e`, clear every row covered by audits 1-11 and this one (incl. t_22582616), counts `medium 0 / 5 - low 0 / 10`; add the "Audit tags" decision entry.
2. (optional, high-risk fix card) widen `salary.ts` for M2 with golden cases.

## Verdict
PASS (no BLOCKER/MAJOR). Audited commit `af8f72e`.
