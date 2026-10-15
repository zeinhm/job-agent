# Batch audit #8 (audit-7..origin/main, HEAD 4111307)

Tasks covered: t_ce49d729 (Phase 4 plan/conventions), t_1099c9eb (Phase 4 schema, migration 0004), t_05df2eda (dashboard Hono server, high), t_99deaa3f (seed-demo), t_c269b5ab (dashboard web skeleton), t_22e91591 (fetch-questions).

## Setup
- `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`: clean.
- `pnpm check` full parallel run: 1773 passed, 2 failed (`packages/pipeline/test/e2e.test.ts` and a `smoke.test.ts` case): "Test timed out in 5000ms". Re-run of just those two files: 24/24 pass in 6.9 s. Load-dependent timeouts, not logic (MINOR-1).

## Breadth
- Personal data scan of the added lines (emails, +62 phones, API key patterns): no hits. Fixtures use fake demo companies; seed-demo labels rows "Fake demo posting".
- Guardrails: no LinkedIn, no submit, no CAPTCHA. fetch-questions is GET-only against public ATS JSON endpoints, 1 req / 2 s per host, stops a host after 401/403/429, default cap 50/run. Slugs and job ids are regex-validated before being put in a URL/hostname (no host injection).
- Dashboard: bound to hard-coded 127.0.0.1 (no flag or env changes it), Host guard (421), JSON-only + same-origin check on non-GET, CSP + nosniff headers, no CORS, static handler blocks traversal and `/api`. Web: ESLint rule + test ban raw HTML; ExternalLink only links http(s). Error logs carry route pattern only.
- seed-demo refuses the default DB and any DB under `data/` (including main checkout's data/ from a worktree).
- Migration 0004 matches schema (new tables only, no data-destroying changes). Run-hourly adds fetch-questions in order; bin/smoke dash unsets keys and uses temp DB.
- Scope/deps: new deps (hono, @hono/node-server, vite, react, tanstack query) are consistent with the Phase 4 plan/decision entry.

## Depth (most security-relevant: t_05df2eda server guards; t_22e91591 network client)
Break-the-code checks (reverted with `git checkout -- .`):
- Host guard check replaced by `false`: 7 tests fail (host guard, mutation-guard ordering, headers, real-socket test). Guard is well covered.
- Host-blocking condition (401/403/429) in `QuestionsHttp` disabled: test "stops a host after 429/403/401 ..." fails. Covered.

## Findings
- [MINOR-1] packages/pipeline/test/e2e.test.ts:228, smoke.test.ts:310: default 5 s timeout flakes under full parallel `pnpm check` on this machine (suite now ~93 files). Raise the per-test timeout for these two so the gate doesn't fail spuriously.
- [MINOR-2] packages/pipeline/src/seed-demo.ts:34: the data/ protection is path-string based; a symlinked path into data/ would pass. Low risk (demo rows are fake, owner invokes it explicitly); resolve with realpath if touched again.
- [MINOR-3] packages/pipeline/src/questions/index.ts:63: relies on the shared `httpGet` for redirect handling; I found no explicit redirect policy there, so a 3xx from an ATS host could be followed to another host. Public GET of JSON only, so impact is low; consider pinning to the expected host.

No BLOCKER or MAJOR findings.

## Fix tasks
- Raise timeouts on e2e.test.ts and smoke.test.ts (full-run cases) to avoid flaky `pnpm check` (MINOR-1). Optional: MINOR-2/3 as hardening.

## Assumptions
Previous tag lookup (`git tag | grep`) was blocked by the sandbox; I used audit-7 from the card (the log range audit-7..HEAD resolved fine). I did not create the audit-8 tag or edit the ledger (automation's job).
