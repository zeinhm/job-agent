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
| t_736df3a8 | Implement company pay-policy registry | medium | 5222db2 | 2026-10-09 |
| t_63f270d0 | Implement company pay-policy research from careers pages (Haiku) | medium | 6760618 | 2026-10-09 |
| t_5bac0f79 | Implement SmartRecruiters source adapter | medium | 69ce348 | 2026-10-09 |
| t_766d6b7c | Implement fit scoring against the CV (Sonnet) | medium | 4400da8 | 2026-10-09 |
| t_73f6affa | Implement ranked digest with a 'why' line per posting | medium | 16b388b | 2026-10-09 |
| t_b313841a | Implement Workable source adapter | medium | 2bbdc86 | 2026-10-09 |
| t_e239af67 | Implement Recruitee source adapter | medium | c593b5c | 2026-10-09 |
| t_3f99932a | Implement Arbeitnow source adapter | medium | 4d624ce | 2026-10-09 |
| t_9dcff684 | Poll discovered companies from the database | medium | ebf037d | 2026-10-09 |
| t_f6f3b14c | Implement company discovery via search API | medium | 07fe2c8 | 2026-10-09 |
| t_a8d69efd | Extend end-to-end test to the Phase 2 pipeline | medium | 309bc4c | 2026-10-09 |
| t_b7afa306 | Update run docs, cron example and env example for Phase 2 | low | 052e718 | 2026-10-09 |
| t_ab66aa5b | Reject unpaid, volunteer and equity-only postings before fit scoring | medium | 8f9da31 | 2026-10-14 |
| t_109ee39b | Digest --include-unpaid: optional Volunteer / unpaid section | medium | 8791751 | 2026-10-14 |
| t_fa40baa4 | Extend the free title deny-list so clearly non-engineering titles never reach an AI call | medium | 201af0f | 2026-10-14 |
| t_fb5c9fac | Time zone requirements for a GMT+7 candidate: residence vs working hours | medium | 169e896 | 2026-10-14 |
| t_2e9e402a | Apply links: schema, resolve-apply command and ATS lookup by company name + title match | medium | 198340a | 2026-10-14 |
| t_7f305c0c | Apply links: careers-page ATS detection and apply links in the posting text | medium | d31f792 | 2026-10-14 |
| t_8e27df96 | Re-extract stored postings whose extraction used an older prompt version | medium | 599a0c0 | 2026-10-14 |
| t_0bfea274 | Apply links: one Haiku call picks among candidate links when the rules leave it unclear | medium | a2c57b1 | 2026-10-14 |
| t_c26830be | Add hiring YC companies from the public directory to the ATS polling list | medium | d096002 | 2026-10-14 |
| t_d46f2a41 | Shorter digest: no Why line, compact time zones, employment type, only open flags, one-line waiting entries | medium | 4bc3e97 | 2026-10-14 |
| t_fbc60316 | Digest shows Apply, Found on and the apply type; paid-only jobs stay listed with a label | medium | d1c2e63 | 2026-10-14 |
| t_4eaabb57 | Freshness proof: Source health shows last run and max gap for LinkedIn and Indeed; schedule notes for Tier 2 | medium | e36976b | 2026-10-14 |
| t_1700ae4a | End-to-end test for the Phase 3 pipeline and bin/smoke coverage of the new keyless sources | medium | 2a85c60 | 2026-10-14 |
| t_9192fcfc | Update run docs, cron example and env example for Phase 3 | low | 5a1197b | 2026-10-14 |
| t_172f1d5e | Source poll intervals: slack below the hourly schedule (indeed LATE fix) | medium | 6eacd65 | 2026-10-15 |
| t_47589c2e | linkedin_posts disabled by default (Brave does not index LinkedIn posts) | medium | 3eef570 | 2026-10-15 |
| t_ce49d729 | Owner-only holds labelled OWNER, real error in hold reasons | medium | 3e01a18 | 2026-10-15 |
| t_1099c9eb | Phase 4 schema: reviews, answer_bank, posting_questions, unknown_questions; SQLite WAL | medium | 1b7a414 | 2026-10-15 |
| t_99deaa3f | Demo seed: seed-demo fills a smoke DB with fake queue data | medium | bcee7d0 | 2026-10-15 |
| t_c269b5ab | Dashboard web app skeleton: Vite + React + TanStack Query, four tabs, build and tests in pnpm check | medium | 8667a6d | 2026-10-15 |
| t_22e91591 | Fetch application questions from public ATS job APIs (fetch-questions) | medium | e4918fa | 2026-10-15 |
| t_53073918 | Review queue API: shared day-selection module, queue and posting detail, POST /api/reviews | medium | 4bb9649 | 2026-10-15 |
| t_f413f9ea | Eval script eval:extract with a committed golden set (owner-run, --live only) | medium | d365399 | 2026-10-15 |
| t_add8c02f | Review queue UI: table per section, detail panel, action buttons with reason picker | medium | 495acf7 | 2026-10-15 |
| t_ff411096 | Feedback: owner apply-link correction updates apply_links; resolve-apply never overwrites it | medium | f5b4d3a | 2026-10-15 |
| t_55e60eeb | Review stats: review-stats CLI and Stats tab (done-when timing, ask checks per tier) | medium | 043b2aa | 2026-10-15 |
| t_8f401a3b | Digest: reviewed postings leave Top matches; review line with counts and dashboard link | medium | f2f3e3e | 2026-10-15 |
| t_731c5fc6 | Fast triage: keyboard shortcuts, auto-advance, bulk not-interested, undo, elapsed timer | medium | df056fb | 2026-10-15 |
| t_33bd7696 | Eval script eval:fit (fake persona) and eval:export-reviews to data/eval | medium | ad86c0e | 2026-10-15 |
| t_2d987b85 | Answer bank: answers.yaml loader, fake example, answers import | medium | 79350f5 | 2026-10-16 |
| t_627338ac | Docs: config/*.example.* changes are owner-applied (agents cannot read or edit config/) | medium | 738c887 | 2026-10-16 |
| t_da6ce498 | Answer bank tab: list, edit, approve, alternatives, YAML export to data/exports | medium | 6cc826e | 2026-10-16 |
| t_8140d1bc | Match application questions to the answer bank; fill the unknown-questions inbox | medium | 77e37ce | 2026-10-16 |
| t_bb962b1b | Unknown-questions inbox: answer, link as alternative, dismiss; re-match after each action | medium | fae437b | 2026-10-16 |
| t_3b914bae | End-to-end test for Phase 4 and bin/smoke coverage of the dashboard | medium | 56ca0df | 2026-10-16 |
| t_c5832945 | Run docs for Phase 4: dashboard, review keys, answer bank, inbox, eval scripts, done-when check | low | 3c47619 | 2026-10-16 |
| t_22582616 | Hardening: seed-demo resolves realpath and refuses a DB with non-demo postings; question fetch stays on the ATS host; pay-policy owner guard test | medium | d968504 | 2026-10-16 |
| t_c08e4542 | Company name matching: one normalizer that strips TLDs, legal and filler words, with golden rows | medium | d4fda10 | 2026-10-16 |
| t_0ee7b06b | Rule: agents never search outside the repo (no find /) | medium | 62c9940 | 2026-10-16 |
| t_b032ee04 | Location from the title: "100% Remote - worldwide" in the title settles location_unclear when the source location is only a place | medium | f95f71c | 2026-10-16 |
| t_44ce9ef4 | Ask text: no double period after a text answer that already ends with punctuation; label it "Text answer" | low | 3b2fca7 | 2026-10-16 |
| t_c1b1a380 | Dashboard layout: fixed column widths, short tier/ask in the table, side detail panel that never covers the table, sticky header | low | c85e5db | 2026-10-16 |
