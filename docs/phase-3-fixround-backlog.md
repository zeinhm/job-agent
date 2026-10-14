# Phase 3 fix round: backlog

Planned 2026-10-14 by the PM (card t_a338e6ae) from the owner's decisions on `docs/phase-3-report.md`.
Every dev card is a fix task, so every one is **high risk**: dev -> QA -> individual audit (the auditor merges).
No owner gate: the owner already decided every question (entries dated 2026-10-14 in `docs/decisions.md`).

## Owner items and where they go

| # | Owner item | Card |
|---|---|---|
| 1 | Remove the YC directory part; discover-companies never reads ycombinator.com or YC's search index | F1; decision entry "YC dropped entirely" |
| 2 | P3-1 YAML quoting, P3-2 freshness gap, P3-3 "(unknown)" probes, P3-4 Brave counter test, P3-5 ledger | F2 (P3-1, P3-3), F4 (P3-2, P3-4), re-audit housekeeping (P3-5) |
| 3 | All batch 6 findings; batch 5 "Europe or Asia" and "French speaker markets" | F2 (B6-1, B6-2), F3 (B6-3, B6-5), F5 (B6-4, B6-6), F6 (B5-1), F7 (B5-2) |
| 4 | Open MAJOR of audit t_f75d6948 ("German is not required") | F7 |
| 5 | Work-authorization wording rejects as a restriction, also under a Worldwide label | F6; decision entry |
| 6 | `bin/agent-step` calling the ops push-main script is intended | closed by decision entry, no card |
| 7 | `discover-companies` weekly (Monday 07:00) in `crontab.example` | F1; decision entry |

## Cards

| Id | Dev | QA | Audit | Title | Depends on |
|---|---|---|---|---|---|
| F1 | t_60aa9f53 | t_90ff48aa | t_9d01860d | Remove the YC directory part of discover-companies; schedule discover-companies weekly | - |
| F2 | t_6e6fdf4a | t_502210ec | t_1c1fca9e | Apply links: quote YAML scalars in save-ats, same-company check for careers-page boards, no probes for "(unknown)" companies | - |
| F3 | t_45be12f8 | t_b54f2405 | t_18620adb | Apply-link Haiku step: verify company_form and paid_aggregator answers in code, retry API failures on the next run | F2 audit (same file) |
| F4 | t_f4d714c1 | t_cd27c749 | t_23749b51 | Freshness line counts the gap from the last ok run to now; test that a corrupt Brave counter counts as spent | - |
| F5 | t_4f0c3e02 | t_1fae305d | t_3c787d70 | Hourly wrapper: race-free stale-lock takeover; JobSpy worker: a bare 429/999/403 number is not a block | - |
| F6 | t_e1bd0972 | t_ee52bde1 | t_8a15a070 | Location rules: work-authorization wording is a restriction; "must be located in Europe or Asia" is not | - |
| F7 | t_7b240d68 | t_6e30e853 | t_a8389a3c | Language filter: "not required" wording protects the language; "French speaker markets" is not a requirement | - |

Then:
- t_2ea13484 Phase-end audit #3b (auditor): re-audit `1608cff..main`, status of every item above, smoke, break checks,
  saves `docs/audits/phase-3.md`, rebuilds `docs/audit-ledger.md` (P3-5), names the commits for `audit-7` and `audit-8`.
  Parents: all 7 audit cards.
- t_a8e6e464 Phase 3 fix round report (pm): adds a "Fix round" section to `docs/phase-3-report.md`.
- t_a20bb875 Phase 3: owner review after the fix round (owner).

F6 and F7 both edit `filters/keywords.ts` (different lists); they run in parallel and each merges main before handing
over. F1 and F4 touch different files (F1: `discover-companies.ts`, `http.ts`, crontab, `running.md`; F4:
`freshness.ts`, `search.ts` tests).

## Assumptions (PM)

- Existing `yc_directory` company rows stay in the owner's DB and keep being polled through their own ATS APIs; only
  reading YC hosts is forbidden. No migration.
- A host guard in `http.ts` (like the LinkedIn guard) refuses `ycombinator.com`, `*.ycombinator.com` and
  `workatastartup.com`, so no later code can read YC by accident. HN keeps using `hn.algolia.com`.
- PLAN.md is not edited; the decision entry supersedes its YC rows (including YC semi-automated applying in Phase 5).
- B6-5: an API failure in the Haiku apply step stores no row and is retried on the next run (the step stops for that
  run); invalid model output keeps the 7-day re-check.
- B6-3: `company_form` from the model counts only for a host that is not a board, paid, sign-up or ATS host and, when
  the company domain is known, is on that domain.
- The original owner review card t_cff37d06 stays open; the owner can approve either card.

## Open questions for the owner

None. The `unknown_tier_ask` placeholder check and the one-day live run from the Phase 3 report still stand.
