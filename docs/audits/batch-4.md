# Batch audit #4 (audit-3..origin/main f59d6ea)

Tasks: t_e239af67 (Recruitee), t_3f99932a (Arbeitnow), t_9dcff684 (poll DB companies), t_f6f3b14c (company discovery), t_a8d69efd (Phase 2 e2e).

## Setup
Fresh detached checkout of origin/main, `pnpm install --frozen-lockfile`, `pnpm lint` (eslint + prettier) clean, `pnpm test`: 62 files, 920 tests passed. There is no `typecheck` script at the root, so `pnpm -r typecheck` is not applicable (vitest/eslint only; not a finding).

## Not done
Break-the-code mutations (removing the `DAILY_QUERY_BUDGET` slice, making `verifyBoard` treat every error as 404) were blocked by the sandbox approval policy in this unattended run. I did not execute them. Findings on test strength below come from reading the tests only.

## Breadth checks
- Personal data / secrets: the fixtures (`brave-search.json`, `bunq-offers.json`, `arbeitnow/page1.json`) use fake or public-company data. The Brave key is read from the `BRAVE_API_KEY` env var and sent as a header, never in a URL or log (`core/http.ts` `headers` option). No personal data found.
- Guardrails: no LinkedIn, login, CAPTCHA or submission code. Discovery uses a search API with a 2 s interval and a 20-query cap. Verification and polling hit the public ATS APIs at 2 s intervals.
- SSRF / injection: hosts are fixed per ATS. Recruitee builds the hostname from the slug, validated by `SLUG_PATTERN` in the adapter and by the extraction regex. Ashby slugs are URL-encoded. Look-alike hosts are rejected (tested).
- Brave ToS mitigation (only URLs read, only ats + slug stored) is implemented as the decision entry says.
- Consistency: Recruitee follows the same `fetchAllBoards`/warnings pattern as Workable and SmartRecruiters. The 404 board handling (skip with warning) matches the other adapters. Arbeitnow follows the single-feed adapter pattern, with the same "more than 50% invalid -> SourceError" rule.
- Decisions: the decision entry for discovery exists and matches the code.

## Findings

### MINOR docs/running.md: new command and source not documented
`discover-companies` (cli.ts) and `BRAVE_API_KEY` appear only in `docs/phase-2-conventions.md` and the decision log. The `running.md` command table does not list the command. The `discover --source` list already omits `smartrecruiters`, `workable`, `recruitee` and now `arbeitnow` is the only one added. Repro: `grep -rn discover-companies docs/running.md` returns nothing.

### MINOR discovered companies are named after their slug
`discover-companies.ts` stores `name = cleanLine(slug)`. `normalize/index.ts:28-40` reuses an existing `companies` row by `normalized_name` and never updates the name, and `normalized_name` is unique (`schema.ts:7`). Effects:
1. The digest and pay-policy registry see the slug (e.g. "acme-inc") as the company name for postings from that board. Both the adapter (`company: company.name`) and the stored row use the slug.
2. When a posting later arrives under the real name ("Acme Inc") whose normalization differs from the slug's, a second company row is created, so the same employer can exist twice.
The decision entry says "name = slug until the first posting names it", but nothing renames it. Fix: on normalize, update `name` when the existing row has `discovered_via = 'search'` and its name equals its slug; or use the posting's `company_name` when discovered.

### MINOR arbeitnow: silent truncation at 5 pages
`arbeitnow/index.ts` stops at `MAX_PAGES = 5` (500 jobs). If more than 500 jobs were posted since `since` (long gap after downtime or a first run), the rest is dropped with no warning, and it is still recorded as success. Fix: log a warning or return it through `takeWarnings` when the loop ends without reaching an older item or the last page.

### MINOR discovery: query budget is per run only
Already noted in the decision log. Repeated same-day runs multiply the usage (up to 12 per run). The risk is a paid-API bill limit only; no action needed unless it is scheduled more than daily.

## Depth
I read all of discovery (`extract.ts`, `search.ts`, `verify.ts`, `discover-companies.ts`) and `companies.ts`/registry changes as the riskiest (new external API, writes to the DB from untrusted URLs). Behaviour is sound: a 404 stores `verified=false` (never polled), other errors are not stored and are retried, `pollingCompanies` requires `verified === true`, and config wins on duplicates. Exit code 1 only when every query fails.

## Fix tasks
- (low) Document `discover-companies`, `BRAVE_API_KEY` and the full `--source` list in docs/running.md.
- (low) Replace the slug name of a search-discovered company with the real name from the first posting; add a test with a later "Acme Inc" posting.
- (low) Arbeitnow: warn when the 5-page cap is hit before reaching older items.

## Verdict
PASS (no BLOCKER or MAJOR). Audit tag `audit-4` should go on f59d6ea.
