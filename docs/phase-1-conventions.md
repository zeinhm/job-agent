# Phase 1 conventions (PM decisions, binding for Phase 1 cards)

Decided by the PM so sibling tasks don't each make up their own answer. Changing anything here takes a PM comment
on the card plus a decisions.md entry. Every card copies the parts it needs. If a card and this file disagree, block with `HUMAN:`.

## Workspace, branches and worktrees (owner decision 2026-10-06)
- "The main checkout" = the repo root. It **always stays on `main`**. Nobody runs `git checkout`, `git switch`, `git reset` or `git stash` there.
  Cards show workspace `dir @ <repo root>`: start there, then go to your worktree.
- Only these commits happen in the main checkout: merges by the final reviewer (+ the audit-ledger row), research docs by the researcher,
  PM planning docs. Always `git add <explicit paths>`, never `git add -A` / `git add .`.
- Code branch: `task/<task-id>-<short-slug>`, created from latest `main`. Never commit code to `main`.
- **Dev:** from the main checkout: `git worktree add .worktrees/<task-id> -b task/<task-id>-<slug> main`, then `cd .worktrees/<task-id>`
  and `pnpm install`. All edits, tests and commits happen there.
- **Rework card:** reuse the original dev task's branch and worktree `.worktrees/<original-task-id>`. If it was removed:
  `git worktree add .worktrees/<original-task-id> task/<original-task-id>-<slug>`.
- **QA / auditor:** `git worktree add --detach .worktrees/<dev-task-id>-review task/<dev-task-id>-<slug>`, review there (break-the-code
  edits only there), and `git worktree remove --force .worktrees/<dev-task-id>-review` at the end of your run, PASS or FAIL.
- **Merge (final reviewer only),** in the main checkout: check `git branch --show-current` is `main` and `git status` shows no modified
  tracked files (otherwise block with `HUMAN:`), then `git merge --no-ff task/<dev-task-id>-<slug>`,
  `git worktree remove .worktrees/<dev-task-id>`, `git branch -d task/<dev-task-id>-<slug>`.
- `config/` and `data/` are gitignored, so they **do not exist inside a worktree**. Tests never need them. A live run from a worktree uses
  `JOB_AGENT_CONFIG_DIR=<repo root>/config JOB_AGENT_DB=$TMPDIR/<task-id>.db`. Unmerged code never writes the real `data/job-agent.db`.
- One running card per profile (owner setting). On a git lock error (`index.lock`), wait 30 s and retry; never delete the lock file.
- **Research docs:** the researcher writes `docs/research/<task-id>-<slug>.md` and commits it directly to `main` in the main checkout,
  only files under `docs/research/`. Exception: research that contains personal data (e.g. which companies are in
  `config/companies.yaml`) goes under `data/research/` and is never committed.
- The pre-commit hook must never be bypassed. Until card t_60c777a8 is merged it may be inactive; that is not permission to commit
  personal data.

## Packages (pnpm workspace)
| Package | Path | Holds |
|---|---|---|
| `@job-agent/core` | packages/core | types, config loader, logger, db (schema, migrations, client), http client, fx |
| `@job-agent/sources` | packages/sources | one folder per adapter: `src/<source>/index.ts`; `src/registry.ts` |
| `@job-agent/pipeline` | packages/pipeline | discover runner, normalize, dedupe, salary, filters, process command, digest, CLI |

- CLI: `packages/pipeline/src/cli.ts`, run as `pnpm job-agent <command>`. Arg parsing with `node:util` `parseArgs` (no dependency).
  Commands are added by the task that owns them: `discover`, `fx`, `process`, `digest`.
- Logger: `packages/core/src/log.ts`, minimal JSON-lines logger, no dependency. Never log config values (salary numbers, CV, answers) or tokens.
- `pnpm check` = typecheck + lint + test. CI runs `pnpm install --frozen-lockfile && pnpm check`.

## Core types (`packages/core/src/types.ts`)
```ts
type RawSalary = { min?: number; max?: number; currency: string; period: "year" | "month" | "hour" };

type RawPosting = {
  source: string;            // adapter name: "greenhouse" | "lever" | "ashby" | "web3career" | "remotive" | "remoteok" | "himalayas" | "weworkremotely" | "hn"
  externalId: string;        // stable id within the source
  url: string;               // public posting page
  applyUrl?: string;
  title: string;
  company: string;
  companyDomain?: string;
  descriptionHtml?: string;
  descriptionText?: string;
  locationText?: string;
  remote?: boolean;          // only when the source states it explicitly
  salaryText?: string;       // free text as shown by the source
  salary?: RawSalary;        // only when the source provides structured numbers
  postedAt?: string;         // ISO 8601, UTC
  tags?: string[];
};

interface SourceAdapter {
  name: string;                  // same as RawPosting.source
  minIntervalMinutes: number;    // poll no more often than this (from research doc; default 60)
  fetch(since: Date): Promise<RawPosting[]>;
}
```
- Items with `postedAt` before `since` are dropped. Items without a date are kept.
- ATS adapters are built from the company list: `buildAdapters(config): SourceAdapter[]` in `packages/sources/src/registry.ts`.
  Each adapter task adds exactly one entry there.

## Errors and validation
- Every external response is validated with Zod.
- Envelope invalid, HTTP failure after retries, or more than 50% of items failing validation -> throw `SourceError` (from core). Never return `[]` to hide a failure.
- A single invalid item -> skipped, logged with `log.warn` (source, externalId, Zod issue path). Not silent, not fatal.

## HTTP (`packages/core/src/http.ts`)
- Every network call goes through `httpGet` / `httpGetJson` / `httpGetText`. No direct `fetch` in adapters or pipeline.
- Per-host minimum interval between requests: default 2000 ms. A source may set it longer, never shorter than 1000 ms.
- User-Agent: `job-agent/0.1 (+https://github.com/<owner>/job-agent)` (repo URL from package.json `repository`).
- Timeout 20 s. Retries: at most 2, only on network errors, 429 and 5xx, exponential backoff, honor `Retry-After` up to 60 s. Other 4xx: no retry.
- Errors throw `HttpError` (status, url). Secrets in query strings (e.g. `token=`) are redacted in error messages and logs.

## Tests and fixtures
- Vitest. No live network in tests. HTTP is mocked with `msw` (node) serving recorded fixtures.
- Fixtures: `packages/sources/test/fixtures/<source>/`, real responses captured once with `curl` at a polite rate,
  trimmed to at most 20 postings. Replace any email address / phone number in fixtures with `jobs@example.com` / `+10000000000`.
  No tokens in fixtures or recorded URLs.
- Config in tests: only `config/*.example.*` files, never the real config.
- Fixtures and research examples never come from a company listed in `config/companies.yaml` (the list is personal data).
  Record from a well-known public board instead.
- Config dir: `loadConfig(dir = process.env.JOB_AGENT_CONFIG_DIR ?? "config")`.
- Golden sets for judgment logic: `fixtures/golden/<name>.json` at repo root.

## Database
- Drizzle ORM + `better-sqlite3`, migrations by `drizzle-kit` in `packages/core/drizzle/`.
- DB file: `data/job-agent.db` (gitignored); env `JOB_AGENT_DB` overrides; tests use `:memory:`.
- `openDb(path)` opens the DB and applies pending migrations.
- Phase 1 tables: `companies`, `postings`, `analysis`, `source_runs`, `fx_rates` (columns in the schema card).
  Other PLAN tables (applications, answer_bank, ...) come in their own phases.
- Duplicates are kept as rows: a duplicate posting points at its canonical row via `postings.canonical_posting_id`.
  Canonical preference: ATS source (greenhouse/lever/ashby) > other API source > HN.

## Pipeline semantics (rules only, no LLM in Phase 1)
- Location class: `worldwide | apac_ok | restricted | unclear`. `restricted` -> reject. `unclear` -> keep + flag `location_unclear`.
  On-site or hybrid postings with no remote option are `restricted` (owner confirmed 2026-10-06).
- Indonesia rule: `not_applicable | foreign_hiring_id | domestic | unclear`. `domestic` -> reject. `unclear` -> keep + flag `indonesia_unclear`.
- Salary: normalize to IDR per month. year / 12, month as is, hour x 160. Convert with the stored FX rate (latest on or before the analysis date).
  `salary_status`: `listed | unknown | unparsed | no_fx`. Only `listed` can be compared with the floor; the rest keep + flag.
- Floor: reject only if the normalized **max** (or the single listed number) is below `floor_idr_month`. Only min listed -> never rejected on salary. Compare in IDR only.
- Final decision per posting: `reject` if any reject rule fires, else `keep`. `analysis.reasons` lists every rule that fired; `analysis.flags` lists flags.
- Rule keyword lists live in code, all in **one module**: `packages/pipeline/src/filters/keywords.ts`, with its own test file
  `packages/pipeline/src/filters/keywords.test.ts` (owner decision 2026-10-06). `location.ts` and `indonesia.ts` import their lists from it
  and define no keyword lists of their own. The location card creates the module; the Indonesia card (which waits for it) extends it.

## Digest
- Markdown file `data/digests/YYYY-MM-DD.md` (gitignored), date in Asia/Jakarta.
- Includes kept canonical postings with `analysis.digested_at` null, then stamps them with that date. Re-running for the same date regenerates the file with all postings stamped for that date (idempotent).
- Delivery channel (Telegram / email / dashboard) is an open human decision; Phase 1 cards only write the file (owner confirmed 2026-10-06).

## QA FAIL loop (pre-created QA/auditor child cards)
- Dev finishes with `kanban_complete` (releases the QA card). Evidence comment as in AGENTS.md.
- On FAIL the reviewer: creates a card `Rework: <original title>` assigned to `dev` (body: findings, same branch), links it as a parent of its own card
  with `kanban_link`, then `kanban_block(kind="dependency")`. The review resumes when the rework card is done.
- Count FAIL cycles in the review card's comments. Third FAIL -> block with `HUMAN:`.
- Merge point: QA merges medium/low tasks; the auditor merges high-risk tasks. Downstream dev cards depend on the merge-point card.
