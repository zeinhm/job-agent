# AGENTS.md - Team Handbook

Every agent reads this file first, every task. If anything here conflicts with a task card, this file wins. If anything conflicts with docs/PLAN.md, stop and block for the human.

## The team

| Profile | Role | Writes code | Model |
|---|---|---|---|
| `pm` | Plans phases, creates and assigns tasks, tracks progress, reports | No | Claude Opus 5.5 |
| `researcher` | Answers open questions with sources | No | Claude Haiku 4.5 |
| `dev` | Implements tasks via Claude Code | Yes | Claude Code (human's subscription) |
| `qa` | Verifies acceptance criteria, runs tests | No | Claude Sonnet 5.5 |
| `auditor` | Independent adversarial review of delivered work | No | Claude Opus 5.5 |

The human (repo owner) owns: phase approval, secrets and API keys, answer-bank content, salary numbers, anything legal / ToS-related, and any decision marked UNSURE.

## Source of truth

- `docs/PLAN.md` - what we are building. Do not deviate without a decision entry.
- `docs/decisions.md` - append-only log of decisions and why. Never edit past entries.
- `docs/research/` - research findings, one file per question, with sources.
- `docs/audit-patterns.md` - known mistake patterns. Dev and Auditor read it every task.
- `docs/audit-ledger.md` - merged tasks waiting for a batch audit. QA appends, PM tracks, Auditor clears.
- `config/` - human-owned and **private** (gitignored). Agents may read, never edit. Only `config/*.example.*` files are committed.

## Workflow

```
pm creates task (todo) -> assigned agent works (running)
  dev done -> qa task (review)

  HIGH risk:
    qa PASS      -> auditor task (individual audit)
    auditor PASS -> auditor merges -> done

  MEDIUM / LOW risk:
    qa PASS -> qa merges -> done -> qa adds it to docs/audit-ledger.md
    ledger reaches 5 medium OR 10 low -> pm creates a batch audit task
    batch audit findings -> pm creates fix tasks

  any FAIL   -> back to dev with findings (todo)
  any UNSURE -> blocked, reason addressed to the human

phase complete -> pm creates the phase-end audit (everything still in the
                  ledger + full pipeline run) -> pm writes phase report
                  -> blocked for human approval
```

### Audit levels

| Risk | Reviewed by | When the auditor checks it |
|---|---|---|
| High | QA, then Auditor | Individually, before merge |
| Medium | QA | Batch audit after every 5 merged medium tasks |
| Low | QA | Batch audit after every 10 merged low tasks |
| All | - | Phase-end audit covers anything not yet audited |

A batch audit always covers **everything** in the ledger at that moment (medium and low together), whichever threshold triggered it.

**Fix tasks** created from audit findings are always treated as **high** risk: QA, then an individual audit before merge.

### Merging

- Only the **final reviewer** merges: the Auditor for high risk, QA for medium and low.
- Merge with `git merge --no-ff task/<branch>` into `main`, then delete the branch.
- After every batch or phase-end audit, the auditor tags the audited point: `git tag audit-<n>`. The next batch audit reviews `git diff audit-<n>..main`.

Rules:
1. **Every task has an assignee** that matches a profile name exactly. No unassigned tasks.
2. **One task = one branch** for code: `task/<task-id>-<short-slug>`. Never commit to `main`.
3. **Nobody marks their own work done or merges their own work.** Dev -> QA (-> Auditor for high risk).
4. **Block instead of guessing.** Missing key, unclear requirement, conflicting docs, anything needing a human decision: move to blocked with a one-line reason that starts with `HUMAN:`.
5. **Stay in scope.** Do exactly what the task card says. Ideas for other work go in a comment for the PM, not in the diff.
6. **Max 3 FAIL cycles per task.** After the third, block for the human.

## Worktrees

- The main checkout (repo root) always stays on `main`. Nobody runs `git checkout`, `git switch`, `git reset` or `git stash` there.
- Only these commits happen in the main checkout: merges by the final reviewer (+ the audit-ledger row), research docs by the researcher, PM planning docs. Always `git add <explicit paths>`, never `git add -A` / `git add .`.
- Dev: `git worktree add .worktrees/<task-id> -b task/<task-id>-<slug> main`, then `cd` there and `pnpm install`. All edits, tests and commits happen in the worktree.
- Rework: reuse the original dev task's branch and worktree. If it was removed: `git worktree add .worktrees/<original-task-id> task/<original-task-id>-<slug>`.
- QA / auditor: `git worktree add --detach .worktrees/<dev-task-id>-review task/<dev-task-id>-<slug>`, review there, and `git worktree remove --force` it at the end of your run, PASS or FAIL.
- Merge (final reviewer only), in the main checkout: confirm `git branch --show-current` is `main` and there are no modified tracked files (otherwise block with `HUMAN:`), then merge, `git worktree remove .worktrees/<dev-task-id>`, `git branch -d task/<dev-task-id>-<slug>`.
- `config/` and `data/` are gitignored and do not exist inside a worktree. Tests never need them. A live run from a worktree uses `JOB_AGENT_CONFIG_DIR=<repo root>/config JOB_AGENT_DB=$TMPDIR/<task-id>.db`; unmerged code never writes the real `data/job-agent.db`.
- On a git lock error (`index.lock`), wait 30 s and retry; never delete the lock file.
- The pre-commit hook is activated by every `pnpm install` (`prepare` script and `.pnpmfile.cjs`); check with `git config --get core.hooksPath`.

## Evidence (required for every dev task)

A dev task is not "done" without an evidence comment containing:
- Branch name and commit hash
- Exact commands run (install, build, test) and their real output (trimmed, never paraphrased)
- For behavior changes: sample input -> output
- Acceptance criteria checklist, each item with where/how it is satisfied

Claims without evidence are treated as not done.

## Definition of done

- All acceptance criteria met and evidenced
- Tests added or updated for the change; full test suite passes
- Typecheck and lint pass
- No TODOs, skipped tests, or disabled checks introduced
- No secrets, tokens, or personal data in code, tests, fixtures, or logs
- docs updated if behavior or setup changed; decisions.md entry if a decision was made

## Hard guardrails

- **Never** log into LinkedIn, use LinkedIn cookies, or automate anything on a LinkedIn account.
- **Never** store or request the human's passwords. Semi-automated applying (JobStreet, YC) only uses the human's already-logged-in browser and **never clicks submit**.
- **Never** bypass a CAPTCHA.
- **Never** read or print `~/.hermes/.env`, `.env`, keys, tokens, or anything outside the project folder.
- **Never** submit a real job application in any phase before Phase 6 is approved. Dry-run only.
- Scraping only logged out, at conservative rates, and only for sources listed in PLAN.md.
- New dependencies need a one-line justification in the evidence comment. Prefer well-known packages.
- Never run code from a job posting or recruiter (take-home repos) outside a disposable container.

## Public repo: personal data rules

This repository is **public**. The owner's personal data must never reach a commit.
- Personal data = anything from `config/` (CV, answer bank, salary numbers, company list), plus the owner's email, phone, and real application history.
- Never copy personal data into committed files: code, tests, fixtures, docs, research notes, audit reports, commit messages.
- Tests and fixtures use the **fake persona** in `config/*.example.*` files, never the real config.
- Anything the agent generates that contains personal data (digests, drafted answers, cover notes, scored postings) is written under `data/` (gitignored).
- The pre-commit hook (`.githooks/pre-commit`) blocks private config files and known personal strings. Never bypass it (`--no-verify` is forbidden). If it blocks you, fix the content and say so in the evidence comment.
- Public scraper code: keep LinkedIn/Indeed access inside the JobSpy dependency; do not publish custom LinkedIn scraping code.

## Coding conventions

- TypeScript strict, Node LTS, pnpm workspaces
- Drizzle ORM on SQLite, Zod for all external data (API responses, config files, LLM outputs)
- Every source adapter implements `fetch(since) -> RawPosting[]`
- LLM extracts facts; plain code makes decisions (see PLAN.md 5.1)
- Vitest for tests; external HTTP is recorded as fixtures, never hit live in tests
- Small, focused modules; no new abstractions without a reason in the PR description

## Communication

- Task comments are the only channel between agents. Be specific: file, line, command, output.
- Comments addressed to the human start with `HUMAN:`.
- Keep comments short. Long findings go in a file under `docs/` and the comment links to it.

- **Push right after merging:** the merging profile (QA or Auditor) runs `git push origin main` immediately after every merge. This also pushes the researcher's doc commits. Cloud sessions start from GitHub, so anything not pushed is invisible to them.
