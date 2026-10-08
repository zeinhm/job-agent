# Batch audit #1 (t_12d1fdf6)

Audited: `origin/main` @ 282c920, diff `de4f78b..HEAD` (no `audit-0` tag exists; the ledger rows before t_b7a7cd40 were already cleared, so I took the range from the t_b7a7cd40 merge). Assumption written here as instructed.

Tasks: t_0e4cc928 (low), t_55542219 (high, digest), t_7d626c81 (medium, Phase 2 schema), t_38151c18 (location), t_0f390819 (HN), t_08e114f8 (web3.career), t_ceb93412 (high, Anthropic client + $1 cap), t_0860cdb9 (digest grouping).

## Setup
- `pnpm install --frozen-lockfile`: ok. `pnpm check` (typecheck, eslint+prettier, vitest, pre-commit hook tests): all green, hook tests `31 passed, 0 failed`.

## Breadth
- Personal data / secrets: grepped added lines for API-key patterns, phone numbers, tokens. Nothing found. web3.career live fixture has no token. Golden-set docs/fixtures contain only public job postings. No LinkedIn automation, no submit, no login.
- No `.skip`/`.only`/`.todo` introduced. Spend cap logic lives only in `core/src/llm/client.ts` (a test enforces that only that file imports the SDK).
- Digest never writes outside `data/digests`. Salary reject-reason is now a shared constant (no stringly-typed drift).

## Break-the-code checks
- Cap override (`value > DAILY_LLM_CAP_USD` -> `> 100`): 2 tests fail (good).
- Digest grouping key without title: 4 tests fail (good).
- Both reverted (`git checkout -- .`).

## Deep dives
1. **t_ceb93412 (LLM client, high)**: read client.ts, budget.ts, prices.ts, tests (24). Reserve = worst case (prompt/2 chars + max_tokens at full price) checked before every attempt including the retry, Jakarta-day boundary tested, env can only lower cap, key never logged, no retry on the monthly spend-limit 429. Sound. Notes below.
2. **t_38151c18 (location)**: ran 18 ad-hoc strings through `classifyLocation`. APAC signals win first ("Remote, USA or Indonesia" -> apac_ok), worldwide skips the country check, "Remote, UK / Philippines (Remote) / Countries: US, Canada" -> restricted. Direction of errors is safe (unknown regions fall to `unclear`, flagged not rejected).
Also read: digest (index/group/format), HN, web3career, boards.ts/PartialSourceError, discover.ts, migration 0001.

## Findings

- **[MINOR]** `packages/core/src/llm/client.ts:~160` (`send` catch): timeouts and connection errors are recorded as `cost_usd = 0`, but a request that timed out client-side may still be billed server-side. Spend can exceed what `llm_calls` shows, so the $1 cap undercounts after timeouts. Reproduce: any 60 s timeout on a large generation. Suggest recording the reserve (worst case) for timeouts/unknown-outcome errors.
- **[MINOR]** `client.ts` budget check is check-then-act (`spentOnDay` read, call, then insert). Concurrent `callStructured` calls (Phase 2 bulk extraction might use `Promise.all`) can each pass the check and jointly exceed the cap by (concurrency x reserve). Fine while sequential; document or serialize before adding concurrency.
- **[MINOR]** `client.ts` retry loop: `stop_reason: max_tokens` and `refusal` are retried once with identical input, paying the full cost twice for a deterministic outcome. Cheap to skip the retry for those.
- **[MINOR]** `packages/sources/src/hn/index.ts:98`: `comment.parent_id !== Number(threadId)` drops every comment if Algolia ever omits or changes `parent_id`. The new test asserts this silently drops with no warning (`parent_id: undefined` case), and the adapter returns `[]` with status ok. This is the "silent fallback hides failure" pattern. Suggest: if all considered comments lack `parent_id`, throw SourceError (or warn).
- **[MINOR]** `packages/pipeline/src/digest/index.ts` `buildEntry`: a group shows only the lead member's link, salary and location class. Two different roles with an identical title at one company (e.g. different teams, different pay) collapse to one entry with one link, so the owner never sees the other posting URL. Locations are unioned, links are not. Suggest listing extra links, or at least "(+N similar postings)".
- **[MINOR]** `packages/pipeline/src/filters/keywords.ts`: continents are not in the country list, so "Remote (Europe)" classifies `unclear` rather than `restricted`. Safe direction (flagged), noted for Phase 2 resolver.

No BLOCKER or MAJOR findings.

## Consistency across tasks
- All three multi-board adapters (greenhouse, lever, ashby) use `fetchAllBoards`; error/partial behavior is the same. `since` does not advance on partial failure (run status stays error), which is the safe choice.
- Migration 0001 rebuilds `companies` with `defer_foreign_keys`; there is a migration test (phase2-migration.test.ts). Columns added to `companies` after the rebuild are nullable, so Phase 1 data survives.

## Fix tasks
(All optional, none blocks the phase. Create as high risk per AGENTS.md if taken.)
1. **LLM client: count unknown-outcome calls** - record the reserve (not 0) in `llm_calls` when a request times out or the connection drops; skip the retry for `max_tokens`/`refusal`; add a note or a mutex about concurrent callers.
2. **HN adapter: do not silently drop everything** - throw SourceError when every considered comment lacks `parent_id`.
3. **Digest: show all links of a grouped entry** - list each member's link (or a count) so same-title postings are not hidden.

## Tag
Auditor should tag `audit-1` on 282c920 after this report and clear the 8 listed tasks from `docs/audit-ledger.md`.
