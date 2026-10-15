# Phase 4 fix round: backlog

Planned 2026-10-16 by the PM (card t_2c956655) from the owner's decisions on `docs/phase-4-report.md`.
No owner gate: the owner already decided every item (`docs/decisions.md`, 2026-10-16 "Phase 4 fix round").
Review levels follow the owner's card: QA plus an individual audit for R1, A2 and A3 (the auditor merges); QA only for the
hardening card (medium, QA merges), which the short re-audit #11 covers.

## Owner items and where they go

| # | Owner item | Card |
|---|---|---|
| 1 | R1 (MAJOR): tests never start the real JobSpy worker | F1 |
| 2 | A2: salary wordings; never covered by a bank answer; no answer form in the inbox | F2 |
| 3 | A3: any edit or inbox link clears approval | F3 |
| 4 | A1: seed-demo realpath and non-demo refusal | F4 |
| 5 | A4: answers export 0600 | F3 (same file as A3, `answers-store.ts`) |
| 6 | A5: tags and ledger | done in this planning commit (decisions.md entries, ledger reset); re-audit #11 checks it |
| 7 | Optional: batch 8 MINOR-3 (question fetch redirects), batch 9 `registry.ts:15` | F4 |

## Cards

| Id | Dev | QA | Audit | Risk | Priority | Title | Depends on |
|---|---|---|---|---|---|---|---|
| F1 | t_af1e9656 | t_f9416d19 | t_1f11c7d9 | high | 10 | Tests never start the real JobSpy worker: injectable worker, test-runner guard, fake worker in every test | - |
| F2 | t_e8dd3801 | t_fdd8278c | t_cb0b85be | high | 9 | Salary questions: catch every pay wording; never covered by a bank answer; no answer form in the inbox | - |
| F3 | t_aaa0bf00 | t_71b92c4c | t_71cebab7 | high | 8 | Answer bank: any edit or inbox link clears approval until the owner approves again; answers export written 0600 | F2 audit (both edit `inbox.ts`) |
| F4 | t_22582616 | t_ab8227b6 | - | medium | 6 | Hardening: seed-demo realpath and non-demo refusal; question fetch stays on the ATS host; pay-policy owner guard test | - |

Then:
- t_7811202c **Re-audit #11: Phase 4 fix round** (auditor). Parents: the three audit cards and F4's QA card. Reviews
  `git diff 33b53d0..main`, status of every item, R1 fake-venv proof, `bin/smoke --demo`, break checks, clears F4's ledger row.
  The title's `#11` makes the automation create the new tag `audit-11` and save the report as `docs/audits/batch-11.md`.
- t_1267839f Phase 4 fix round report (pm): a "Fix round" section in `docs/phase-4-report.md`.
- t_92a11042 Phase 4: owner review after the fix round (owner). The earlier review card t_acf2f9cd stays open.

Card bodies and the creation script: `data/handoff/p4fix/` (gitignored).

## Rules every card repeats
- No `pnpm test` / `pnpm check` in the repo root checkout until F1 merges (it has the owner's JobSpy venv); worktrees only.
- Live checks only with `bin/smoke` / `bin/smoke run <dir> <command>`; never env-prefixed commands; never `--with-jobspy`.
- No `config/` edits; example-file changes go under "Owner applies" in the dev report.

## Assumptions (PM)
- F1 keeps the guard in the single spawn place (`createSpawnRunner`) with no off switch; tests that need the spawn path inject a fake
  spawn function. The R1 proof uses a fake executable `python` in a worktree's `workers/jobspy/.venv/bin/`, never a real venv.
- F2: a false positive (a non-pay question treated as salary) is safe, it stays in review; a false negative is not. Reclassifying old
  stored inbox rows is part of F2.
- F3: approval is a separate action; an edit request that also says `approved: true` still clears approval (decisions.md entry).
  `approved: true` in the owner's own `answers.yaml` remains an approval on import.
- F4: the owner's "refuse any DB that holds a non-demo posting" conflicts with today's `bin/smoke --demo`, which seeds after
  discover. F4 changes `--demo` to seed the fresh DB first (or an equivalent that keeps the rule); re-seeding an existing smoke dir
  with public postings is then refused.
- A5 was done by the PM in this commit because it is docs only (ledger and decisions); the auditor still checks it.
- Fix cards are normally always high risk (decisions.md 2026-10-06). The owner's card asked for individual audits only for R1, A2
  and A3, so F4 is medium; this is recorded as an owner decision for this round only.

## Open questions for the owner
None blocking. One recommendation (no card, automation is yours): drop `-f` from `git tag -f` in `bin/agent-step:160`, so an audit
tag can never be moved again (decisions.md 2026-10-16 "Audit tags").
