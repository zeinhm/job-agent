# Phase-end audit #3c: JobSpy coverage fixes (t_3c92fbfc)

Audited point: `main` = origin/main `a1af71a`. Range: `git diff fb47d31..main` (`fb47d31` is the point audited by t_2ea13484; its report `docs/audits/phase-3.md` is in the range, tag `audit-8` did not exist locally, so the named commit was used). Covers t_bc1f4362 (adaptive lookback) and t_02528e72 (saturation paging).
Verdict: **PASS** (0 BLOCKER, 0 MAJOR, 3 MINOR). Suggested tag: `audit-9` on `a1af71a`.

## 1. Checks
- `pnpm install --frozen-lockfile`, `pnpm check`: typecheck, ESLint, Prettier clean; `Test Files 85 passed (85)`, `Tests 1672 passed (1672)` (t_2ea13484: 84 files / 1644 tests); hook tests `31 passed, 0 failed`; Python `Ran 15 tests ... OK`.

## 2. Review as a whole
- `jobspy/index.ts:72-79` `lookbackHours`: `ceil((now - since + 10 min)/60)` clamped 1..24; future `since` gives 1. `fetch(since)` computes it ONCE (`:286`) and spreads it into every page call (`:302-306`), so all pages of all searches use the same `hours_old`. `since` comes from `discover.ts:242` (start of last ok run, else now - 7 days -> 24 h). Error/blocked/skipped runs do not advance `lastOk`, so gaps are covered.
- Paging `:291-311`: loop runs while the last page was full and `offset + results_wanted <= 100`; smoke mode = one call. Full = worker line count >= `results_wanted`. Sleep 10 s before every call except the first of the run (`calls++ > 0`, spans searches). Worst case per run: LinkedIn 2 x 4 = 8 calls, 7 gaps (70 s); Indeed 2 x 2 = 4 calls, 3 gaps (30 s). Per-call worker timeout 120 s (`worker.ts:10`), so the absolute worst case is about 17 min for LinkedIn, well under the 3 h stale-lock age.
- A block on any page throws `SourceBlockedError` with the collected postings (`:313-318`) -> no further page or search, backoff as before. Other `SourceError` with collected data -> `PartialSourceError`.
- `run.py`: `hours_old` 1..24 enforced, `offset >= 0`, `offset + results_wanted <= 100`, `offset` passed to `scrape_jobs` only when non-zero; Python tests added (`test_run.py`).
- Migration `0003_clean_ken_ellis.sql`: `ALTER TABLE source_runs ADD saturated integer` (nullable, matches schema.ts:102, journal and snapshot added). `discover.ts` writes it for ok runs and for partial/blocked-with-postings error runs; null for non-paging sources.
- Source health `digest/index.ts:368`: `, saturated N` after `new M` when not null (`saturated 0` shown too); digest.test.ts +12 lines.
- Docs: `running.md` (lookback, paging, worst case, saturated), `decisions.md` two entries, conventions section 8, phase-3 report, crontab, worker README all match the code (worst case 8/4 calls, 100 cap, first-page definition of saturated, error handling).

## 3. Owner requirements

| Requirement | Status | Where / test |
|---|---|---|
| Lookback = time since last ok run + 10 min, rounded up, 1..24 h | **closed** | `index.ts:72-79`; `index.test.ts` `describe("lookbackHours")` (:136), `discover.lookback.test.ts` |
| 24 h when no ok run | **closed** | `discover.ts:242` fallback 7 d -> clamp 24; `discover.lookback.test.ts` |
| Applies to linkedin and indeed | **closed** | both configs lose the fixed `hours_old`; `index.test.ts:157` (both searches + smoke), `indeed.test.ts` |
| Paging until a page is not full or 100 results | **closed** | `index.ts:295-311`; `index.test.ts` "saturation paging" (:316, four full pages stop at offsets 0/25/50/75; 25 then 12 = two calls; 24 = one call) |
| 10 s spacing | **closed** | `index.ts:300`; paging tests assert sleeps per call |
| Block rules unchanged | **closed** | `index.ts:313-318`; block tests (:213, :226) plus paging block test; `run.py` BLOCK_PATTERN untouched |
| "saturated N" in Source health | **closed** | `digest/index.ts:368`; `digest.test.ts`; `discover` stores it (`discover.ts:219,247,261-266`) |

## 4. Live: `bin/smoke` (no `--with-jobspy`)
```
himalayas: ok, found 200, new 200      remoteok: ok, found 15, new 15       remotive: ok, found 2, new 2
weworkremotely: ok, found 17, new 17   hn: ok, found 32, new 32             arbeitnow: ok, found 1433, new 1421
greenhouse: ok, found 29, new 29       linkedin_posts: skipped (BRAVE_API_KEY not set)
process: processed 1713, kept 68, rejected 1645 (location 1513, indonesia 0, role 907, salary 1, language 237), flagged 1660
status rows: analysis 1713, apply_links 3, companies 831, fx_rates 7, intel 68, llm_calls 0, postings 1716, source_runs 8
```
Source health (digest): the same eight lines, e.g. `- **arbeitnow**: ok, found 1433, new 1421`, `- **linkedin_posts**: no run in the last 24h — NO SUCCESSFUL RUN`. No `saturated` text appears for these sources (null column), which is correct. The migration applied on a fresh DB (`source_runs: 8` rows written without error).
Against t_2ea13484 (processed 1604, kept 68, rejected 1536, source_runs 8): kept is the same (68); processed is +109 and location +106 purely from the live feeds (arbeitnow new 1421 vs 1309, himalayas/hn moved); no change expected from this diff, which does not touch process. No LinkedIn/Indeed request was made, so the paging path itself was not exercised live (unit tests only).

## 5. Break-the-code (each reverted with `git checkout -- .`)
| Change | Result |
|---|---|
| (a) `LOOKBACK_OVERLAP_MINUTES = 0` | 2 tests failed |
| (b) `MAX_LOOKBACK_HOURS = 48` | 4 failed |
| (c) page ceiling +1 page (past 100) | 3 failed |
| (d) no sleep before page calls (only between searches) | 1 failed |
| (e) block on a later page does not stop (turned into a partial error) | 1 failed |

## Findings
### [MINOR] jobspy/index.ts:309 "full" is judged on raw worker lines
A page counts as full only when the worker printed >= `results_wanted` lines. LinkedIn's guest endpoint can return fewer jobs than asked even when more exist; then paging stops early and `saturated` stays 0 although postings were lost. It is documented as the rule, not a defect of this change; watch `saturated` and found counts in the first live days.
### [MINOR] Test depth for the sleep rule (d)
Only one test fails when the page gap is removed; it guards the rule but nothing asserts the 70 s total for the 8-call worst case. Low risk.
### [MINOR] Long LinkedIn run vs hourly cadence
Worst case 8 calls (up to 17 min with timeouts) can push a run toward the next :05 start; `run-hourly` skips an overlapping run cleanly and `since` is the run start, so nothing is lost. No action needed unless it happens often.

## Personal-data sweep
Added lines of `git diff fb47d31..main` (outside the migration snapshot JSON): no e-mail, phone, owner name, salary figure or address. The only hits are the already-audited `docs/audits/phase-3.md` text (fake persona `16500000`, fixture mails). I did not read `config/` or `.env`.

## Fix tasks
None.

## Tags and ledger (for the automation; I did not commit or tag)
- `audit-9` on `a1af71a` (this phase-end delta audit, continuation of t_2ea13484; also apply `audit-8` per t_2ea13484 if still missing).
