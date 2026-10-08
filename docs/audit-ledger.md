# Audit ledger

Merged medium/low tasks not yet covered by a batch or phase-end audit.
QA appends a row when it merges. The PM creates a batch audit task when the counts reach **5 medium** or **10 low**. The auditor clears the rows it covered and records the batch number.

Last audit tag: (none yet)

| Task id | Title | Risk | Merged commit | Merged on |
|---|---|---|---|---|
| t_4affb67b | Scaffold pnpm monorepo | medium | fa1e127 | 2026-10-07 |
| t_1c4a241e | Core types, SourceError, config loader | medium | e3a318a | 2026-10-07 |
| t_263c9659 | Add Phase 1 database schema and first migration | medium | c65664e | 2026-10-07 |

**Counts:** medium 3 / 5 - low 0 / 10
| t_cf5d7920 | Implement Greenhouse source adapter | medium | b7f0257 | 2026-10-07 |
| t_7e6323cc | Implement Lever source adapter | medium | a8199f4 | 2026-10-07 |
| t_6b3ccf13 | Implement Himalayas source adapter | medium | e8625e5 | 2026-10-07 |
| t_7762821c | Implement We Work Remotely RSS source adapter | medium | 03cdc67 | 2026-10-07 |
|| t_e83f59ac | Implement Ashby source adapter | medium | 351a222 | 2026-10-07 |
|| t_a2ab4f25 | Implement Remotive source adapter | medium | b3a8e1c | 2026-10-07 |

**Counts:** medium 6 / 5 - low 0 / 10 _(batch audit triggered: 6 medium tasks)_
| t_3654c586 | Implement web3.career source adapter | medium | baec69e | 2026-10-07 |
| t_44be3ba1 | Implement RemoteOK source adapter | medium | 404bd58 | 2026-10-07 |
| t_55e4e4d3 | Fix main: buildAdapters greenhouse/lever tests | medium | a92b54a | 2026-10-07 |
| t_e6e46c8e | Implement posting normalization | medium | 3d15c3d | 2026-10-07 |
| t_b77fea1a | Implement HN "Who is hiring" source adapter | medium | 9e61e52 | 2026-10-07 |
| t_23700548 | Implement cross-source dedupe | medium | 876908e | 2026-10-07 |
| t_97bdc85f | Implement daily FX rate fetch and storage | medium | 590001e | 2026-10-07 |
| t_4595a4e3 | Rework: Location eligibility golden set (relabel 17 disputed cases) | medium | b271004 | 2026-10-07 |
| t_5f8224a0 | Implement Indonesia rule filter with golden set | medium | 35aa9f0 | 2026-10-07 |
| t_b7a7cd40 | Implement process command (normalize, dedupe, filters, analysis rows) | medium | 991a7ae | 2026-10-08 |
| t_0e4cc928 | Pilot: add docs/pilot.md | low | 4dc5700 | 2026-10-08 |
| t_7d626c81 | Add Phase 2 database schema (intel, llm_calls, company and posting columns) | medium | be31dc0 | 2026-10-09 |
| t_38151c18 | Fix location rules: country lists and 'Remote, <country>' are restricted | medium | 73fcf9f | 2026-10-09 |
| t_0f390819 | Fix HN adapter: only top-level comments are job posts | medium | 43ba2df | 2026-10-09 |
| t_08e114f8 | Fix web3.career adapter: follow the HTTP 302 redirect | medium | 3a6a43f | 2026-10-09 |
| t_0860cdb9 | Group same company + same title postings into one digest entry | medium | 0d7a09d | 2026-10-09 |
| t_3765117e | Implement role relevance filter with golden set | medium | efe6ab2 | 2026-10-09 |
| t_67544a8a | Refresh stored postings when the employer edits them | medium | e7ceac6 | 2026-10-09 |
| t_1f6911e8 | Extend bin/smoke to all keyless sources plus digest | low | c81d69d | 2026-10-09 |
| t_0d85cc05 | Implement pay-context and facts extraction (Haiku) and the enrich command | medium | a34893f | 2026-10-09 |
| t_d56b8ff0 | Resolve unclear location, Indonesia and role flags from extracted facts | medium | 4fe8ba2 | 2026-10-09 |
