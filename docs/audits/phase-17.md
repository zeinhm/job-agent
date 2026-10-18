# Phase-end audit #17: Operator role (t_29710695)

Scope: `git diff audit-15..HEAD` on main e6a005a (108 files), weight on operator cards O1-O7. Ledger has 3 rows (t_beb259c9, t_39042252, t_e8589b68); all are inside this diff and were read as part of it.

Verdict: **PASS** (no BLOCKER or MAJOR; 3 MINOR).

## What I ran
- `pnpm install --frozen-lockfile`, then `pnpm check` on a fresh checkout of main: exit 0 (typecheck, lint, vitest, `bin/test-*.sh`; tail showed `51 passed, 0 failed` for operator-dispatch and `OK` for the last python suite).
- Mutation: replaced `windowFull: recent.length >= OPERATOR_WINDOW_RUNS` with `false` in `packages/apply/src/operator-batch.ts`. `vitest run packages/pipeline/src/dry-run.operator.test.ts` exited 1, so the 24 h cap is pinned by a test. Reverted with `git checkout -- .`.
- Check 1, end to end on `bin/smoke --demo` (dir under $TMPDIR) with `bin/smoke run`:
  - `dry-run-candidates --limit 5` -> `dry-run-candidates: no candidates` (the public smoke postings have no kept intel row, as designed).
  - `operator-dry-run b1 demo-1` -> `operator-dry-run: refused: a real form is only opened with the real database`, exit 2, as designed.
  - `dry-run-report --last 4` printed the three fixture runs and a demo run: ids, JSON-quoted labels, enum values, answer-key names only. No fake-persona value (name, email, phone, salary, free text) appeared in any line; `note: other` hides unknown notes.

## Check 2: permissions and D2 guard
- `git diff audit-15..HEAD --stat -- request-guard.ts page-guard.ts` is empty: both guards are unchanged. `session.ts` changed (fallbackUrl once after a redirect-away stop, `pickSuggestion`, starter written with the run row). The suggestion pick is a plain click on `[role=option]` / `.dropdown-location` after `inspect(option)`; the guards still abort every non-GET request, and the decision text matches.
- `.claude/roles/operator.json`: allow list is `bin/operator:*`, `hermes kanban list|show`, `Edit(./data/handoff/**)` only. I compared the project `settings.json` allow list entry by entry (pnpm, npx, node, bin/smoke both forms, git, ls, cat, head, tail, wc, grep, rg, find, mkdir, mktemp, cp, mv, jq, sqlite3, curl): every one has a matching deny in operator.json, and deny wins over allow. `Read(./data/**)`, `./config/**`, `./.env*`, `~` secrets, `*.png|jpg|jpeg|webp`, `*.db*` are denied.
- `bin/cc-run` runs the operator with `--permission-mode dontAsk`, never merges the owner's overrides for it, and aborts if the role file is missing. `merge-settings.jq` keeps the union of deny lists for the other roles.
- `bin/operator`: fixed regexes for every argument, nothing echoed, stderr dropped, card/note/release text only from a regular, non-symlink, size-limited `data/handoff/<batch>-<slug>.md`; release refuses `.owner` holds, `OWNER` and `Operator fix` titles; only the three whitelisted CLI commands can run.
- Batch limit is in code (`operator-batch.ts`), and since the agent picks the batch id, a rolling 24 h cap of 10 runs and a 24 h CAPTCHA halt cover every batch id. The CAPTCHA halt and limits sit under the lock.

## Check 3: docs
- decisions.md entries 2026-10-18 (operator role, real forms for the operator only, review levels, O1-O6 entries) match the owner decisions recorded on the card; AGENTS.md adds the table row, the real-form exception limited to `bin/operator run`, the backup line and the answer-key rule. The diff of AGENTS.md and common.md is additive only; the other roles' rules are unchanged (their role files gained only `bin/test-*` allows).

## Check 4: one helper, one rule, one lock
- Output: `safe-output.ts` (`errorLine`, `refusalLine`, `sanitizeText`) is used by dry-run, operator-dry-run, report and candidates. The remaining `e.message` prints in `cli.ts` belong to commands that `bin/operator` cannot reach.
- Candidate rule: `isDryRunCandidate` is called by both `dry-run-candidates` and `operator-dry-run`; `grep` finds no copy.
- Lock: `tryAcquire` / `acquireOwner` / `ownerWaiting` live only in `dryrun/lock.ts`; no dashboard path opens a real form.

## Findings
1. **[MINOR] packages/pipeline/src/dry-run-report.ts:180** `started_by` NULL (existing rows, owner runs per decision 7: "NULL = owner") prints `by=other`, and fixture runs show `by=other` too. The operator cannot tell owner runs from unknown ones. Reproduce: `bin/smoke run <dir> dry-run-report --last 4` on a `--demo` dir. Fix: print `by=owner` for NULL.
2. **[MINOR] Permission set is proven by static tests only.** `bin/test-operator-live.sh` needs a real `claude` run and is owner-run, not in `pnpm check`; I did not run it (it spends the plan and the run is unattended). Residuals the decision already admits: the Write tool can overwrite another card's file in `data/handoff/`; Read denies cover Grep/Glob only on a best-effort basis in Claude Code. Suggest the owner runs the live test once before the first real batch and again after any Claude Code upgrade.
3. **[MINOR] packages/pipeline/src/dry-run.ts:390** `operator-dry-run` checks `isDryRunCandidate` plus `prepareRealRun`, but not the list-only checks (canonical posting, `analysis.decision = keep`). The operator could name a duplicate posting id by hand and it would run. Low impact (it still has to pass the safety rule and be an ATS job link); optionally move `canonical_posting_id IS NULL` into the shared rule.

## Fix tasks
- (low) report: print `by=owner` for NULL `started_by` and fixtures; adjust `dry-run-report.test.ts`.
- (low) `operator-dry-run`: refuse a non-canonical posting (shared rule or explicit check) with a test.
- (owner action, no card) run `bin/test-operator-live.sh` once before the first real operator batch.

Audit tag: set `audit-17` at e6a005a on PASS; ledger rows above are covered.
