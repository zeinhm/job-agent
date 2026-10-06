# Phase 1 backlog: Discovery MVP

Status: approved by the owner on 2026-10-06 with changes (comment on t_338f17d2); changes applied by the PM.
Done when (PLAN.md 8): a daily list of real, remote-eligible postings.
Binding design decisions for all cards: `docs/phase-1-conventions.md` (worktrees, types, HTTP limits, schema, filter rules, digest, QA FAIL loop).
Owner decisions: `docs/decisions.md`, entries dated 2026-10-06.

## Cards (64 total: 7 research, 26 dev, 26 QA, 5 individual audits)

All cards are `todo` and gated behind t_338f17d2. Completing it releases the research cards and card 0.
Merge point = the card that merges into main (QA for medium/low, the auditor for high). Downstream cards wait for the merge point.

| # | Dev / research card | Risk | QA | Audit | Waits for |
|---|---|---|---|---|---|
| R1 | t_e94c6eb7 Research Greenhouse, Lever, Ashby APIs | low | - | - | approval |
| R2 | t_a300c0dc Research web3.career API | low | - | - | approval |
| R3 | t_92e11b3f Research Remotive, RemoteOK, Himalayas, WWR | low | - | - | approval |
| R4 | t_fd541b14 Research HN "Who is hiring" (Algolia) | low | - | - | approval |
| R5 | t_1e9a0c3e Research free daily FX source for IDR | low | - | - | approval |
| R6 | t_26e69a7a Golden set: location + Indonesia labels | low | - | - | approval |
| R7 | t_3713edc3 ATS + slug for each company in config/companies.yaml (output in data/, never committed) | low | - | - | approval |
| 0 | t_60c777a8 Pre-commit hook active + worktree-safe | **high** | t_79aa4394 | t_695ca13e | approval |
| 1 | t_4affb67b Scaffold monorepo (+ .worktrees ignore, hook `prepare`, AGENTS.md "Worktrees") | medium | t_df068e7c | - | 0 |
| 2 | t_1c4a241e Core types, SourceError, config loader (+ `JOB_AGENT_CONFIG_DIR`) | medium | t_4163bdd5 | - | 1 |
| 3 | t_263c9659 DB schema + first migration (5 tables) | medium | t_5ad78703 | - | 2 |
| 4 | t_2ac9f4ac Rate-limited HTTP client + msw harness | **high** | t_5bddcbbe | t_b42d3716 | 1 |
| 5 | t_0ee4b0d5 Discovery runner, source_runs, poll intervals | **high** | t_645df64b | t_945b33f0 | 2, 3, 4 |
| 6 | t_cf5d7920 Greenhouse adapter | medium | t_b91e0080 | - | 2, 4, R1 |
| 7 | t_7e6323cc Lever adapter | medium | t_cb51b7ef | - | 2, 4, R1 |
| 8 | t_e83f59ac Ashby adapter | medium | t_1215344b | - | 2, 4, R1 |
| 9 | t_3654c586 web3.career adapter (docs-shape fixture OK) | medium | t_219450c4 | - | 2, 4, R2 |
| 10 | t_a2ab4f25 Remotive adapter | medium | t_81b5da2d | - | 2, 4, R3 |
| 11 | t_44be3ba1 RemoteOK adapter | medium | t_f64ed11b | - | 2, 4, R3 |
| 12 | t_6b3ccf13 Himalayas adapter | medium | t_1a01099f | - | 2, 4, R3 |
| 13 | t_7762821c We Work Remotely RSS adapter | medium | t_1acae87e | - | 2, 4, R3 |
| 14 | t_b77fea1a HN "Who is hiring" adapter | medium | t_b86f7f6e | - | 2, 4, R4 |
| 15 | t_e6e46c8e Normalization | medium | t_80bb1d56 | - | 2, 3 |
| 16 | t_23700548 Cross-source dedupe | medium | t_80c68f7c | - | 15 |
| 17 | t_97bdc85f FX rate fetch + storage | medium | t_5cf0019d | - | 3, 4, R5 |
| 18 | t_e3627e4a Salary parsing + IDR/month normalization | **high** | t_0f8e4dfc | t_ee6f807a | 15, 17 |
| 19 | t_53e40c35 Location filter + golden set (creates `filters/keywords.ts`) | medium | t_9ea4fe9d | - | 15, R6 |
| 20 | t_5f8224a0 Indonesia rule filter + golden set (extends `keywords.ts`) | medium | t_3e75fac1 | - | 15, 18, **19**, R6 |
| 21 | t_5645d748 Salary floor filter | **high** | t_66099c56 | t_ce0c33c4 | 18 |
| 22 | t_b7a7cd40 `process` command (normalize -> filters -> analysis) | medium | t_bc27b1df | - | 5, 16, 19, 20, 21 |
| 23 | t_55542219 Daily digest (markdown in data/digests/) | medium | t_e073141b | - | 22 |
| 24 | t_5777d0f2 End-to-end fixture test (all 9 adapters) | medium | t_3a40cd7e | - | 23, 6-14 |
| 25 | t_383cf304 Cron example + run docs | low | t_0644f1a1 | - | 24 |

Order: research + hook card start in parallel -> scaffold -> core types / HTTP -> schema -> adapters, normalize, FX -> dedupe, salary -> location -> Indonesia, floor -> process -> digest -> e2e -> docs.
Critical path: 0 (+QA, audit) -> 1 -> 2 -> 3 -> 15 -> 18 (+audit) -> 21 (+audit) -> 22 -> 23 -> 24 -> 25.
Audits: 5 individual (high). 20 medium + 1 low merges -> about 4 batch audits during the phase, then the phase-end audit (PM creates it when card 25 merges, incl. a full live pipeline run).
Out of Phase 1 (owner, 2026-10-06): SmartRecruiters, Workable, Recruitee, Arbeitnow -> Phase 2; Reddit, Threads -> Phase 3.

## Changes after owner review (2026-10-06)
- Worktrees: every dev/QA/auditor run works in `.worktrees/`; the main checkout stays on main and is the only merge point. Rules in the conventions doc; the scaffold card copies them into AGENTS.md.
- New card 0 (high): `core.hooksPath` was not set in this clone, so the pre-commit hook never ran. Also, inside a worktree `config/private-patterns.txt` does not exist, so the personal-string check would be skipped silently. Card 0 fixes both; the scaffold waits for it.
- New R7: finds each company's ATS + slug. Its output is personal data, so it goes to `data/research/` and is never committed.
- Card 20 now waits for card 19, because both write the single keyword module (owner: one module with tests). This also removes a merge hotspot.
- Card 2 adds `JOB_AGENT_CONFIG_DIR`, so live runs from a worktree can read the main checkout's config.
- Card 9 completes with a docs-shape fixture instead of blocking for the token.
- Research docs and the PM planning docs are committed straight to main (docs only).

## Risks
- **Hook inactive until card 0 merges.** Research commits to main start right away. They contain no personal data by design, but nothing enforces it until then (see request 2 below).
- **Merge hotspots:** `packages/sources/src/registry.ts` (9 adapters each add a line) and `packages/pipeline/src/cli.ts` (4 commands). QA resolves by keeping every entry.
- **Thin signals without an LLM:** most postings list no salary and no HQ, so many will be kept with `salary_unknown` / `indonesia_unclear` / `location_unclear` flags. Expected for Phase 1; Phase 2 adds LLM extraction and company research.
- **HN parsing** is free text; expect many `unclear` items from that source.
- **Golden-set quality:** labels come from the researcher (Haiku). Judgment rows are marked for your review.
- **web3.career** is built on a docs-shape fixture until you record a real one.
- **Live traffic** in Phase 1 is limited to one fixture recording per source, R1/R7 verification requests, QA smoke runs, and the phase-end audit, all at 1 request per 2 s per host or slower.

## What I need from you
1. **One running card per profile:** set this in the dispatcher (your decision 1). I can't change it.
2. **Optional, recommended now:** run `git config core.hooksPath .githooks` in the repo root, so the hook protects research commits before card 0 merges.
3. **After R7 completes:** review `data/research/t_3713edc3-companies.yaml` and copy the entries you want into `config/companies.yaml`.
4. **Before the first live run (phase-end audit):** put `WEB3_CAREER_TOKEN` in `.env` and run `pnpm --filter @job-agent/sources record:web3career` to replace the docs-shape fixture.
5. **Veto if you disagree:** the PM commits its own planning docs (`docs/phase-*.md`, `docs/decisions.md`) straight to main, the same way the researcher commits research docs. Logged in decisions.md.
