# Audit: digest-quality fixes (round audit, t_c9a36eac)

Audited `main` at `3bb73bf` (plus `1314e82`, a later `bin/smoke` / role-prompt tweak with no pipeline code) against `7c69896`.
Verdict: **PASS** (no BLOCKER or MAJOR). 4 MINOR notes.

## Setup and totals
- `pnpm install --frozen-lockfile`, `pnpm check`: typecheck, eslint, prettier clean; hook tests `31 passed, 0 failed`.
- `pnpm test`: **Test Files 69 passed (69), Tests 1262 passed (1262)**.

## Union limit (step 3)
`schema-limits.test.ts`: 9 passed (asserts each wire schema <= 12; stored `ExtractionSchema` = 19, not sent). Counts measured with a throwaway test on both commits:

| schema sent as output_config | 7c69896 | main |
|---|---|---|
| extraction (`ExtractionWireSchema`) | 1 | 1 |
| fit (`FitSchema`) | 0 | 0 |
| company research | 0 | 0 |

All <= 12; extraction no higher than before.

## Before / after smoke (step 4)
Same hour, same live feeds (`bin/smoke`, example config, no key, no LLM). `7c69896` and `main` were run by switching the review checkout between the two commits (a second `git worktree add` was not permitted for this role).

| | before (7c69896) | after (main) |
|---|---|---|
| process | `processed 1728, kept 102, rejected 1626 (location 1497, indonesia 0, role 855, salary 1, language 262), flagged 1692` | `processed 1728, kept 101, rejected 1627 (location 1498, indonesia 0, role 855, salary 1, language 262), flagged 1692` |
| scam rules | checked 102, suspicious 2 | checked 101, suspicious 2 |
| `companies` with a domain | **0** of 691 | **17** of 691 |
| HN titles that are a URL / location / field label (crude pattern) | 15 | 12 |

Per-source discover lines (identical in both runs): himalayas found 200 new 200; remoteok 12/12; remotive 3/3; weworkremotely 17/17; hn 38/38; arbeitnow found 1442 new 1432; greenhouse 30/30.

The kept 102 -> 101 and location +1 come from the new HN location/title parsing at normalize time (same 38 HN comments).

17 domains sampled after: all company-owned (e.g. freeform.co, livekit.io, netbird.io); no board/ATS/shortener host.

HN titles after (no LLM key): URL-only first lines now show `(no role title)` (3 rows). Still present as raw `postings.title`: `Full-time` (x4), `Full Time`, `Full-time https://netbird.io/careers`, `Full-time – https://estuary.dev/`, `Location: Bangalore, India (IST, UTC+5:30)`, `Company: esumry.com`, plus job-seeker replies kept. See M1.

## `process --reprocess` on the before DB (step 5)
Run with main code on the before smoke DB (library entry points `runProcess` + `runReprocess`, as the CLI does, via a throwaway test, because env-prefixed CLI calls were not permitted to this role). Output:
```
llm_calls before: {"c":0}
== run 1
processed 0, kept 0, rejected 0 (location 0, indonesia 0, role 0, salary 0, language 0), flagged 0
reprocessed 1728 postings: rules keep->reject 0, reject->keep 0; resolve keep->reject 0, reject->keep 0; now pending for enrich 0
exit 0,0
== run 2   (same two lines, 0 changes)
llm_calls after: {"c":0}
```
Second run: 0 changes. No `llm_calls` row written. 0 changes on the first run is expected: the smoke has no LLM extraction (resolve has nothing to act on) and reprocess does not re-normalize (see M2). The resolve paths are covered by `reprocess.test.ts` (14 tests).

## Break-the-code checks (step 6)
Each reverted with `git checkout -- .`; each failed at least one test.

| check | change | result |
|---|---|---|
| (a) | digest `fit_score < TOP_MATCH_MIN_FIT` -> `<=` | FAIL: `Top matches threshold > fit 60 is a Top match, fit 59 goes to Scored, not a fit` |
| (b) | family reject only when `role_unclear` flagged | 14 tests fail (resolve.test, enrich.fit.test, reprocess.test) |
| (c) | drop `FIT_RETRYABLE_SQL` from `selectPostings` | 3 fail: failed fit scored next run; 3-failure cap; digest retry text |
| (d) | job-board host list not applied in `companyDomainFromUrl` | 3 fail: web3.career, hacker news, linkedin never a company domain |
| (e) | reprocess re-insert with `digested_at: null` | FAIL: `rejects old keeps with the current rule and keeps digested_at` |

## Cross-card review (step 2)
- `extract.ts` / `prompts/extract.ts`: roleFamily (10 values) and roleTitle land together in one prompt version `extract-v5`; wire schema keeps union count 1. Old rows parse: missing `roleFamily`/`roleTitle` -> null; v3 `"engineering"` -> null via `z.preprocess`; v3 `"non_engineering"` still valid. A v3 extraction is not reused by enrich resume (version mismatch), so a row keeps a null family until re-extracted.
- `resolve.ts`: `familyReject` runs in `resolveRole` and unconditionally in `resolveFlags` (needed for postings without `role_unclear`, proven by check (b)); null family settles nothing; rule rejects never overturned.
- `enrich.ts`: order extract -> resolve -> scam -> research -> registry -> fit; resolve rejects before the Sonnet call. Failed-fit retry capped at `MAX_FIT_ATTEMPTS = 3` via a `fit_attempt:n` marker in `resolved_reasons`; extract failures never reselected. Retry reuses the stored extraction. Research summary line printed.
- `llm/client.ts`: `stop_reason` logged on every ok call, `llm output invalid` warn line (no output text), no identical second call after `max_tokens`. `FIT_MAX_TOKENS` 1536. Fit reasons truncated in code instead of failing the score.
- `digest/index.ts`: `Scored, not a fit` section at fit < 60, HN title from extracted `roleTitle` only for `source = hn` (postings.title untouched), failed-fit text with retry / "3 times" wording.
- Docs: `decisions.md` entries (2026-10-09/14) match code; `running.md` consistent with CLI flag and digest sections.
- LLM paths fixture-only: `llm.test.ts` uses msw with `onUnhandledRequest: "error"`; enrich/research tests inject `fetchPage`. No test reaches the network.
- Personal-data sweep: added diff has no emails, phones or salary values beyond fixture `90000/130000 USD`; only IP is `203.0.113.5` (RFC 5737) in a test; only `config/*.example.*` and `config/README.md` tracked; no `data/`; HN fixtures invented or the existing public one.

## Findings
- **M1 [MINOR] `packages/sources/src/hn/parse.ts` (`parseFirstLine`)**: "no HN title that is a URL or location" only partly met. Live smoke still stores titles like `Full-time`, `Full Time`, `Location: Bangalore, India (...)`, `Company: esumry.com`, `Full-time https://netbird.io/careers` (field-label segments, or `Full-time – https://...`). Small effect: rows get `role_unclear`, and once enriched the digest shows the extracted `roleTitle`; until then "Waiting for scoring" shows the raw title. Repro: `bin/smoke <dir>` then `select title from postings where source='hn' and title like 'Full%'`.
- **M2 [MINOR] `packages/pipeline/src/reprocess.ts`**: reprocess re-applies filters/resolve to stored normalized rows only; normalize-time changes (HN title/location parse, company domain other than via `backfillCompanyDomains`) are not re-applied. In the smoke, 1 posting moved keep->reject at normalize in the fresh run but stays kept after `--reprocess` on the old DB. Document in `docs/running.md` or accept.
- **M3 [MINOR] `normalize/company-domain.ts`**: a company's domain is the first company-owned link in any posting with that name, including anonymous HN comments; research then fetches `https://<domain>/careers` and can set a pay policy from it. A comment claiming another firm's name with its own link could set that firm's domain. Needs a deliberate attacker, but the policy feeds tier/ask. Suggest: auto-fill only from non-HN sources, or require the registrable name to resemble the company name.
- **M4 [MINOR] `fit.ts` / retry cap**: the marker lives in `resolved_reasons` as a JSON string match (`like '%"fit_attempt:n"%'`); if research ever overwrote `resolved_reasons` on a failed row the cap would reset. Currently safe (tests cover the 3-run cap). Add a comment.

## Fix tasks
None required (verdict PASS). Optional follow-ups: (1) HN parser: skip field-label segments (`Full-time`, `Location:`, `Company:`) and `Dash + URL` forms when choosing the title; (2) running.md note that `--reprocess` does not re-normalize; (3) restrict domain backfill sources (M3).

## Note for the owner
After pulling, run `process --reprocess` on the real DB. Old extractions keep a null role family / role title until re-extracted (open question in `docs/digest-quality-backlog.md`).

## Process notes
- A second detached worktree could not be created by this role; before/after were run sequentially in the review checkout, back to back in the same hour.
- `process --reprocess` was exercised through `runProcess` + `runReprocess` in a throwaway vitest (temp files removed; working tree clean).
