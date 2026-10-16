# Re-audit #12: review-day fix round

Audited commit: `main` = `3f02d0170015920712d0439c0c776c9197f18b10`, diff `audit-11..main` (58 files). Verdict: **PASS** (no BLOCKER/MAJOR; 3 MINOR).

## Evidence

- `pnpm install --frozen-lockfile` ok; `pnpm check` exit 0. **Test Files 123 passed (123), Tests 2406 passed (2406)** (audit #11: 117 / 2286).
- `bin/smoke --demo`: all steps ok, `dashboard --self-check`: `/api/health 200`, `/api/queue 200 items=64`. `bin/smoke dash <dir> --self-check` same two lines. No LinkedIn request, no `--with-jobspy`.
- Source health from the smoke digest (demo DB has no LinkedIn run, so no `details N` suffix; that suffix is covered by `run-digest`/fetch-descriptions tests):

```
## Source health
- **arbeitnow**: ok, found 1428, new 1428
- **greenhouse**: ok, found 27, new 27
- **himalayas**: ok, found 200, new 200
- **hn**: ok, found 23, new 23
- **remoteok**: ok, found 21, new 21
- **remotive**: ok, found 1, new 1
- **weworkremotely**: ok, found 18, new 18
- **linkedin_posts**: disabled
```

## Owner items

| # | Item | Status | Where / proof |
|---|---|---|---|
| 1 | LinkedIn descriptions | **closed** | `description-state.ts:19-23` (state), `process.ts` (`description_missing` flag), `digest/selection.ts` (`g.description === "present"` gate before Top; Waiting reason), `enrich.ts:491,530` (no spend while pending), `fetch-descriptions.ts:46-69` (selection), `:154-160` (10 s gap), `:171-179` (3 attempts), `:131-135,203-217` (shared 6 h backoff). Tests: `fetch-descriptions.test.ts` (3 tests fail when the Top gate is removed, 1 when the gap is removed), `details.test.ts`, `test_run.py`, `description-migration.test.ts`. |
| 2 | Company matching | **closed** | `normalize/company.ts:43-92` is the single key; `apply-links/slugs.ts` now calls `companyNameWords`; no leftover suffix list in non-test code (grep for `gmbh`/`llc`/`pte` outside company.ts: none). `merge-companies.ts` repoints `postings` and `llm_calls`, the only two FKs to `companies.id` (`schema.ts:38,147`). Tests: `company.golden.test.ts` + `company.golden.json` (118 lines), `merge-companies.test.ts`. |
| 3 | Location from title | **closed** | `filters/location.ts:242-267` (`findTitleWorldwide`), `:371-373` (step 3, after step 2 restrictions), `process.ts` passes `titleText: p.title`. Tests: `location.test.ts`, golden rows loc-162..179 in `fixtures/golden/location.json`. |
| 4 | Ask text | **closed** | `core/src/sentence.ts:2-6` (`endSentence`), used in `digest/selection.ts` (`askLabel`), `SectionTable.tsx` (`tierAsk`), `DetailPanel.tsx` ("Text answer:"). Tests: `sentence.test.ts`, `queue.test.tsx` (6 punctuation cases), `ranked.test.ts`. |
| 5 | Dashboard layout | **partly closed** | Fixed widths sum to 100% (`style.css` `.col-*`), `table-layout: fixed`, sticky `th`, side panel sticky at >= 1200px and a block below that, short tier/ask (`SectionTable.tsx` `shortAsk`, title attr holds the full value). Tests cover the short/long text and titles (`queue.test.tsx`); CSS (widths, sticky, panel not covering the table) has no automated check in jsdom and I did not view it in a browser. Owner to confirm on the next review day. |

## Cross-card consistency

- `process.ts`: F1 adds `description_missing` via `descriptionState(p)`; F3 passes `titleText`. Independent; `fetch-descriptions` re-runs `analyze` so a fetched description plus the title are both used. `fetch-descriptions` selection judges location text only (no title), so a worldwide title can never widen what gets fetched. Consistent with decisions.
- `SectionTable.tsx` / `DetailPanel.tsx` (F4 + F5): both use `endSentence`; table shows short form, panel the full text. See MINOR 2.
- Company key: `renormalizeCompanies` runs first in `runProcess`; golden rows use public or fake names.
- New `docs/decisions.md` entries (5, dated 2026-10-16) match the code: phrase list, step order, 20 / 10 s / 3 attempts / 6 h, migration 0005, `description_runs`.

## Break-the-code checks (each reverted with `git checkout -- .`)

| Check | Result |
|---|---|
| (a) description-less LinkedIn posting allowed into Top (remove `g.description === "present"`) | caught: 3 failed in `fetch-descriptions.test.ts` (digest-only tests did not fail: the guarding tests live in fetch-descriptions.test.ts) |
| (b) drop the 10 s gap (`if (wait > 0) await sleep(wait)`) | caught: 1 failed test in `fetch-descriptions.test.ts` |
| (c) remove `.io` from the domain TLD list | **not caught, equivalent mutant**: `io` also matches the generic `[a-z]{2}` country-TLD alternative. Removing both (a real removal of the rule for `.io`) fails 6 tests (`Tether.io`, `Example.id`, `Node.js` golden rows). See MINOR 1. |
| (d) plain "remote" counted as worldwide title phrase | caught: location golden misclassifies loc-176/177 ("step 3 worldwide signal "remote" in title"), and a unit test fails |
| (e) always append a period | caught: 13 failed tests (`sentence.test.ts`, dashboard `queue.test.tsx`) |

## Personal-data sweep

Grep of the added lines of `audit-11..main` (excluding lockfile and drizzle snapshots) for email addresses, phone patterns, IPv4, `/Users/...`, owner name and domain: no hits. Golden rows and fixtures use public company names or fake data. I read neither `config/` nor `data/` (except handoff files) nor `.env`. The docs diff (research t_8bf04d47, decisions, backlog, phase-4 report) shows no personal data; the review-day anecdote in decisions names no person or employer.

## Findings

1. **[MINOR] `packages/pipeline/src/normalize/company.ts:43`**: `io` in `DOMAIN_TLDS` is dead; `ai` too (and `co`, which is also two letters): the generic `|[a-z]{2}` alternative already matches them, so removing `.io` from the list changes nothing and no test can fail. The three-letter-plus entries (`com dev app net org xyz tech`) are live. Fix later: drop the two-letter entries from the list or state in the comment that the list is documentation. Reproduce: remove `io|` from `DOMAIN_TLDS`; `pnpm vitest run packages/pipeline/src/normalize` passes 95/95.
2. **[MINOR] `apps/dashboard/src/web/components/DetailPanel.tsx:~206-207`**: when a posting has a text answer, `detail.ask` already contains `text answer: ...` (from `askLabel`), and the panel then shows a second line `Text answer: ...` from `askText`. The text appears twice in the panel (the `queue.test.tsx` case happens to use a money ask). Cosmetic; fix when touching the panel next.
3. **[MINOR] `company.ts` LEGAL_WORDS**: the words `as`, `sa`, `co`, `ab`, `pt`, `ag` are removed as whole words anywhere in a name (not only at the end), so a name like "Work As Code" becomes "work code" and could merge with "Work Code". Accepted in `decisions.md` as "no fuzzy matching" with owner-pay-mark conflict protection; the merge deletes company rows irreversibly, so keep an eye on `renormalizeCompanies` merge counts in the first real run.

No BLOCKER or MAJOR.

## Ledger

- `docs/audit-ledger.md` rewritten: the F2-F5 rows (t_c08e4542, t_b032ee04, t_44ce9ef4, t_c1b1a380) and t_0ee7b06b (prompts/docs only, in this diff) are covered by this audit.
- The remaining ~80 rows were already covered by audits 1-11 (finding A5 of the Phase 4 report: the ledger had a malformed header, "Last audit tag: (none yet)" and stray `||` and `Counts` lines between rows). All cleared; the table is now empty, `Last audited commit:` is `3f02d0170015920712d0439c0c776c9197f18b10`, counts 0/5, 0/10. Tags not touched.

## Fix tasks

None required. Optional low-priority: MINOR 1 and 2 above.
