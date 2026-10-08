# Phase 1 report: Discovery MVP

Date: 2026-10-08. Author: PM (card t_06b2a1dc). Status: ready for owner review.

**Summary.** The Phase 1 pipeline is built, tested offline and audited. It polls nine public job sources, normalizes and
dedupes postings, applies the three rule filters (location, Indonesia rule, salary floor) and writes a daily markdown
digest under `data/digests/`. The phase-end audit passed after one fix round. `pnpm check` is green on `main`
(466 tests). One thing is still unproven: no full live run has been recorded yet, so the PLAN 8 "done when" (a daily list
of _real_ remote-eligible postings) is met in code and fixtures but not yet on real data. See "Before you approve".

## What shipped

### Sources (`packages/sources/src/`)

Every adapter implements `fetch(since) -> RawPosting[]`, goes through the shared rate-limited HTTP client (one request
per 2 s per host by default, never faster than 1 s), validates responses with Zod, and is tested against recorded
fixtures with msw.

| Source | How | Min poll interval | Notes |
|---|---|---|---|
| Greenhouse | Public board API, one call per company in `config/companies.yaml` | 60 min | Unknown slugs (404) reported in Source health; one failing board no longer hides the others |
| Lever | Public postings API, per company | 60 min | Same board handling as Greenhouse; parses salary ranges |
| Ashby | Public job-board API, per company | 60 min | Same board handling; reads compensation when listed |
| web3.career | Official API, needs `WEB3_CAREER_TOKEN` | 5 min | Built on a docs-shape fixture; never called live yet (no token) |
| Remotive | Public API | 360 min | |
| RemoteOK | Public JSON feed | 240 min | |
| Himalayas | Public API | 60 min | |
| We Work Remotely | RSS | 60 min | |
| HN "Who is hiring" | Algolia HN API, monthly thread | 360 min | Free text; many items end up `unclear` |

Out of Phase 1 by your decision of 2026-10-06: SmartRecruiters, Workable, Recruitee, Arbeitnow (Phase 2); Reddit,
Threads (Phase 3).

### Modules

| Module | Where | What it does |
|---|---|---|
| Core types, config loader, errors | `packages/core/src/` | Shared types, `SourceError` / `PartialSourceError`, Zod-validated config (`JOB_AGENT_CONFIG_DIR` override) |
| HTTP client | `packages/core/src/http.ts` | Per-host rate limit, retries, User-Agent with the repo URL |
| Database | `packages/core/src/db/` | Drizzle + SQLite, migrations run on open (`JOB_AGENT_DB` override) |
| FX | `packages/core/src/fx/` | Daily USD rates for IDR, EUR, GBP, SGD, AUD, CAD, CHF |
| Discovery runner | `packages/pipeline/src/discover.ts` | Runs due sources, enforces poll intervals, logs every run to `source_runs` |
| Normalization | `packages/pipeline/src/normalize/` | One shape for all sources |
| Dedupe | `packages/pipeline/src/dedupe/` | Same job on several sources becomes one record; ATS link preferred |
| Salary | `packages/pipeline/src/salary/` | Parses ranges, converts to IDR per month (yearly / 12, hourly x 160) |
| Filters | `packages/pipeline/src/filters/` | Location eligibility, Indonesia rule (both with golden sets), salary floor; keywords in one module |
| Process command | `packages/pipeline/src/process.ts` | Normalize, dedupe, filter, write keep / reject with flags; re-analyses postings that had no FX rate |
| Digest | `packages/pipeline/src/digest/` | `data/digests/YYYY-MM-DD.md`: Matches, Needs a look, Source health |
| End-to-end test | `packages/pipeline/test/e2e.test.ts` | All nine adapters offline: discover -> process -> digest, plus a one-source-down case |
| Pre-commit hook | `.githooks/pre-commit` | Blocks private config, data, `.env`, DB files and your personal strings, also from worktrees |
| Cron + run docs | `scripts/crontab.example`, `docs/running.md` | How to run it daily on your Mac |

## How to run it

Full guide: `docs/running.md`. Short version:

```sh
pnpm install
cp config/salary.example.yaml config/salary.yaml        # then put your floor in it
cp config/companies.example.yaml config/companies.yaml  # then your companies (see data/research/ from card t_3713edc3)

pnpm job-agent fx                         # today's FX rates
pnpm job-agent discover                   # all due sources (--source <name>, --force for manual use)
pnpm job-agent process                    # normalize, dedupe, filter
pnpm job-agent digest                     # writes data/digests/<today>.md and prints the path
```

For a daily schedule, copy `scripts/crontab.example`, fill in the two path placeholders, and install it with
`crontab` (steps in `docs/running.md`). It runs `fx` at 07:00, `discover` + `process` every 2 hours, and the digest at
08:00 (Asia/Jakarta).

## Test status

`pnpm check` on `main` at `ced5390`, run by the PM on 2026-10-08:

```
 Test Files  34 passed (34)
      Tests  466 passed (466)
   Duration  39.07s
...
---- 31 passed, 0 failed        (pre-commit hook tests)
```

Typecheck, ESLint and Prettier pass (they run before the tests in `pnpm check`). The auditor also ran mutation checks:
breaking salary normalization, digest stamping, the "all boards 404" error and the partial-failure branch each made
tests fail, so those tests do catch real bugs.

## Phase-end audit (t_be4c38f1)

First run: **FAIL** with two major findings. A fix task (t_0c765557) fixed them. Re-audit: **PASS**, no blocker or
major findings, no owner-safety problem.

| # | Finding | Severity | Status |
|---|---|---|---|
| M1 | Greenhouse/Lever/Ashby: a 404 company slug was swallowed and the source showed `ok` | major | **Fixed**: unknown slugs listed in Source health; all boards 404 = error |
| M2 | Same adapters: one failing board discarded every other company's postings | major | **Fixed**: every board tried, successes kept, run recorded as `error` |
| m1 | Postings analysed before FX rates existed were never re-analysed | minor | **Fixed** (`process.ts`) |
| m2 / n3 | An already-stored posting is never refreshed if the employer edits it later | minor | **Open**, suggested for Phase 2 |
| m3 | Your local home-directory path in `docs/phase-1-remaining.md`; stray `.map` build files | minor | **Fixed** |
| m4 | No `repository` in `package.json`, so the User-Agent had a placeholder URL | minor | **Fixed** |
| m5 | Digest Source health could show a harmless `skipped` run as the latest | minor | **Fixed** |
| m6 | Digest counted salary rejections via a copied string | minor | **Fixed** (shared constant) |
| n1 | When a board fails, the 404 warnings are only kept in the error text | minor | Open, accepted by the auditor |
| n2 | A programming bug (non-`SourceError`) in one board drops the other boards' results | minor | Open, accepted (only affects real bugs) |

Process gaps, not code defects:
- The audit report exists only as comments on card t_be4c38f1; `docs/audits/` is empty.
- The `audit-1` tag was not created (`git tag` is empty), so the first Phase 2 batch audit has no base point.
- The audit did not run the full live pipeline that the backlog planned (`bin/smoke` not run); adapters were checked
  against recorded fixtures only.
- Board housekeeping: t_55542219 (digest) shows `triage` although it is merged (`ced5390`), and t_6491b379 (Prettier on
  `.claude/settings.json`) is stale: `a784eeb` fixed it and `pnpm check` passes.

## Known limitations

- **No real-data run yet.** All nine adapters work against recorded responses. A live source may have changed shape
  since recording.
- **web3.career has never seen the real API.** Its fixture follows the docs. Until you add the token and record a
  fixture, expect it to show `error` (missing token) in Source health.
- **Thin signals without an LLM.** Most postings list no salary and no HQ, so many are kept with flags such as
  `salary_unknown`, `indonesia_unclear` or `location_unclear` and land under "Needs a look". Expected until Phase 2.
- **Keyword rules have limits.** Location and Indonesia rules are keyword based and tested on golden sets that the
  researcher labelled; some labels were disputed and relabelled, and the judgment rows are worth a look from you.
- **HN is noisy.** Free-text comments parse into many `unclear` items.
- **No ranking.** The digest is sorted by posting date, not by fit (Phase 2).
- **Digest is a local file only.** Delivery channel (Telegram, email or dashboard) is still your open decision (PLAN 9).
- **Postings are a first snapshot.** Later edits by the employer are not picked up (m2 / n3).
- **Company list is manual.** Only companies in `config/companies.yaml` are polled on the ATS sources.

## Before you approve

1. **Do one live run** on your machine to prove the "done when": the four commands above with your real config, then
   open the digest. Or ask for a smoke run with `bin/smoke` (temp DB, example config, public feeds only).
2. **web3.career:** add `WEB3_CAREER_TOKEN` to your environment and run
   `pnpm --filter @job-agent/sources record:web3career` to replace the docs-shape fixture (or accept it showing `error`).
3. **Companies:** if not done yet, review `data/research/t_3713edc3-companies.yaml` and copy the entries you want into
   `config/companies.yaml`.
4. **Housekeeping (auditor/automation):** create the `audit-1` tag on `ced5390`, close t_6491b379 as obsolete, and
   move t_55542219 out of `triage`.

## Recommendations for Phase 2: Intelligence

PLAN 8 scope: pay context, tiers, scam scoring, fit scoring, pay-policy registry, company discovery. Done when: a ranked
digest where each posting shows why it scored what it did.

Suggested order:
1. **LLM extraction (PLAN 5.1)** for postings that pass the rules: pay context, HQ country, employer-of-record hints,
   remote region. This turns most `unclear` flags into real decisions. The LLM extracts facts; code decides.
2. **Scam signals (PLAN 4)** from the extracted facts plus rule checks.
3. **Fit scoring** against `config/cv.md`, with the reasons shown in the digest.
4. **Tiers and ask (PLAN 5)** and the **pay-policy registry (5.4)**.
5. **Ranked digest** with a "why" line per posting.
6. **Company discovery** via search-engine queries on ATS domains, feeding the polling list automatically, plus the
   ATS sources moved here from Phase 1: SmartRecruiters, Workable, Recruitee, and the Arbeitnow board.
7. **Small carry-overs:** refresh stored postings when they change (n3), and a live smoke run in every phase-end audit.

What Phase 2 needs from you (PLAN 9):
- **Anthropic API key** (extraction and scoring).
- **CV** as structured markdown in `config/cv.md`.
- **Search API key** (Brave or similar) for company discovery.
- **Digest channel decision** (Telegram, email or dashboard only). Not blocking, but ranking is more useful once it
  reaches you.
- **Budget:** a monthly LLM spend cap, so the plan can size how many postings get extracted per day.
