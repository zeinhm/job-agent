# Phase 3 backlog: More sources (plus the owner's carry-over items)

Status: planned 2026-10-14 by the PM (card t_3bbd832d); waiting for owner approval on gate **t_c1c7756b**.
Done when (PLAN.md 8): LinkedIn jobs appear within an hour of posting.
Binding design decisions for all cards: `docs/phase-3-conventions.md` (plus the Phase 1 and Phase 2 conventions).
Inputs: `docs/phase-2-report.md`, owner decisions of 2026-10-14 on t_3bbd832d (carry-over items 1-7, planned first, in
that order), `docs/audits/batch-t_c9a36eac.md`, `docs/digest-quality-backlog.md`.
Card bodies: `data/handoff/p3plan/` (local only).

## Cards (64 total: 2 owner gates, 6 research, 22 dev, 22 QA, 9 individual audits, phase-end audit, report, owner review)

Merge point = the card that merges into main (QA for medium/low, the auditor for high). Downstream cards wait for it.
Higher `--priority` runs first (same assumption as Phase 2): gate 10, carry-overs 9-6 in the owner's order, research 8/6,
sources 5-4, docs and end of phase 3.

### Gates and research
| # | Card | Assignee | Waits for |
|---|---|---|---|
| G | t_c1c7756b Phase 3: owner approves the plan | owner | - |
| TG | t_9b3bd676 Threads: owner provides a token or drops Threads | owner | G |
| R1 | t_5f31fe9d Free apply routes (ATS by name, careers embeds, aggregator links, paid-only sites) | researcher | G |
| R2 | t_a46f63f1 JobSpy for LinkedIn and Indeed | researcher | G |
| R3 | t_c500164f YC jobs and YC directory | researcher | G |
| R4 | t_0c868bbb JobStreet public search | researcher | G |
| R5 | t_788d14a9 LinkedIn hiring posts via Brave Search (incl. storage terms, cost) | researcher | G |
| R6 | t_1efb73a8 Threads keyword search API | researcher | TG |

### Carry-over items (owner order)
| # | Owner item | Dev card | Risk | QA | Audit | Waits for |
|---|---|---|---|---|---|---|
| 1 | 1 | t_56bbe118 Location truth: text restriction beats the source region label | **high** | t_ad1b11fd | t_43b4afc8 | G |
| 2 | 1 | t_fb5c9fac Time zones for GMT+7: residence vs working hours (extract-v7) | medium | t_9bea6f62 | - | 1 |
| 3 | 2 | t_2e9e402a Apply links: schema, `resolve-apply`, ATS lookup by name + title | medium | t_b95555ff | - | R1 |
| 4 | 2 | t_7f305c0c Apply links: careers-page ATS embeds, links in posting text | medium | t_adedc127 | - | 3 |
| 5 | 2 | t_0bfea274 Apply links: Haiku picks among candidates when unclear | medium | t_1446b131 | - | 4 |
| 6 | 2 | t_b7d65734 Save a found ATS to `config/companies.yaml` (append-only, backup) | **high** | t_2b472659 | t_5600e22c | 3 |
| 7 | 3 | t_8e27df96 Re-extract outdated extractions | medium | t_3b968824 | - | 2 |
| 8 | 4 | t_fe52a1af `unknown_tier_ask` from salary.yaml | **high** | t_947007cd | t_68ca5ef2 | G |
| 9 | 5 | t_fa40baa4 Extend the free title deny-list | medium | t_60db0a2b | - | G |
| 10 | 6 | t_d46f2a41 Shorter digest | medium | t_da29ca01 | - | 2 |
| 11 | 2 | t_fbc60316 Digest: Apply, Found on, apply type, paid-only label | medium | t_2e4ca52b | - | 10, 5 |
| 12 | 7 | t_432132ff CLI loads `.env`; hourly schedule with a run lock | **high** | t_26112bec | t_b473104d | 3 |

### Phase 3 sources
| # | Dev card | Risk | QA | Audit | Waits for |
|---|---|---|---|---|---|
| 13 | t_e781cb5e JobSpy worker + LinkedIn adapter, Tier 2 block backoff | **high** | t_4a82eb53 | t_b9e5745e | R2 |
| 14 | t_f6be6d67 Indeed via JobSpy | **high** | t_d4ee2f1f | t_83aaa05c | 13 |
| 15 | t_e9d06901 YC jobs adapter | **high** | t_db1d5282 | t_a03d943b | R3 |
| 16 | t_c26830be YC directory -> ATS polling list | medium | t_82675173 | - | 15, 4 |
| 17 | t_fd830d09 JobStreet adapter | **high** | t_d4f6affc | t_291d6ec0 | R4 |
| 18 | t_74a60bf8 LinkedIn posts via Brave results (no linkedin.com fetch) | **high** | t_1246ae96 | t_cb84cef8 | R5 (+ gate answer 3) |
| 19 | t_72b37d2c Threads adapter | medium | t_537b80e8 | - | R6 |
| 20 | t_4eaabb57 Freshness line (last run, max gap) for LinkedIn / Indeed | medium | t_f3122a27 | - | 14, 12, 11 |
| 21 | t_1700ae4a End-to-end test Phase 3 + `bin/smoke` coverage | medium | t_1e939c32 | - | 6, 7, 8, 9, 16, 17, 18, 20 |
| 22 | t_9192fcfc Run docs, cron and env example | low | t_3a4784b7 | - | 21 |

### End of phase
| Card | Assignee | Waits for |
|---|---|---|
| t_747e3bc8 Phase-end audit #3: Phase 3 (incl. `bin/smoke`, done-when check) | auditor | every merge point above (22) |
| t_0185322f Phase 3 report | pm | phase-end audit |
| t_cff37d06 Phase 3: owner review | owner | report |

## Order
Approval -> research (all six in parallel; Threads after its gate) and the free carry-overs (location truth,
`unknown_tier_ask`, deny-list) -> time zones -> re-extraction and shorter digest; apply links 3 -> 4 -> 5 with the
companies.yaml writer and the schedule after 3 -> digest apply lines. Sources start as soon as their research lands:
JobSpy LinkedIn -> Indeed, YC -> YC directory, JobStreet, LinkedIn posts, Threads. Then freshness line -> e2e -> docs ->
phase-end audit -> report -> review.

Critical path (done when): G -> R2 -> 13 (+QA, audit) -> 14 (+QA, audit) -> 20 -> 21 -> 22 -> phase-end audit.

Hotspot chains on purpose: 1 -> 2 (location.ts, resolve.ts, extract prompt); 2 -> 7 and 2 -> 10 (extract schema,
digest); 10 + 5 -> 11 (digest); 11 -> 20 (digest Source health); 3 -> 4 -> 5 (apply-links module); 13 -> 14 (worker).
Cards 8, 9, 15, 17, 18 touch `registry.ts`, `keywords.ts` or `dedupe/index.ts` in parallel: QA keeps every entry.

Audits: 9 individual (location truth, companies.yaml writer, `unknown_tier_ask`, `.env` + schedule, JobSpy LinkedIn,
Indeed, YC, JobStreet, LinkedIn posts). 12 medium + 1 low merges plus the 2 medium rows already in the ledger
(t_ab66aa5b, t_109ee39b) -> about 2-3 batch audits during the phase; the PM creates them from the ledger at 5 medium.

## Risks
- **IP blocks on Tier 2.** LinkedIn and Indeed run from the owner's home IP. Rates are fixed in the conventions, blocks
  stop the source for 6 h, nothing retries in a loop, and agents do not run JobSpy live unless the owner says so.
- **JobSpy breakage.** LinkedIn changes break scrapers; the worker is pinned and a parse failure is an error in Source
  health, never a silent empty run.
- **LLM budget.** Hourly `enrich`, more sources, re-extraction and the apply-link Haiku step share the $1/day cap.
  New postings are served first; re-extraction and the apply-link step are bounded (14 days, fit >= 60 only).
- **Location truth rejects more.** A rule reject is final; golden rows for both sides and a smoke before/after list are
  required, and the card is individually audited.
- **Writing the owner's config file.** Append-only with backup, re-validation and restore, individually audited.
- **Brave terms.** Storing LinkedIn post results is limited by Brave's terms; the owner chooses the storage option.
- **Threads** depends on the owner's Meta app; the chain finishes without work if the owner drops it.

## Assumptions (owner may veto on the gate)
- Time-zone rule as in the conventions (Europe hours kept with a label; Americas overlap > 3 h rejected).
- The JobSpy worker prints JSON and the TS adapter writes the DB (one writer), instead of the worker writing SQLite.
- `resolve-apply` is its own command run after `enrich`, not an `enrich` stage.
- Re-extraction window of 14 days since last seen.
- `unknown_tier_ask` keeps the tier label `regional`; only the number changes.

## What I need from you (also on the gate card t_c1c7756b)
1. Approve the plan and the order.
2. Confirm or change the time-zone rule.
3. Brave: key set, cost OK (about $1.50-2/month extra), storage option for LinkedIn posts, or drop LinkedIn posts.
4. Threads: token or drop (card t_9b3bd676).
5. Agents may run `bin/smoke --with-jobspy` (one LinkedIn + one Indeed search of 10 results) from your IP: default no.
6. Keep the $1/day LLM cap?
7. Confirm automatic `companies.yaml` additions (or "DB only").
8. Add `unknown_tier_ask` to your `config/salary.yaml` yourself after card t_fe52a1af lands.
9. Python 3.10+ and a venv for the JobSpy worker.
10. Close t_55542219 and t_6491b379 (Phase 1 leftovers in triage).
