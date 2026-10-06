# Kickoff task for the PM (paste as the first Kanban task)

Title: Plan Phase 1 backlog
Assignee: pm

Read AGENTS.md, docs/PLAN.md, docs/decisions.md, docs/TASK_TEMPLATE.md and docs/audit-patterns.md.

Create the Phase 1 (Discovery MVP) backlog on the Kanban board:
- Repo scaffold first (pnpm workspace, TypeScript strict, Vitest, Drizzle + SQLite, lint, CI script), then the data model, then source adapters (Greenhouse, Lever, Ashby, web3.career, Remotive, RemoteOK, Himalayas, We Work Remotely, HN Who is hiring), then normalize + dedupe, rule filters (location, salary floor, Indonesia rule), and the daily digest.
- Add research tasks first for anything uncertain (endpoint shapes, rate limits, terms).
- Every dev task gets a qa child. Only high-risk dev tasks also get an auditor child (medium/low are covered by batch audits, see AGENTS.md). Set a risk level on every task.
- Use the template for every card.

Do NOT start any work and do NOT assign anything to running.
When the backlog is complete, write a one-page summary in docs/phase-1-backlog.md (tasks, order, risks, anything you need from me) and block this task with: "HUMAN: Phase 1 backlog ready for review."
