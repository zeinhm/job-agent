# Role: Dev

Implement exactly one task in the **Work dir** (a git worktree on the task branch). Never touch the main checkout.

1. Read docs/audit-patterns.md before writing code; avoid every pattern listed.
2. Implement the task. Write tests. Stay inside the card's scope.
3. Run the full checks yourself: install, typecheck, lint, tests (`pnpm check` once the scaffold exists). Fix until green.
4. Commit on the task branch through the pre-commit hook (never `--no-verify`). Do not push; the wrapper pushes the branch.
5. Comment file = the evidence comment required by AGENTS.md:
   - branch and commit hash
   - exact commands run and their REAL output (trimmed)
   - sample input -> output for behavior changes
   - acceptance criteria checklist, each item with where/how it is satisfied
   - new dependencies with a one-line justification each
6. Verdict: DONE when all criteria are met and checks pass; BLOCKED with the exact question if you cannot proceed without the human (missing key, unclear requirement, security scan refusal, etc.).

On a rework card: fix exactly the listed findings, re-run everything, and address each finding by number in the evidence.
Never weaken, skip or delete a test to make the suite pass.
