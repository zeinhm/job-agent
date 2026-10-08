# Phase 2 conventions (PM decisions, binding for Phase 2 cards)

Phase 2 = Intelligence (PLAN 8): pay context, tiers, scam scoring, fit scoring, pay-policy registry, company discovery.
Done when: a ranked digest where each posting shows why it scored what it did.

Everything in `docs/phase-1-conventions.md` still applies (worktrees, HTTP client, errors, Zod, fixtures, DB, QA FAIL
loop) unless this file says otherwise. Changing anything here takes a PM comment on the card plus a decisions.md entry.
If a card and this file disagree, this file wins; if this file and PLAN.md disagree, block.

## Order of work
1. **Rule quality first** (`docs/phase-1-live-findings.md`): role relevance, location bugs, HN replies, web3.career
   redirect, digest grouping, posting refresh. Rules are free; every posting they reject never costs an LLM call.
2. **LLM stages** on postings that pass the rules: extraction (Haiku) -> resolve unclear flags -> pay-policy registry ->
   scam score -> fit score (Sonnet) -> tier + ask. Then the ranked digest.
3. **Sources:** SmartRecruiters, Workable, Recruitee, Arbeitnow, company discovery, polling discovered companies.

## Packages and files
| What | Where |
|---|---|
| Anthropic client, price table, spend ledger, daily cap | `packages/core/src/llm/` (exported from `@job-agent/core`) |
| Enrich command (runs the LLM stages) | `packages/pipeline/src/enrich.ts`, CLI command `enrich` |
| Stages | `packages/pipeline/src/intel/<stage>.ts`: `extract`, `resolve`, `registry`, `company-research`, `scam`, `fit`, `tier` |
| Prompts | `packages/pipeline/src/intel/prompts/<stage>.ts`, each exports `PROMPT_VERSION` (bump on every change) |
| Rule keyword lists (incl. role relevance, scam keywords) | the existing single module `packages/pipeline/src/filters/keywords.ts` |
| New source adapters | `packages/sources/src/<source>/index.ts` + one line in `registry.ts` |
| Company discovery | `packages/sources/src/discovery/` + CLI command `discover-companies` |

Merge hotspots: `enrich.ts` (each stage card adds one stage), `keywords.ts`, `registry.ts`, `cli.ts`, `schema.ts`.
Keep every existing entry when resolving conflicts.

## Schema (one migration card, t_7d626c81, before any card that needs these)
- `postings`: add `content_hash` (text) and `updated_at` (ISO, nullable) for the refresh card.
- `companies.ats_type` enum and the `companies.yaml` Zod enum: add `smartrecruiters`, `workable`, `recruitee`.
- `companies`: add `discovered_via` (`config | search | manual`, nullable), `discovered_at` (ISO, nullable),
  `pay_policy_checked_at` (ISO, nullable). Existing `pay_policy` (`location_agnostic | location_adjusted | unknown`)
  and `pay_policy_source` (free text, e.g. `posting:<posting id>`, `careers:<url>`) are the registry.
- New table `llm_calls`: `id, day` (YYYY-MM-DD Asia/Jakarta), `model, purpose` (`extract | company_research | fit`),
  `posting_id` (nullable), `company_id` (nullable), `input_tokens, output_tokens, cache_read_tokens, cost_usd`
  (text decimal), `status` (`ok | error`), `created_at`.
- New table `intel` (one row per canonical posting, `posting_id` unique): `status`
  (`pending | done | budget_wait | failed`), `extraction` (JSON text, Zod-validated), `extract_model`,
  `extract_prompt_version`, `final_decision` (`keep | reject | suspicious`), `resolved_reasons` (JSON array),
  `scam_score` (0-100 int), `scam_reasons` (JSON array), `fit_score` (0-100 int, nullable), `fit_reasons` (JSON array),
  `fit_model`, `fit_prompt_version`, `tier` (`indonesia | regional | global_adjusted | global_flat`, nullable),
  `ask_idr_month` (int, nullable), `ask_usd_year` (int, nullable), `ask_text` (nullable), `ask_reason`, `updated_at`.
- `analysis` keeps its Phase 1 meaning (rules only). Nothing in Phase 2 rewrites rule results; LLM results live in `intel`.
- `salary_observations`, `applications`, `answer_bank`, `outcomes` are **not** Phase 2.

## LLM rules (owner decision 2026-10-08)
- Anthropic API via the official SDK `@anthropic-ai/sdk` (only new runtime dependency allowed for the LLM work).
- Models: `claude-haiku-5-5` for extraction and company research; `claude-sonnet-5-5` for fit scoring only. Model ids
  and prices per million tokens live in one constant table in `packages/core/src/llm/prices.ts`, values from the R1
  research doc.
- **Hard cap: $1.00 per day** (Asia/Jakarta day), constant `DAILY_LLM_CAP_USD = 1` in code. Env
  `JOB_AGENT_LLM_CAP_USD` may **lower** it, never raise it (higher values are ignored with a warning).
- Before every call the client reserves the worst case: estimated input tokens x input price + `max_tokens` x output
  price. If `spent today + reserve > cap`, the call is **not made** and `BudgetExceededError` is thrown. After the call
  the real cost (from `usage`) is written to `llm_calls`. Failed calls are recorded too (`status = error`, cost of any
  billed tokens).
- On `BudgetExceededError` the enrich run stops making calls; untouched postings get `intel.status = budget_wait` and
  are picked up on the next day's run. Never a silent skip.
- Missing `ANTHROPIC_API_KEY`: `enrich` prints `ANTHROPIC_API_KEY not set, LLM stages skipped`, makes no calls, exits 0,
  and leaves postings `pending`. Rule-only digest still works.
- Every LLM output is validated with Zod (tool use / structured output with a JSON schema). Invalid output: one retry,
  then `intel.status = failed` with the Zod issue paths in `resolved_reasons`. Never guess missing fields.
- **The LLM extracts facts; plain code decides** (PLAN 5.1). No prompt asks the model for a keep/reject, tier or ask.
  The only model-produced judgment is the fit score with its reasons.
- Order inside one run: newest canonical posting first, and **per posting** extract -> resolve -> registry -> scam ->
  (fit only if `final_decision = keep`) -> tier. So the budget fully scores the newest postings rather than half-scoring
  all of them.
- Prompt caching: put the static part (instructions, schema, and for fit the CV) first and mark it cacheable, per R1.
- Never log prompts, CV text, posting text or model output. Log counts, ids, model, tokens, cost only.
- The CV (`config/cv.md`) is sent to the Anthropic API for fit scoring (PLAN 7). It is never written to logs, fixtures,
  tests or committed files. Tests use `config/cv.example.md` (fake persona).

## Tests for LLM code
- No live API calls in tests, ever. Mock `https://api.anthropic.com/v1/messages` with msw. Fixtures are hand-built in the
  real Messages API response shape (incl. `usage`), under `packages/pipeline/test/fixtures/anthropic/` (or
  `packages/core/test/fixtures/anthropic/` for the client). Mark them `"_handbuilt": true` in a sibling README.
- Every stage has tests for: valid output, invalid output (retry then failed), budget exceeded mid-run, missing key.
- Golden sets (`fixtures/golden/*.json`) test the **code** decisions (resolve, scam score, tier/ask) from given
  extraction objects. They do not call the model.
- An optional eval script per LLM stage (`pnpm --filter @job-agent/pipeline eval:<stage>`) runs the real model on the
  golden set, only when `ANTHROPIC_API_KEY` is set and only with an explicit `--live` flag, and prints accuracy and cost.
  The owner runs it; agents do not.

## Rule semantics added in Phase 2
- **Role relevance** (new reject rule `role`, runs in `process` with the other rules): keep target roles (PLAN 1: senior
  frontend / software / full-stack engineer, incl. Web3; React, TypeScript, Next.js, frontend platform/architecture,
  senior IC, lead / staff / principal). Reject non-engineering roles and explicit junior / intern / graduate roles.
  Engineering roles outside the target (backend-only, mobile-only, data/ML, DevOps/SRE, QA) are rejected too, unless the
  title also matches a target keyword (e.g. "Full-Stack (React/Node)"). Unclear titles -> keep + flag `role_unclear`.
  Lists live in `keywords.ts`, so the owner can change them in one place.
- **Location:** a list of countries (Himalayas `Countries: ...`, "Remote, United States", "Remote - Germany") means the
  candidate must live there: `restricted`, unless the list includes Indonesia or a region covering it (APAC, Asia,
  Southeast Asia, worldwide).
- **Resolve stage** (code, from extraction): only turns `location_unclear` / `indonesia_unclear` / `role_unclear` into a
  decision; it never overturns a rule reject. Every change adds a line to `intel.resolved_reasons`.
- **Scam:** score 0-100 from rule hits plus extracted signals plus verification (PLAN 4). `SCAM_THRESHOLD = 60`
  constant. `>= threshold` -> `final_decision = suspicious`: listed in the digest's "Suspicious" section only, never
  fit-scored, never acted on. Every point added has a reason line.
- **Tier and ask** (PLAN 5.3, pure function, no I/O): inputs extraction, registry pay policy, salary config, FX.
  Floor always applies. Listed location-agnostic range -> ask = min + `position_in_listed_range` x (max - min), never
  above max, never below floor. US pay-transparency ranges -> `unknown`, never `global_flat`. Unknown policy -> text
  answer `salary.text_field_answer` plus the `regional` number for numeric fields. `intel.ask_reason` says which branch
  fired.

## Ranked digest
- Sections: **Top matches** (final_decision keep, fit scored, sorted by rank), **Waiting for scoring** (pending /
  budget_wait / failed), **Needs a look** (still-unclear flags), **Suspicious**, **Source health**, **LLM spend**
  (today's cost vs cap, calls per model).
- Rank = `fit_score`, minus 10 per remaining unclear flag, plus 5 if a listed salary max is at or above the ask; ties
  by `posted_at` desc. The formula lives in one function with its own tests.
- Each Top match shows: title, company, link (ATS preferred), fit score + up to 3 reasons, tier + ask (or ask text),
  salary if listed, scam score if > 0 with its top reason, and a one-line **why** built from the reasons.
- Same company + same title listed for several cities/countries = one digest entry with the locations joined.

## Live runs
- QA live checks use `bin/smoke` (temp DB, example configs, public feeds only, no API key, no LLM calls).
- Every phase-end audit includes a `bin/smoke` run (owner decision in `docs/phase-1-live-findings.md` item 6).
- Real LLM runs (`enrich` with a key) are done by the owner, not by agents.
