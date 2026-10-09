# Phase-end audit #2b (Phase 2 re-audit) - t_9f75ddd4

Audited point: `c7a6275` (origin/main = main). Previous phase-end audit #2 audited `b71926a`; this audit read `git diff b71926a..main` (48 files, +2327/-162) as a whole, with weight on `enrich.ts` (F1, M2, M6 all edit it).

Verdict: **PASS** (0 BLOCKER, 0 MAJOR, 3 MINOR). `audit-5` must point to `c7a6275` (the audited `main` commit); the report/ledger/batch-2 commit comes after it.

## Setup
- `pnpm install --frozen-lockfile`: ok.
- `pnpm check`: `Test Files  65 passed (65)`, `Tests  996 passed (996)` (was 63 / 924), hook tests `31 passed, 0 failed`. Exit 0.

## Live run: `bin/smoke` (no key), run twice
```
web3career: skipped (WEB3_CAREER_TOKEN not set)
himalayas: ok, found 200, new 200
remoteok: ok, found 6, new 6
remotive: ok, found 5, new 5
weworkremotely: ok, found 15, new 15
hn: ok, found 124, new 124
arbeitnow: ok, found 950, new 950
greenhouse: ok, found 40, new 40
processed 1335, kept 545, rejected 790 (location 379, indonesia 0, role 598, salary 0), flagged 1281
ANTHROPIC_API_KEY not set, LLM stages skipped
scam rules checked 545 postings, suspicious 0
row counts: analysis 1335, companies 704, fx_rates 7, intel 545, llm_calls 0, postings 1340, source_runs 7
```
Arbeitnow and one ATS board (Greenhouse `gitlab`) are now in smoke. Per source (keep/reject): arbeitnow 495/450, greenhouse 1/39, himalayas 8/192, hn 34/90, remoteok 2/4, remotive 2/3, weworkremotely 3/12.

Comparison with audit #2 (65 kept, role 134 of 369): the original five sources now give 49 kept of 350 (65 of 369 before; HN returned 124 instead of 143 posts, so the numbers move with the live feed). The jump to 545 kept / 598 role rejects comes from Arbeitnow (950 postings, 495 kept) and is not a regression of the role filter. The no-key digest shows `Top matches: 0`, `Waiting for scoring: 500`, `Suspicious: 0`; the `scam rules checked` line now prints (M7).

## Break-the-code checks (each reverted with `git checkout -- .`, tree clean)
| Check | Mutation | Result |
|---|---|---|
| (a) seniority-only keep | `resolve.ts`: removed the `roleFamily !== "engineering"` return | 1 test failed: `resolve.test.ts` "seniority alone never keeps: unknown or null family stays unresolved" |
| (b) tier `done` without FX | `enrich.ts` tierStage: `fx_wait` -> `done` when no rate | 2 failed: `enrich.test.ts` "no stored FX rate -> not done, no tier, paid results stored" and "after fx stores a rate the next enrich tiers it with 0 Anthropic requests" |
| (c) suspicious sibling in Top group | `digest/index.ts` `pickLead`: removed the suspicious-first rule | 1 failed: `digest.test.ts` "never puts a group with a suspicious member in Top; shows the suspicious link" |
| (d) consecutive API-error abort | `enrich.ts`: removed `aborted = true` | 1 failed: `enrich.test.ts` "aborts after 3 consecutive API errors: exactly 3 requests, rest pending, exit 1, no key in output" |
| (e) URL cleanup on web3.career | `normalize/url.ts`: removed the `source === "web3career"` early return | 2 failed: `normalize.test.ts` "returns links of source web3career byte-for-byte, whatever the host" and "normalizePending leaves web3career urls untouched" |

## Cross-card review of `enrich.ts`
- Stage order is now extract, resolve, scam, research, registry, fit, tier. Research runs only for `final_decision = keep` (after scam), once per company and run, so suspicious and rejected postings never cause a careers-page fetch or a Haiku call. `BudgetExceededError` is no longer swallowed inside research (`company-research.ts` rethrows) and reaches the loop, which sets `budget_wait` and keeps paid columns (`paidOnly`). Consistent.
- Resume logic: `savedPaidPatch` seeds `ctx.patch` with extraction/fit only when the prompt versions match (`extract-v2` bump means old v1 rows are re-extracted once; bounded by the cap). Extract and fit skip when the patch already has their result, so nothing is paid twice. `fx_wait` rows are not re-selected by `selectPostings`; `retierWaiting` handles them with no LLM call and no key. Legacy `done` rows with the "tier skipped" reason are also picked up, and the marker is dropped.
- The abort counter counts `retry` results and resets when a paid stage answers (even with invalid output). Research warnings never count. Remaining postings are left `pending`, stderr line, exit 1. The cost of a sent-but-failed call is recorded at its reserve (`client.ts`), a pre-send connection failure stays $0 (`isNotSent`).
- No-key path: text-only scam rules run (no RDAP, no extraction); a suspicious result stores `final_decision = suspicious` on a `pending` row; the with-key run recomputes it in the scam stage and overwrites it.
- `docs/running.md` (fx, research, smoke sections) and the four new `docs/decisions.md` entries match the code (stage order, `MAX_CONSECUTIVE_API_ERRORS = 3`, `fx_wait`, redirect rule `isAllowedRedirect`, roleFamily rule order).
- web3.career: `followRedirects: false`; 3xx/401/403 become `SourceError("token rejected (HTTP n)")` without the URL, so the token is not echoed. `cleanUrl(url, source)` skips cleanup by source (byte-for-byte, whatever the host).

## Status of the Phase 2 audit findings
| Id | Finding | Status | Where / test |
|---|---|---|---|
| M1 | `role_unclear` settled by seniority alone | **closed** | `extract.ts` `roleFamily`, `resolve.ts:119-136`; `resolve.test.ts` "seniority alone never keeps" (check a) |
| M2 | `researchCompanyPayPolicy` never called | **closed** | `enrich.ts` `makeResearchStage`; `enrich.research.test.ts` (421 lines), `company-research.test.ts`; docs/running.md |
| M3 | smoke omits Arbeitnow and ATS | **closed** | `bin/smoke`; live run above, `smoke.test.ts` |
| M4 | ATS lists lag in dedupe and digest | **closed** | `dedupe/index.ts`, `digest/format.ts` use `ATS_SOURCE_NAMES`; `ats-sources.test.ts`, `dedupe.test.ts` |
| M5 | group takes link and intel from different members | **closed** | `digest/index.ts` `pickLead`, `askless` guard; `digest.test.ts` (check c) |
| M6 | paid work dropped, no abort, failed calls cost 0 | **partly closed** | closed: `enrich.ts` `savedPaidPatch`/`paidOnly`, `MAX_CONSECUTIVE_API_ERRORS` (check d), `client.ts` reserve cost; open: overlap lock between two `enrich` runs |
| M7a | no scam rules without a key | **closed** | `enrich.ts` no-key branch; `enrich.scam.test.ts`, `enrich.test.ts` |
| M7b | non-engineering titles kept | **closed** (tuning left, see N1) | `role.ts`, `keywords.ts`, `role.test.ts`, `fixtures/golden/role-relevance.json` |
| M7c | RemoteOK mojibake, UTC-offset location lines | open (not in this round) | |
| M7d | prompt-injection hardening | open (not in this round) | |
| F1 | tier finishes without FX | **closed** | `enrich.ts` `fx_wait`, `retierWaiting`; `enrich.test.ts` (check b), `digest.test.ts` |
| F2 | careers redirect to any host / stale FX | **partly closed**: redirects now restricted (`isAllowedRedirect`); stale-FX warning open | |
| F3 | discovered companies keep slug as name, can be stored twice | open | |
| F4 | Arbeitnow stops at 5 pages silently | open | |
| F5 | `failed` never retried, overlap lock, `max_tokens` retry cost, volatile `contentHash` | **partly closed**: repeated API errors now abort; the rest open | |

## Personal-data sweep
`git grep -i` for the owner's name and handle and the owner email: no hits. `git ls-files config`: only `README.md` and the five `*.example.*` files. No IPs/phones beyond documentation ranges in tracked files; salary values in tracked files are the fake example numbers; new fixtures/tests (`fixtures/golden/role-relevance.json`, web3career tests, research tests) contain synthetic data only. Log calls added (`enrich.ts`, `client.ts`) print ids, counts, model, tokens and cost only. Clean.

## Findings
### MINOR N1 `packages/pipeline/src/filters/keywords.ts` - Arbeitnow doubles the unclear-title volume
Live: 495 of 945 Arbeitnow postings are kept and the rule-only digest lists 500 "Waiting for scoring" entries, including "Video Editor for Whiskey Brand", "Benefits Manager", "Media Buyer Executive", "Stage - Support IT". Unknown titles stay `unclear` by design, and with a key `roleFamily` rejects them, but each costs a Haiku extraction first and the rule-only digest is long. Worth another title-phrase pass (or an Arbeitnow-specific note) later; not a defect of this round.

### MINOR N2 `packages/core/src/llm/client.ts:209-217` - failed calls count at reserve against the cap
A sent-but-failed call (e.g. 401 with a bad key, timeout) is recorded at the worst-case reserve although nothing may have been billed. Bounded by the 3-error abort, deliberate (decisions entry), and conservative. Only noted so the owner is not surprised by `llm_calls` rows with cost but zero tokens.

### MINOR N3 `packages/pipeline/src/intel/company-research.ts:defaultFetchPage` - no private-address guard on the careers fetch
The start host is `https://<company domain>/careers`, with the company domain taken from posting data (kept postings only, after the scam stage). Redirects are limited to the same registrable domain or a known ATS host, but nothing blocks a start URL that resolves to a private address. GET only, response text goes to Haiku and is stored only if a quote is verified on the page, 2 pages per company per 90 days, so impact is low. Consider a resolved-IP check when this runs from a machine with internal services.

## Fix tasks
None required. Optional bundle for the PM backlog (low priority): N1 title-phrase tuning; N3 private-address guard; and the items left open by design (M6 overlap lock, M7c, M7d, F2 stale-FX, F3, F4, F5 rest).

## Housekeeping done
- `docs/audits/batch-2.md` written from the final comment of t_65094578, checked for personal data (only fake test keys/emails).
- `docs/audit-ledger.md` cleaned: all rows removed (they were covered by audits 1-4, phase-end #2 and this re-audit; the old file also had a broken table), "Last audit tag: audit-5", counts 0 / 5 and 0 / 10.

## Not done / assumptions
- Per the common rules I did not commit, tag or push. These files are in the audit worktree only: `docs/audits/phase-2b.md`, `docs/audits/batch-2.md`, `docs/audit-ledger.md`. The automation must copy/commit them on `main`, then tag `audit-5` on `c7a6275ca505bdb6dd56e109c61241400ccef030` (the audited commit) and push `main` and the tag.
- Live ATS coverage: only Greenhouse (`gitlab`) was exercised; SmartRecruiters, Workable and Recruitee still have no live check.
- The smoke digest temp dir could not be read in the first run (outside the allowed directories); the second run used a directory inside the worktree, since removed.
