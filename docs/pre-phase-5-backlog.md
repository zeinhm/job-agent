# Review-day fix round (before Phase 5): backlog

Planned 2026-10-16 by the PM (card t_4346db1a) from the owner's first real review day (2026-10-16).
No owner gate: the owner listed every item and the review levels on the planning card.
Review levels follow the owner's card: QA for every dev card, an individual audit only for item 1 (the auditor merges). The other
cards are QA-merged (medium / low, ledger rows); re-audit #12 covers the whole round.

## Owner items and where they go

| # | Owner item | Card |
|---|---|---|
| 1 | LinkedIn descriptions (root cause): fetch only for postings passing the title and source-location rules; no Top match without one; re-run rules and extraction | R0 research, then F1 |
| 2 | Company name matching ("Tether.io" vs "Tether Operations Limited") | F2 |
| 3 | Location from the title ("100% Remote - worldwide" with an HQ-city location) | F3 |
| 4 | Ask text: no double period after `text_field_answer` | F4 |
| 5 | Dashboard layout: fixed widths, short tier/ask, side detail panel, sticky header | F5 |

## Cards

| Id | Dev | QA | Audit | Risk | Priority | Title | Depends on |
|---|---|---|---|---|---|---|---|
| R0 | t_8bf04d47 (researcher) | - | - | low | 10 | Research: fetch one LinkedIn job description through JobSpy (no custom LinkedIn code) | - |
| F1 | t_4f984ef5 | t_5093d218 | t_eaf02881 | high | 10 | LinkedIn descriptions: fetch them for postings that pass the title and location rules; no Top match without one | R0 |
| F2 | t_c08e4542 | t_cc1c9771 | - | medium | 9 | Company name matching: one normalizer that strips TLDs, legal and filler words, with golden rows | - |
| F3 | t_b032ee04 | t_a6db0f40 | - | medium | 8 | Location from the title: "100% Remote - worldwide" in the title settles location_unclear when the source location is only a place | F1 audit (both edit `process.ts`) |
| F4 | t_44ce9ef4 | t_9cc9dbcc | - | low | 6 | Ask text: no double period after a text answer that already ends with punctuation; label it "Text answer" | - |
| F5 | t_c1b1a380 | t_4fea4042 | - | low | 6 | Dashboard layout: fixed column widths, short tier/ask in the table, side detail panel that never covers the table, sticky header | F4 QA (same components) |

Then:
- t_175eede7 **Re-audit #12: review-day fix round** (auditor). Parents: F1 audit and the QA cards of F2-F5. Reviews
  `git diff audit-11..main`, the status of the five items, `bin/smoke --demo`, break checks, clears the F2-F5 ledger rows. The title
  avoids the word "Phase" so the report is saved as `batch-12.md`, not `phase-12.md` (seen in the Phase 4 fix round).
- t_b5d58299 Review-day fix round report (pm): `docs/pre-phase-5-report.md`.
- t_5d859ecb Owner review: review-day fix round (owner).

Card bodies and the creation script: `data/handoff/p5pre/` (gitignored).

## Rules every card repeats
- Live checks only with `bin/smoke` / `bin/smoke run <dir> <command>`; never env-prefixed commands; never `--with-jobspy`; no agent
  run sends any request to linkedin.com.
- No `config/` edits; example-file changes go under "Owner applies" in the dev report.

## Assumptions (PM)
- **R0 before F1.** The public-repo rule keeps LinkedIn access inside JobSpy. The earlier research
  (`docs/research/t_a46f63f1-jobspy.md:100-116`) says `fetch_description=True` sends one request per search result in a burst, and it
  fetches for every result, not only the ones that pass our rules. So per-job fetching needs a JobSpy call for a single job id. The
  research card finds that call. If the only per-job path is an internal JobSpy method, F1 may use it from `run.py`, because the
  request still goes through JobSpy. That trade-off is recorded in decisions.md.
- **F1 numbers** (owner gave none):
  - at most 20 detail requests per run;
  - at least 10 s between any two LinkedIn requests (the existing `SEARCH_GAP_MS`);
  - newest postings first;
  - at most 3 attempts per posting, and blocked runs do not count;
  - one shared 6 h linkedin block backoff.
- **F1 "source-location rule"** means `classifyLocation` on the posting's own location text does not return `restricted`.
  - Before the description arrives, a posting gets the flag `description_missing`. It shows in Needs a look, never in Top matches.
  - No LLM extraction runs on pending postings, so no money goes on title-only guesses.
  - After 3 failed attempts a posting is `description_unavailable`. It is then extracted on the title, but it still never reaches
    Top matches.
- **F2:**
  - The filler-word list (operations, technologies, labs, group, holdings, software, solutions, hq, the) is the owner's list plus a few
    obvious ones.
  - Must-differ golden rows guard against wrong merges.
  - Existing company rows are re-keyed and merged on the next `process`. Owner fields are never lost. Two rows with conflicting owner
    pay-policy marks are not merged silently.
- **F3:**
  - The rule is about wording, so it applies to every source, not only LinkedIn.
  - It applies when the location field is empty, a bare place or remote wording, and only with an explicit worldwide phrase.
  - Plain "Remote" in a title settles nothing.
- **F4:** the PM did not find a literal `.` join in the code (`tier.ts:171,194` copies the text as it is; `selection.ts:127,391` and the
  dashboard add no period). So the card starts with a reproduction using the fake persona. The card also fixes the "Ask reason:" label
  on the text answer (`DetailPanel.tsx:206`), because it is the same text.
- **Review levels:** fix cards are normally always high risk (decisions.md 2026-10-06). The owner's card asks for an individual audit
  only for item 1, so F2 and F3 are medium and F4 and F5 are low. This is recorded as an owner decision for this round only (as in the
  Phase 4 fix round).

## Open questions for the owner
None blocking. Two for the owner review:
- Are the F1 numbers right (20 detail requests per run, 10 s apart, 3 attempts)? With 2 searches of up to 25 results per hour, 20 is
  enough for the postings that pass the rules on a normal day.
- From the Phase 4 fix round report, still open and the owner's job: finding A5 (`bin/agent-step` stashes PM edits and force-moved
  `audit-11`). Re-audit #12 lists any ledger rows that are still left over.
