# Batch audit #7 (audit-6..origin/main, HEAD 35ff06a)

Covered: t_fbc60316, t_74a60bf8, t_4eaabb57, t_1700ae4a, t_9192fcfc, t_f4d714c1, t_60aa9f53, t_6e6fdf4a, t_45be12f8, t_7b240d68, t_4f0c3e02, t_e1bd0972, t_bc1f4362, t_02528e72, t_172f1d5e, t_47589c2e (105 files, +5104/-701).

## Setup
- `pnpm install --frozen-lockfile`, `pnpm typecheck` (tsc -b), `pnpm lint`: clean.
- `pnpm test` run 1: 2 failed / 1677 passed (one was `e2e.test.ts` "phase 1 pipeline end to end"). Runs 2 and 3: 86 files, 1679/1679 passed. The first-run failures were not reproduced (likely timeouts under load).

## Breadth
- Personal data / secrets: grep of the added non-test lines for tokens, emails, phone numbers, linkedin cookies, `.only`/`.skip`/TODO: nothing relevant (hits are docs/env var names only).
- Guardrails: LinkedIn: `packages/core/src/http.ts:217` refuses linkedin.com, *.linkedin.com and lnkd.in before any request; `linkedin_posts` reads only Brave's result list, stores URL + plain-code facts (no Brave title/snippet; verified in `mapResult`), now off by default (t_47589c2e). JobSpy stays logged out; paging capped at 100 results/search, 10 s between calls, block => stop, no retry. No submit/apply automation added.
- Drift: decisions.md entries exist for linkedin_posts, YC removal, disabled-by-default. YC directory code and fixtures removed with tests for "YC host never requested".
- Cross-task consistency: all adapters updated to the new `fetch(since)` signature uniformly; `bin/run-hourly` stale-lock takeover is race-safe (re-check inside takeover mkdir lock).

## Depth (chosen: language/location filters, linkedin_posts + Brave cap, JobSpy paging)
- Language filter `protectedLanguages` (negation protects languages): probed 8 descriptions through `classifyLanguage` on audit-6 and HEAD. Outputs identical on all 8, so no regression from this batch, but three false ACCEPTs remain (see MINOR 1).
- Location: "authorized/authorised to work in the US" restricted; "...Indonesia or the US" still apac_ok; "your country" covering phrases did not unrestrict a US-authorization line. OK.
- Brave cap: counter file fails closed on corrupt content, new UTC day resets. OK.
- JobSpy: `lookbackHours` clamps 1..24, future `since` => 1; worker validates offset+wanted<=100.

## Findings
- [MINOR] packages/pipeline/src/filters/language.ts (protectedLanguages / BARE_CONTINUATION): a bare-continuation negation about something else protects the previous segment's language. Probe: "Candidates must be fluent in German and not required to relocate." => `ok` (should reject German). Same result on audit-6, so pre-existing but the new protection logic makes this class of error easy to hit. Also pre-existing false accepts: "German is required. ..." and "French and German required." => ok (patterns do not match these phrasings).
- [MINOR] packages/sources/src/discovery/search.ts `reserveBraveRequest`: read-modify-write of brave-usage.json is not atomic; overlapping callers (hourly linkedin_posts if enabled, weekly discover-companies) can lose a count and overshoot the 30/day cap by a few. Low impact while linkedin_posts is disabled.
- [MINOR] workers/jobspy/run.py BLOCK_PATTERN: bare "429"/"403" no longer match unless next to status wording (deliberate to avoid false blocks); a block logged in an unexpected format would be treated as an empty result. Acceptable, worth a live check.
- [MINOR] Test flake: first full run had 2 failures (e2e phase 1 among them), not reproducible in 2 reruns. Possibly time-sensitive under load.
- Note: `config/companies.example.yaml` still lacks the `sources:` block (needs PM/owner, per decision t_47589c2e).

## Fix tasks
(none required; optional, low priority)
1. Language filter: a negation not naming a language must not protect a language from a preceding "must be fluent in X" segment; add patterns for "<Lang> is required" / "<Lang> and <Lang> required".
2. Make the Brave usage counter atomic (lock or exclusive write) and/or note the overshoot in docs.
3. Investigate the e2e/phase-1 test timeout flake (raise timeout or remove real timer dependence).

## Verdict
PASS: no BLOCKER/MAJOR. Tag audit-7 at 35ff06a (automation) and clear the 16 tasks from the ledger.
