# Batch audit #6 (t_50c18684)

Range: `audit-5..origin/main` (81f6332), 65 files, +5674/-316.
Tasks: t_e781cb5e, t_b7d65734, t_7f305c0c, t_8e27df96, t_0bfea274, t_432132ff, t_f6be6d67, t_c26830be, t_d46f2a41.

## Setup
- `pnpm install --frozen-lockfile`: ok. `pnpm lint`: "ESLint: No issues found". There is no `typecheck` script at the root or in the packages (`ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`). Lint and the vitest transform were the only static checks I could run.
- `pnpm test`: 81 files, 1512 tests, all passed.

## Checked
- Personal data and secrets: grep of the added lines for the owner's name and email, key patterns, phone numbers, IPs and absolute home paths. Only fake keys in tests (`sk-ant-test-key-0000`, `sk-ant-fake`). `bin/smoke` sets `JOB_AGENT_ENV_FILE=/dev/null` and unsets the key, so the new `.env` loading cannot leak the owner key into a smoke run.
- Guardrails: LinkedIn and Indeed access stays inside the JobSpy worker. It is logged out and has no cookies or proxies. The `linkedin.com` and `lnkd.in` hosts are excluded from the apply-link candidates. A block gives a 6 h backoff that also holds under `--force`. Smoke with jobspy needs `--with-jobspy`. Careers pages go through the shared fetcher (https only, restricted redirects, 1 request per 2 s per host). Nothing submits or logs in.
- Break-the-code: disabling the block backoff in `discover.ts` makes 2 of 6 tests in `discover.backoff.test.ts` fail ("next runs within 6 h are skipped... even with --force"). The change was reverted and the tree is clean.
- Deep read: `jobspy/index.ts`, `run.py`, `apply-links/index.ts`, `llm-step.ts`, `careers.ts`, `save-ats.ts`, `env.ts`, `bin/run-hourly`, the `discover.ts` and `enrich.ts` diffs.
- Consistency: LinkedIn and Indeed share one adapter factory, so error, partial and blocked handling is identical. The Tier 2 backoff applies to any `SourceBlockedError`. Both min intervals (50 and 120 min) are enforced in code, independent of the hourly cron.

## Findings

### [MINOR] packages/pipeline/src/apply-links/save-ats.ts:25 — plain-scalar rule writes YAML keywords/numbers unquoted
`scalar()` leaves `[A-Za-z0-9][A-Za-z0-9 .&'_-]*` unquoted. A company named `null` or `123` (or a slug of only digits) is therefore written as a YAML null or number. Reproduced with `parseCompaniesYaml`:
```
RES No OK "No"
RES null ERR Config file companies.yaml is invalid: companies.0.name: invalid_type
RES 123 ERR Config file companies.yaml is invalid: companies.0.name: invalid_type
```
The post-write validation catches it, so `companies.yaml` is not corrupted (the original is kept). But every `resolve-apply` run then exits 1, and no further ATS can be added, until that company disappears. Rare. Fix: quote when the value is all digits or a YAML 1.1 keyword (null, true, false, yes, no, on, off, ~), or quote names always.

### [MINOR] packages/pipeline/src/apply-links/index.ts:302-323 — `firstBoard` from a careers page is saved without a same-company check
When a trusted domain's careers page links to a pollable board with no matching title, the first board is saved as the company's board (`saveBoard`, verified = true). `saveFoundAts` then appends it to `config/companies.yaml`. This relies on "the careers page of the company's own domain links to the company's own board". A page that embeds a partner or agency board would be added as a polled company. `domainResemblesCompany` is a loose test (contains, 3 or more characters). Consider `isSameCompany` for boards that state a name, or save only when the title matched.

### [MINOR] packages/pipeline/src/apply-links/index.ts:508-515 — code verifies only `ats`; `company_form` and `paid_aggregator` come from the model alone
The comment says "Code decides the type", but a model answer of `paid_aggregator` or `company_form` is stored without checking the host against `PAID_ONLY_HOSTS` or the company domain. Impact is a wrong label on one link in the digest. The rule-based steps already have these host lists, so the check is cheap to add.

### [MINOR] bin/run-hourly:17-22 — stale-lock takeover race
Two runs that both find a lock older than 3 h can both remove it and both create it (`rmdir`, then `mkdir`). The result is two overlapping runs, one time only, after a crash. Low likelihood with one cron entry. Fine to leave, or document.

### [MINOR] packages/pipeline/src/apply-links/index.ts:489-494 — an API failure while calling the model stores `unknown`/`source`
A network or API outage during the Haiku step stores the free result, and the posting is re-checked only after 7 days, so a strong match can sit without a route for a week. The decision log records this as a choice (2). A shorter re-check, or no row for `LlmApiError`, would be better. Budget and no-key cases already defer correctly.

### [MINOR] workers/jobspy/run.py:30 — `BLOCK_PATTERN` matches bare 429/999/403 in any WARNING log line
Any JobSpy warning that contains one of those numbers (a job id, a count) makes the whole search `blocked`, which starts a 6 h backoff. That errs on the safe side for the owner's IP, but it can cut LinkedIn coverage. Acceptable; consider anchoring on "status code".

No BLOCKER or MAJOR findings.

## Deep dive
- t_e781cb5e / t_f6be6d67 (JobSpy workers, scraping guardrails) because they are the most owner-risky: adapter error paths, partial results kept on block, the age filter, and the backoff break check above.
- t_b7d65734 / t_0bfea274 because they write to the owner's `config/` and call a paid API. save-ats is append-only with a backup and a validated atomic rename. The LLM step stops on budget or missing key, stores nothing in those cases, and logs no URLs or text.

## Fix tasks
None required (no BLOCKER or MAJOR). Optional low-priority batch for the PM, in this order:
1. **Quote YAML keywords and numeric names/slugs in save-ats `scalar()`** (finding 1), with a test using `null` and `123`.
2. **Same-company check for a careers-page board before saving it** (finding 2).
3. **Verify the model's `company_form` / `paid_aggregator` answers against host lists, and re-check API failures sooner than 7 days** (findings 3 and 5).

## Verdict
PASS. No audit-6 tag was created (the automation tags the audited commit 81f6332).
