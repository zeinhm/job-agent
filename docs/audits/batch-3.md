# Batch audit #3 (audit-2..origin/main, b76ed55)

Covered: t_4941a83b (scam, high), t_63f270d0 (company research), t_72aefdac (tier/ask, high), t_5bac0f79 (SmartRecruiters), t_766d6b7c (fit), t_73f6affa (ranked digest), t_b313841a (Workable). 59 files, +8.7k lines.

## Setup
Fresh checkout of origin/main: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint` (eslint + prettier) clean. `pnpm test`: 56 files, 865 tests passed.

## Breadth
- No personal data, secrets or LinkedIn automation found. Fixtures use fake personas / public ATS data. Company research refuses LinkedIn hosts, including via redirect.
- No `.skip`/`.only`/`it.todo` introduced. No new dependencies.
- Decisions entries exist for the tier floor-vs-max rule and for scam (incl. the DECISIVE-set fix from the earlier audit finding).
- Adapters (Workable, SmartRecruiters) use the shared `fetchAllBoards`, same 404-skip, SourceError and invalid-item-ratio handling. Consistent.

## Depth (high-risk tasks): scam.ts, tier.ts, enrich wiring
Break-the-code checks (reverted after):
- Remove `chat_contact` from DECISIVE: 2 scam tests fail. Good.
- Disable the floor raise in tier.ts: 2 tier tests fail. Good.
Tier decision flow matches PLAN 5.3 (US note -> unknown, floor after normalisation in IDR/month, hourly x160, year/12). Scam score reasons sum to the score; domain-age lookup failure scores 0.

## Findings
- [MAJOR] packages/pipeline/src/enrich.ts (tierStage, ~line 225): when no IDR FX rate is stored, the stage returns a `tier skipped: no IDR FX rate stored` reason, but the posting is still saved as `status = done`. `selectPostings` only picks rows with no intel row or status pending/budget_wait, so the posting is never re-tiered after `fx` runs. Result: permanent silent loss of tier/ask (digest shows "no tier / no ask decided", rank loses the salary bonus) for every posting enriched before the first `fx`. Reproduce: run `enrich` on a DB with no `fx_rates` rows, then `fx`, then `enrich` again: the posting is not revisited. Fix: leave the posting pending (or mark it for retry) when the rate is missing, or re-run the tier stage for done rows with a null tier.
- [MINOR] packages/pipeline/src/intel/company-research.ts: `researchCompanyPayPolicy` is exported but called nowhere outside tests, so PLAN 5.3's "unknown -> research company" step never runs in the pipeline. Tier falls straight to the unknown branch. Confirm a later card wires it, otherwise add one.
- [MINOR] company-research.ts:64-70 + core/src/http.ts: `allowRedirectTo` only blocks LinkedIn. A careers page on a company domain taken from posting data can redirect to any host, including private addresses. Low impact (GET, text sent only to the LLM), but restrict redirects to the same registrable domain.
- [MINOR] enrich.ts tierStage: `getRate` returns the latest rate on or before the day with no age limit, so a months-old rate silently produces the ask. Consider warning when the rate is older than a few days.

## Deep dives
t_4941a83b and t_72aefdac (both high, QA-only): most security- and money-relevant. t_63f270d0 read in full for the scraping guardrail.

## Fix tasks
1. Tier stage must not finish a posting when the FX rate is missing (keep pending / re-tier later) + test: enrich without rate, then with rate, tier gets filled. (high risk, fix task)
2. Wire company pay-policy research into the unknown-policy path, or confirm a card exists. (MINOR)
3. Restrict careers-page redirects to the same registrable domain; warn on stale FX rate. (MINOR)

Verdict: FAIL (one MAJOR).
