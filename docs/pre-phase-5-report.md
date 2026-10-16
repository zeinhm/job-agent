# Review-day fix round (before Phase 5): report

Planned in t_4346db1a (`docs/pre-phase-5-backlog.md`) from the owner's first real review day (2026-10-16). Audited by re-audit #12
(t_175eede7, `docs/audits/batch-12.md`): **PASS**, no BLOCKER or MAJOR, 3 MINOR.

## The five owner items

| # | Owner item | Card (dev / QA / audit) | Commit on `main` | Re-audit #12 |
|---|---|---|---|---|
| 1 | LinkedIn descriptions | R0 t_8bf04d47 (research, `0215b7d`), F1 t_4f984ef5 / t_5093d218 / t_eaf02881 | `9c74fc4` | closed |
| 2 | Company name matching ("Tether.io" = "Tether Operations Limited") | F2 t_c08e4542 / t_cc1c9771 | `d4fda10` | closed |
| 3 | Location from the title ("100% Remote - worldwide") | F3 t_b032ee04 / t_a6db0f40 | `f95f71c` | closed |
| 4 | Ask text: no double period, "Text answer" label | F4 t_44ce9ef4 / t_9cc9dbcc | `3b2fca7` | closed |
| 5 | Dashboard layout | F5 t_c1b1a380 / t_4fea4042 | `c85e5db` | **partly closed**: code and tests in place, the CSS (widths, sticky header, panel never covering the table) was not checked in a browser. Owner confirms. |

## Tests

`pnpm check` exit 0 at `3f02d01`: **123 test files, 2406 tests passed** (audit #11: 117 / 2286). `bin/smoke --demo` and the dashboard
self-check pass (`/api/health 200`, `/api/queue 200 items=64`). Break checks: 4 of 5 caught; the fifth (removing `.io` from the TLD
list) is an equivalent mutant, see MINOR 1.

## What changes in the daily run

- **New hourly step `fetch-descriptions`**, between `process` and `enrich` (already in `bin/run-hourly`, no crontab change). It fetches
  LinkedIn descriptions through JobSpy, only for postings whose title passes the role rule and whose own location text is not
  restricted: **at most 20 requests per run, at least 10 s apart, newest first, at most 3 attempts per posting**; a block stops it and
  starts the same 6 h LinkedIn backoff as the search.
- **Source health**: the linkedin line gets `details N (K failed)` (plus `blocked` after a block).
- **Needs a look**: a LinkedIn posting without its description has the flag `description_missing`. It is never a Top match and gets no
  LLM spend while pending. After 3 failed attempts it is extracted on the title, but still never reaches Top matches.
- **Company merge on the first `process`**: every company name is re-keyed with the new normalizer and rows sharing a key are merged
  (owner pay-policy mark wins, then a stored ATS board, then the oldest). Two rows with conflicting owner pay-policy marks are kept apart,
  with one `warn` line per run. The merge deletes the loser rows and cannot be undone, so back up `data/job-agent.db` before that run.
- **Location**: a worldwide phrase in the title ("100% Remote - worldwide", "work from anywhere", ...) now settles a posting whose
  location is empty, only a place, or remote wording. Plain "Remote" in a title changes nothing.
- **Dashboard**: fixed column widths, sticky header, short tier/ask in the table (full text on hover and in the panel), side detail panel
  at 1200 px and wider (below the table on narrower windows).

## Still open

- Re-audit #12 MINOR 1: two-letter entries (`io`, `ai`, `co`) in `DOMAIN_TLDS` (`normalize/company.ts:43`) are dead code. Low priority.
- MINOR 2: the detail panel shows a text answer twice (`ask` line and the `Text answer:` line, `DetailPanel.tsx:~206`). Cosmetic.
- MINOR 3: short legal words (`as`, `sa`, `co`, `ab`, `pt`, `ag`) are removed anywhere in a name, so "Work As Code" keys as "work code".
  Accepted in decisions.md. Watch the merge count on the first real run.
- Not yet fixed: there are no fix cards. The PM can add MINOR 1 and 2 to the Phase 5 plan.
- From the Phase 4 fix round, still the owner's job: finding A5 (`bin/agent-step` stashes PM edits and force-moved `audit-11`). The
  audit ledger is now empty and clean (re-audit #12 rewrote it).
- The F1 numbers (20 / 10 s / 3 attempts) were chosen by the PM. The owner can confirm or change them.

## Check on the next real review day

1. **Before the first `process`**: back up the DB. **After** it, read the `process` log for the company merge count and any `warn`
   conflict lines. Spot-check that "Tether.io" and "Tether Operations Limited" share one company row.
2. `data/logs/fetch-descriptions.log`: `requested <= 20`, no `blocked`. Source health linkedin line shows `details N`.
3. Top matches: no LinkedIn posting without a description. Postings marked `description_missing` sit in Needs a look and leave it once
   their text arrives. The French, hybrid Tunis posting from review day (or anything like it) is no longer a Top match.
4. A LinkedIn posting with "(100% Remote - worldwide)" in the title and a city as location is not stuck on `location_unclear`.
5. Dashboard at your usual window width: columns do not shift, the header stays on screen while scrolling, the side panel never covers
   the table, and tier/ask cells are short. This is the one item the audit could not confirm.
6. A text-answer posting: ask text has no `..` (you will see the text twice in the panel, MINOR 2).
