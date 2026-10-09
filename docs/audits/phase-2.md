# Phase-end audit #2 (Phase 2) - t_f2397696

Audited point: `b71926a` (origin/main). Previous tag `audit-4` = `d3d61cf`; `git diff audit-4..main` is docs only (run docs, cron example, docs test). The rest of Phase 2 was audited in batch audits #1, #3 and #4 (audit-2..4) plus the individual high-risk audits. This audit therefore reviewed the phase as a whole, with the break-the-code checks and the live run the card asks for.

Verdict: **FAIL** (2 MAJOR, 5 MINOR). No BLOCKER: nothing harms the owner and no personal data was found.

## Setup
- `pnpm install --frozen-lockfile`: ok.
- `pnpm check` (typecheck, eslint + prettier, vitest, pre-commit hook tests): `Test Files 63 passed (63)`, `Tests 924 passed (924)`, hook tests `31 passed, 0 failed`. Exit 0.

## Live run: `bin/smoke` (no API key)
```
web3career: skipped (WEB3_CAREER_TOKEN not set)
himalayas: ok, found 200, new 200
remoteok: ok, found 6, new 6
remotive: ok, found 5, new 5
weworkremotely: ok, found 15, new 15
hn: ok, found 143, new 143
processed 369, kept 65, rejected 304 (location 279, indonesia 0, role 134, salary 1), flagged 310
== enrich
ANTHROPIC_API_KEY not set, LLM stages skipped
row counts: analysis 369, companies 283, fx_rates 7, intel 65, llm_calls 0, postings 369, source_runs 5
```
All five keyless sources ok; the skip line printed; the rule-only digest was written (Top matches 0, Waiting for scoring 65, Needs a look, Suspicious none, Source health, LLM spend "$0.0000 of $1.00 cap").
Extra live checks outside smoke: the Arbeitnow adapter fetched 613 postings (ok, no warnings). SmartRecruiters, Workable and Recruitee were **not** verified live: smoke does not cover them and they need a real board slug (a test against a large board was stopped because of the 2 s per-job interval). Smoke also skips Arbeitnow although it is keyless (see M3).

## Break-the-code checks (each reverted with `git checkout -- .`)
| Check | Mutation | Result |
|---|---|---|
| Suspicious never reaches Top matches | removed the fit-stage `final_decision !== "keep"` guard and the post-scam `break` in `enrich.ts` | 3 tests failed (`enrich.fit.test.ts`, `enrich.scam.test.ts`, `e2e.phase2.test.ts`: `expected 82 to be null`) |
| $1/day cap | `effectiveCapUsd` raise guard `value > 1` changed to `> 1000` | 2 tests failed (`llm.test.ts` "=5 is ignored with a warning", "a raised one is not") |
| Floor in the ask | `askIdrMonth < floor` changed to `< 0` | 2 tests failed (`tier.test.ts` "raised to the floor", "raises every tier ask ... below a higher floor") |
| Role filter | disabled the non-engineering reject | 5 tests failed (role.test, role.golden, process.test, digest.test) |

Guards are real. Reading the budget code: reserve = estimated prompt tokens x input price + `max_tokens` x output price, checked before every attempt including the retry; `spent` comes from `llm_calls`. No cap bypass found.

## Personal-data sweep
`git grep` for the owner's name and handle, emails, IPs, phone patterns, salary values. Results: only synthetic `*@gmail.com` scam excerpts (`fixtures/golden/scam.json`, scam tests, research doc), the public repo URL in `package.json`, and a `bin/escalate` comment. Salary values in tracked files are the fake `config/salary.example.yaml` numbers. Only `config/*.example.*` and `config/README.md` are tracked. Log calls in `packages/pipeline/src` and `core/src/llm` log ids, counts, model, tokens and cost only, never posting text or the CV. Clean.

## Findings

### MAJOR M1 packages/pipeline/src/intel/resolve.ts:119-131 - `role_unclear` is settled by seniority alone, so non-engineering roles become "keep: matches the target"
`resolveRole` returns keep for `seniority` senior or lead, and the extraction schema (`extract.ts:14-47`) has no role-family field. Any title the rule filter left unclear (it keeps everything it does not recognise, e.g. "Senior Global Content Manager", "Director, Global GTM Strategy & Operations", "Head of Operations", all in the smoke digest's kept list) is kept once Haiku says "senior", with the reason line "Role: the posting asks for senior level, which matches the target". The owner then sees a false explanation, and the posting costs a Sonnet fit call and can reach Top matches. Repro: `resolveFlags({ruleDecision:"keep", flags:["role_unclear"], extraction:{...seniority:"senior"}})` returns keep. Fix: add a `roleFamily` (engineering / non-engineering) fact to the extraction, or leave `role_unclear` unresolved on seniority alone and let it stay under "Needs a look".

### MAJOR M2 packages/pipeline/src/intel/company-research.ts:131 - `researchCompanyPayPolicy` is never called
`git grep researchCompanyPayPolicy -- packages` finds only its own definition and its test. It is not an `enrich` stage, not a CLI command, and not in `scripts/crontab.example`. So `companies.pay_policy_checked_at` is never set, `llm_calls.purpose = company_research` never occurs, and the careers-page registry (PLAN 5.2, decisions "max 2 pages per company per 90 days") does not exist at runtime. `docs/running.md:92` says Haiku is used for "extraction and company research". Policy stays `unknown` unless the posting states it, so asks fall back to regional plus the text answer: conservative, not harmful, but a Phase 2 deliverable is unreachable. Fix: wire it into `enrich` (after extract, before tier, handling `BudgetExceededError` like the other stages) or record an explicit decision to defer it and correct the docs.

### MINOR M3 bin/smoke:13 - smoke omits Arbeitnow and every ATS adapter
`SOURCES=(himalayas remoteok remotive weworkremotely hn)`. Arbeitnow is keyless (it worked live above), so a break in it would not be caught by the phase-end live run. Add it; ATS adapters could be exercised with a public example company in the temp config.

### MINOR M4 packages/pipeline/src/dedupe/index.ts:7 and packages/pipeline/src/digest/format.ts:1 - ATS source lists lag behind
Both hard-code `greenhouse, lever, ashby`, while `ATS_SOURCE_NAMES` (`keywords.ts`, used by scam verification) and the config enum have six. Effect: a SmartRecruiters / Workable / Recruitee posting ranks equal to an aggregator copy, so the aggregator copy can become canonical, and the digest does not prefer the ATS `apply_url`. Fix: use `ATS_SOURCE_NAMES` in both.

### MINOR M5 packages/pipeline/src/digest/index.ts:115 - group picks intel and link from different members
`i` comes from the first group member with a fit score, but `p` (title, link, salary) comes from `group[0]`. If group[0] is a suspicious or unscored sibling and another member is fit-scored, the Top match shows the scored member's fit and scam score with the other posting's link. Unlikely (same company + title, different locations), but it is the cloned-listing case scam.ts guards against. Fix: take link and `p` from the member that supplied `i`, and never show a group as Top if any member is suspicious.

### MINOR M6 packages/core/src/llm/client.ts:200-205 and enrich.ts:359-383 - failed or timed-out calls cost 0 and are not stopped; paid work is dropped
`record("error", null)` stores $0 even if a timeout was billed (small cap undercount). On `retry`/budget, `upsertIntel(..., {})` discards the already-paid extraction, so Haiku is paid again the next run. A systematic API error (bad key) makes one failing call per posting instead of aborting the run. Also no lock stops two overlapping `enrich` runs from each passing the cap check (overshoot bounded by one call). Fix: persist the extraction patch before later stages; abort after N consecutive API errors.

### MINOR M7 rule-only mode and rule noise
- Without a key, `scoreScam` never runs (it lives inside `enrich`), so the rule-only digest lists unvetted postings with live links under "Waiting for scoring". The scam rules need no LLM and could run in `process`.
- Role filter keeps non-engineering titles that contain a target word because the target check runs first: "Account Executive, Web3" and "Technical Recruiter - React Engineers" classify as keep. Unrecognised non-engineering titles ("Customer Care Executive", "CRM Manager", "Web Designer") are `unclear` and kept; 65 kept postings in the smoke digest are mostly noise. Extend `ROLE_NON_ENGINEERING_PHRASES` and check non-engineering before the target for web3 words.
- RemoteOK titles show mojibake ("Telefondienst fÃ¼r ..."), probably double-encoded upstream; the digest location line prints all 37 UTC offsets for Himalayas "Worldwide" postings.
- Prompt injection: posting text goes to Haiku and its facts drive scam signals and tier (a scam text could instruct "contactChannels: []"). Impact is low, since the model never makes a decision, but the scam rules also run on the raw text (`scam.ts`), which limits it.

## Cross-card consistency
- Stage order in `enrich.ts` matches the conventions (extract, resolve, scam, registry, fit, tier; fit only for keep). Budget handling is consistent: every stage lets `BudgetExceededError` reach the loop, which sets `budget_wait`. Logging is consistent and clean.
- Source adapters handle partial failure and warnings the same way (batch 4 notes). Three ATS lists exist (M4).
- Ledger: `docs/audit-ledger.md` still says "Last audit tag: (none yet)" and holds every Phase 2 row; it is stale relative to audits 2-4.

## Fix tasks (high risk, PM to create)
1. Resolve role_unclear without seniority-only keep (M1): add a role-family fact or leave unresolved; update the golden set and the "why" wording.
2. Wire company pay-policy research into `enrich` (M2), or record a deferral in decisions.md and fix `docs/running.md`.
3. Add Arbeitnow (and one ATS board) to `bin/smoke` (M3); use `ATS_SOURCE_NAMES` in dedupe and digest (M4).
4. Digest groups: link and intel from the same member, no Top entry with a suspicious sibling (M5).
5. Enrich robustness: keep paid extraction on retry/budget, abort after repeated API errors, run scam rules without a key, extend non-engineering role phrases (M6, M7).

## Not done / assumptions
- Per the common rules I did not commit, tag (`audit-5`), clear the ledger or push; the automation does that. Because the verdict is FAIL, the tag and ledger clear should wait for the fix tasks.
- Live checks of SmartRecruiters, Workable and Recruitee were not completed (see above).
