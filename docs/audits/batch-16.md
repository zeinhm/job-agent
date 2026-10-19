# Batch audit #13 (audit-17..a42dc36)

Scope: 50 files, +1676/-163, the cards listed on t_80be9abf (operator pacing/limits/stdin bodies, merge-backup fail-closed,
dispatch blocked-batch handling, Greenhouse helper/education fields, location autocomplete tie-break, readback compare,
description-language + Spanish/Portuguese on-site rules, digest location gate, role allow lists).

## Setup (HEAD = origin/main a42dc36)
- `pnpm install --frozen-lockfile` ok; `pnpm typecheck` (tsc -b) clean; `pnpm lint` "ESLint: No issues found".
- `pnpm test`: 170 files, 3193 tests passed.
- `bin/test-operator-dispatch.sh` 62/0, `bin/test-operator.sh` 86/0, `bin/test-backup.sh` 33/0.

## Breadth
- Personal data / secrets: grep of added lines for emails, phone shapes, key/password: nothing. Fixtures use a fake persona.
- Guardrails: operator stays headed, D2 guard untouched, pacing and daily ceiling enforced in code (not prompt). No LinkedIn,
  CAPTCHA halt kept (`captcha_stop`). New answer keys (`misc.contractor_note`, `misc.cover_letter_text`) are names only.
- Drift: decisions.md has an entry for each behaviour change; the 30 -> 100 ceiling change is a new appended entry (ok).
- Cross-task consistency: refusal codes in `OperatorRefusalCode`, `bin/operator` and the prompt table agree.

## Break-the-code checks
- `pacingWaitSeconds` forced to return 0 -> 3 tests in dry-run.operator.test.ts fail (guarded). Reverted.
- `operator_open_card` counting blocked cards again -> 6 failures in bin/test-operator-dispatch.sh (guarded). Reverted; tree clean.

## Deep dives
Operator pacing/limits/stdin (highest risk to the owner: real employer forms and IP) and the dispatch blocked-batch supersede.
Read line by line: pacing is checked last under the lock, the lock is freed on wait (exit 75), at most 3 sleeps of <=120 s,
retry only on the exact `waiting:<n>` line; the window check refuses before any form opens; stdin bodies are size/NUL checked
and written via temp file + mv, symlink refused.

## Findings
- [MAJOR] prompts/roles/operator.md:88-92 vs .claude/roles/operator.json:7: the prompt now says the operator must "never use the
  Write or Edit tool", yet "Your report" still requires it to write the Comment file (in data/handoff/), and operator.json still
  allows `Edit(./data/handoff/**)` (kept by the revert, pinned by operator-role.test.ts). An operator that obeys the prompt
  writes no report file, the failure t_a46e5c28 set out to fix (batch t_c672442e left no report). `bin/operator` only covers
  card/note/release bodies, not the Comment file. Fix: reword the prompt ("the only file you write is the Comment file; card and
  note bodies go through stdin") or give the report a stdin path too.
- [MINOR] bin/step-git.sh `has_backup_line`: the trailing comment is duplicated (copy/paste); cosmetic.
- [MINOR] filters/keywords.ts ONSITE_DESCRIPTION_PHRASES: "oficina"/"escritorio"/"escritório" are weak signals; with no remote
  or worldwide wording anywhere they settle the location as `restricted`. Guarded by the no-remote condition; watch for false
  restricted rows after `process --reprocess`.
- [MINOR] bin/operator reads `OPERATOR_NOW` from the environment for the window check. The role cannot set env vars, so no
  practical bypass, but it is a test seam in the production path.
- Note: `process --reprocess` (t_fdcdde15) rewrites analysis rows; the decision carries the OWNER backup line, handled by the
  merge automation hardened in t_bfb86593.

## Verdict
One MAJOR (prompt contradiction), no BLOCKER. FAIL per the batch rules; the fix is small.

## Fix tasks
1. **Operator prompt: allow writing the Comment file** (high, role/prompt change): resolve the contradiction in
   prompts/roles/operator.md ("never use the Write or Edit tool" vs "Write it to the Comment file"), keep
   operator-role.test.ts consistent, and add a check that the prompt and operator.json agree on the write path. Owner applies any
   operator.json change.
2. (low, optional) Remove the duplicated comment in bin/step-git.sh `has_backup_line`; honour `OPERATOR_NOW` only under a test flag.
