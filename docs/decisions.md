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
