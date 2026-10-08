# Phase 2 backlog: Intelligence

Status: planned 2026-10-08 by the PM (card t_547a7b6d); waiting for owner approval on gate **t_ade0f064**.
Done when (PLAN.md 8): a ranked digest where each posting shows why it scored what it did.
Binding design decisions for all cards: `docs/phase-2-conventions.md` (plus `docs/phase-1-conventions.md`).
Inputs: `docs/phase-1-report.md`, `docs/phase-1-live-findings.md`, decisions.md 2026-10-08 (Haiku 5.5 bulk, Sonnet fit,
$1/day hard cap).

## Cards (64 total: 1 gate, 1 housekeeping, 6 research, 25 dev, 25 QA, 3 individual audits, phase-end audit, report, owner review)

All cards are `todo` behind the gate. Merge point = the card that merges into main (QA for medium/low, the auditor for
high). Downstream cards wait for the merge point.

### Gate, housekeeping, research
| # | Card | Assignee | Risk | Waits for |
|---|---|---|---|---|
| G | t_ade0f064 Phase 2: owner approves the plan | owner | - | - |
| H | t_fd9f8138 Housekeeping: tag audit-1, clear the Phase 1 ledger, save the phase-end-1 report | auditor | low | G |
| R1 | t_01c08cc2 Anthropic API for Phase 2 (prices, structured output, caching, budget) | researcher | low | G |
| R2 | t_250e744a Search API for company discovery (provider, cost, terms, queries) | researcher | low | G |
| R3 | t_bb8a60de SmartRecruiters, Workable, Recruitee, Arbeitnow APIs | researcher | low | G |
| R4 | t_b3a4ccf6 Golden set: role relevance | researcher | low | G |
| R5 | t_dee70d65 Golden set: pay context and tier (incl. US pay-transparency trap) | researcher | low | G |
| R6 | t_080347c5 Golden set and signals: scam detection | researcher | low | G |

### Dev cards
| # | Dev card | Risk | QA | Audit | Waits for |
|---|---|---|---|---|---|
| 1 | t_7d626c81 Phase 2 DB schema (intel, llm_calls, columns, ATS enums) | medium | t_cae43d24 | - | G |
| 2 | t_3765117e Role relevance filter + golden set | medium | t_baced97c | - | R4 |
| 3 | t_38151c18 Location: country lists / "Remote, <country>" restricted | medium | t_3c99ef35 | - | G |
| 4 | t_0f390819 HN: top-level comments only | medium | t_423e1b94 | - | G |
| 5 | t_08e114f8 web3.career: follow the 302 | medium | t_15e6e048 | - | G |
| 6 | t_0860cdb9 Digest: group same company + title | medium | t_06b0345d | - | G |
| 7 | t_67544a8a Refresh edited postings | medium | t_2b446488 | - | 1 |
| 8 | t_1f6911e8 bin/smoke: all keyless sources + digest | low | t_dcd96c9b | - | G |
| 9 | t_ceb93412 Anthropic client, spend ledger, $1/day cap | **high** | t_5c70035a | t_c1dbcba2 | 1, R1 |
| 10 | t_0d85cc05 Extraction (Haiku) + `enrich` command | medium | t_59f4240f | - | 9, R5, R6 |
| 11 | t_d56b8ff0 Resolve unclear flags from extracted facts | medium | t_d498e130 | - | 10, 2, 3 |
| 12 | t_736df3a8 Pay-policy registry | medium | t_5e74da2c | - | 10 |
| 13 | t_63f270d0 Company pay-policy research (careers pages) | medium | t_d15a0e30 | - | 12 |
| 14 | t_4941a83b Scam scoring | **high** | t_8b9004fc | t_5e68bd09 | 10, R6 |
| 15 | t_766d6b7c Fit scoring vs CV (Sonnet) | medium | t_7d57ab9e | - | 10, 14 |
| 16 | t_72aefdac Tier + salary ask (PLAN 5.3) | **high** | t_e3d8931f | t_ba795f8c | 12, 11, R5 |
| 17 | t_73f6affa Ranked digest with a why line | medium | t_c05fd815 | - | 6, 11, 14, 15, 16 |
| 18 | t_5bac0f79 SmartRecruiters adapter | medium | t_8219cd90 | - | 1, R3 |
| 19 | t_b313841a Workable adapter | medium | t_67c15c09 | - | 1, R3 |
| 20 | t_e239af67 Recruitee adapter | medium | t_06128aa0 | - | 1, R3 |
| 21 | t_3f99932a Arbeitnow adapter | medium | t_fec021b2 | - | R3 |
| 22 | t_9dcff684 Poll discovered companies from the DB | medium | t_02784821 | - | 1 |
| 23 | t_f6f3b14c Company discovery via search API | medium | t_b81ee338 | - | 22, R2 |
| 24 | t_a8d69efd End-to-end test, Phase 2 pipeline | medium | t_8e92bcdc | - | 17, 23, 7, 18-21, 13 |
| 25 | t_b7afa306 Run docs, cron, env example | low | t_40d2bf1a | - | 24, 8 |

### End of phase
| Card | Assignee | Waits for |
|---|---|---|
| t_f2397696 Phase-end audit #2: Phase 2 (incl. live `bin/smoke`) | auditor | every merge point above |
| t_3f287cb1 Phase 2 report | pm | phase-end audit |
| t_a2206a16 Phase 2: owner review | owner | report |

## Order
Approval -> research, housekeeping, schema, rule fixes (2-6), smoke in parallel -> LLM client (+audit) -> extraction ->
resolve / registry / scam (+audit) -> fit, tier (+audit), company research -> ranked digest. Sources (18-23) run in
parallel with the LLM path once the schema and R2/R3 land. Then e2e -> docs -> phase-end audit -> report -> review.

Critical path: G -> R1 -> 1 -> 9 (+QA, audit) -> 10 -> 14 (+QA, audit) -> 15 -> 17 -> 24 -> 25 -> phase-end audit.
Audits: 3 individual (LLM cap, scam, tier/ask). 20 medium + 2 low merges -> about 4 batch audits during the phase
(PM creates them from the ledger), then the phase-end audit.

## Risks
- **Rule changes reject more postings.** Role and location fixes cut volume before the LLM, which is the point, but a
  wrong keyword silently drops good jobs. Golden sets with judgment rows marked for the owner; the digest counts rejects
  per rule.
- **No live LLM run by agents.** All LLM tests use hand-built Messages API fixtures; prompt quality is only proven when
  the owner runs `enrich` (or the `eval:<stage> --live` scripts) with a key. Expect a prompt-tuning card in Phase 3 or
  after the owner review.
- **Budget:** $1/day may not cover every kept posting on a busy day. Newest first, fully scored; the rest wait
  (`budget_wait`) and show under "Waiting for scoring".
- **Merge hotspots:** `enrich.ts` (stages 10-16), `keywords.ts` (2, 3, 14), `registry.ts` (18-21), `cli.ts` (10, 23),
  `digest/` (6, 17). QA keeps every entry when resolving.
- **Research quality:** golden sets are labelled by the researcher (Haiku); judgment rows need the owner's eye.
- **Search API cost** depends on R2 and your approval; discovery skips cleanly without a key.
- **Board priority:** I assumed a higher `--priority` number runs first (gate 10, housekeeping 9, research 8, rule fixes
  and the critical LLM path 7, other dev 5-6, docs 4).

## What I need from you (also on the gate card)
1. `ANTHROPIC_API_KEY` in your environment before your first live `enrich` run (agents never use it).
2. `config/cv.md` before the fit-scoring card lands.
3. Approve the search API provider and monthly cost after R2; add its key.
4. Confirm or change the role relevance rule (conventions "Role relevance").
5. Confirm the scam threshold (60/100) and the careers-page lookup (max 2 pages per company per 90 days).
6. Say if you want the phase-end audit to run one live `enrich` (default: no, you run it in the owner review).
7. Confirm out of scope: salary observations / outcome learning (Phase 6), digest channel, instant alerts, YC (Phase 3).
