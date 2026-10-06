# Decisions log (append-only)

Format: `YYYY-MM-DD | decision | why | who`

2026-10-06 | Target remote worldwide incl. Web3; exclude Indonesian companies except foreign ones hiring Indonesians | career goal | owner
2026-10-06 | Salary floor and tiered asks (PLAN.md section 5); values kept in private config/salary.yaml | realistic local market; personal numbers stay out of the public repo | owner
2026-10-06 | No automation of any kind on LinkedIn accounts | account is too valuable to risk | owner
2026-10-06 | Semi-automated applying for JobStreet and YC only; human always clicks submit | lower risk, password never stored | owner
2026-10-06 | Built by a Hermes agent team (pm, researcher, dev, qa, auditor) via Kanban | autonomy with phase gates | owner
2026-10-06 | All roles via Anthropic API directly (prompt caching); PM and Auditor on Claude Opus 5.5, QA on Claude Sonnet 5.5 (cost) | strongest reviewer quality; auditor independence comes from fresh context, re-run evidence, break-the-code checks and golden sets | owner
2026-10-06 | Dev delegates coding to Claude Code (owner's subscription) | best coding quality, familiar tool | owner
2026-10-06 | Risk-based auditing: high risk audited individually before merge; medium batch-audited every 5 merged, low every 10; phase-end audit covers the rest; fix tasks always high risk | keeps full audit coverage while sharing setup overhead; Opus effort where mistakes hurt | owner
2026-10-06 | Public repo: personal data (CV, answers, salary, companies, outputs) kept in gitignored config/ and data/; only *.example files committed; pre-commit hook enforces it | repo is public | owner
2026-10-06 | Per-task git worktrees under gitignored .worktrees/: dev in .worktrees/<task-id> on its task branch; qa/auditor in detached .worktrees/<task-id>-review; the main checkout always stays on main and is the only place merges happen; final reviewer removes worktrees after merge; one running card per profile for now | parallel cards share one repo checkout | owner
2026-10-06 | Phase 1 sources = Greenhouse, Lever, Ashby, web3.career, Remotive, RemoteOK, Himalayas, We Work Remotely, HN. SmartRecruiters, Workable, Recruitee, Arbeitnow move to Phase 2 (with company discovery); Reddit and Threads move to Phase 3 | keep Phase 1 small | owner
2026-10-06 | On-site or hybrid postings with no remote option are location class `restricted` | PLAN targets remote roles | owner
2026-10-06 | Rule keyword lists (location, Indonesia) live in code, all in one dedicated module with its own tests, not in config | config/ is human-owned; one place to review the lists | owner
2026-10-06 | Phase 1 digest is a markdown file under data/ only; delivery channel stays open (PLAN 9) | channel not chosen yet | owner
2026-10-06 | web3.career adapter is built and tested against fixtures without a live token; owner adds WEB3_CAREER_TOKEN before the first live run | token not available yet | owner
2026-10-06 | config/companies.yaml holds names only; a research card finds and verifies each company's ATS and slug. Its output is personal data: written under data/research/, never committed; the owner copies verified entries into config/companies.yaml | company list is private (AGENTS.md public-repo rules) | owner + pm
2026-10-06 | Researcher commits research docs directly to main (docs/research/ only, nothing else) | every worktree sees research without waiting for a dev branch | owner
2026-10-06 | PM commits its own planning docs (docs/phase-*.md, docs/decisions.md) directly to main, docs only | worktrees branch from main and need the binding conventions doc | pm (owner may veto)
2026-10-06 | Pre-commit hook must be activated (core.hooksPath) and must read private patterns from the main checkout, so it also protects commits made in worktrees; added as a high-risk card before the scaffold | hook was not active in this clone, and config/ does not exist inside worktrees, so the pattern check would be skipped silently | pm
2026-10-06 | Env JOB_AGENT_CONFIG_DIR overrides the config dir (default `config`), like JOB_AGENT_DB for the DB | live runs from a worktree need the main checkout's config/ | pm
