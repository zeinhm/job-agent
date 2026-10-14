# Batch audit #5 (t_9d293d87)

Range: `git diff audit-4..origin/main` (49 commits, 116 files, +13.3k/-0.4k). Verdict: **PASS** (no BLOCKER/MAJOR; 4 MINOR).

## Setup
`pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`: clean. `pnpm test`: 71 files, 1370 tests passed.

## Breadth
- Secrets / personal data: grep of the non-docs diff for `sk-ant`, key assignments, emails, phone prefixes, LinkedIn login/cookie terms found only redaction code and test fixtures with obviously fake keys (`sk-ant-test-key-0000`). `.env.example` has empty values only. Pre-commit hook unchanged except `rm -rf` in its test cleanup.
- Guardrails: no LinkedIn code, no CAPTCHA handling, no submit. New network code (`apply-links/boards.ts`) calls only public logged-out ATS JSON APIs (Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee), 2 s minimum interval via `httpGet`, stops a host for the run on 429, slugs validated by `SAFE_SLUG` before building URLs, responses Zod-validated.
- LLM client: error text redacted (configured key + `sk-ant-*`) and capped at 300 chars; request headers never read; timeouts book the reserved worst case so the daily cap cannot be exceeded; a `max_tokens` cut-off is not retried identically. Consistent with decisions.
- Drift: role-family gate (`TARGET_ROLE_FAMILIES = frontend, fullstack`) and Americas-hours reject have decision entries (decisions.md 2026-10-09). `unknown_tier_ask` fallback keeps the floor check (tier.ts:195).
- Cross-task consistency: `digested_at` is preserved when `reprocess` rewrites an analysis row (`analyze` copies it from the group); rejection reasons (`language`, `unpaid`) are counted in the digest from the same classifiers/intel data used to decide.

## Depth (why)
Chosen because they decide silently what the owner never sees (false rejects) or touch money/network:
1. `apply-links` (new network code), 2. salary tier / `unknown_tier_ask` and resolve (unpaid, family, hours), 3. location truth + language filters, 4. `process --reprocess`.

Break-the-code checks (all reverted with `git checkout -- .`, tree clean):
- Disabled the floor raise in `tier.ts` -> 4 tier tests fail.
- Disabled `unpaidReject` in `resolve.ts` -> 4 tests fail (resolve + enrich.fit).
- Disabled the 429 host block in `boards.ts` -> `stops lookups on a host after a 429...` fails.
All three guards are tested.

Probe runs of `classifyLocation` / `classifyLanguage` on hand-written inputs (not committed) gave the findings below; most cases behaved correctly (US/Canada only -> restricted; "CET overlap" -> not a residence limit; "English or German" / "German is a plus" -> ok; "Fluent German" -> reject).

## Findings
- [MINOR] `packages/pipeline/src/filters/location.ts` (pre-existing generic `must be located in` phrase fires before the new `findTextRestriction`): `Remote` + "Candidates must be located in Europe or Asia." -> `restricted`. A place list that includes Asia is rejected, although the new step-2 text logic was meant to treat covering places as no change. Silent false reject; reproduce with `classifyLocation({locationText:"Remote", descriptionText:"Candidates must be located in Europe or Asia."})`.
- [MINOR] `packages/pipeline/src/filters/language.ts`: `\w+ speaker` pattern rejects "Our product is available in French speaker markets" (-> reject "French speaker"). Marketing wording, not a requirement. False reject, low frequency.
- [MINOR] `classifyLocation`: location "Worldwide" plus description "Must be authorized to work in the United States." -> `worldwide`. Work-authorization limits are not read as restrictions (pre-existing behaviour, not introduced here); the LLM resolve stage does not see it either since no flag is raised.
- [MINOR] `bin/agent-step` runs `git checkout main` and `git stash push` in the main checkout, which AGENTS.md forbids for agents (the stash line pre-dates this batch; this batch adds the external `~/projects/job-agent-ops/bin/push-main` call, which is outside the repo and not reviewable here). Automation script, not pipeline code; flag for the owner to confirm intent.

Not an issue but noted: digest "Rejected in the last 24h" adds `unpaidCount` (intel, by `updated_at`) to analysis rejects; a posting rejected by both after a `reprocess` could be counted twice. Cosmetic.

## Fix tasks
1. **Location: covering place inside a "must be located in" list** - make the generic restriction phrase defer to the covering-place check (Asia/APAC/Indonesia/worldwide in the same sentence), add the case to `fixtures/golden/location.json`. (MINOR)
2. **Language: "<Language> speaker(s)" as a noun phrase** - require a requirement context ("native", "must", "fluent", "looking for") or exclude "speaker markets/users/countries"; add golden case. (MINOR)
3. **Location: work-authorization wording** - decide (owner/PM) whether "must be authorized to work in <country not Indonesia>" should be restricted or flagged `location_unclear`; add a decision entry. (MINOR, needs a decision first)
