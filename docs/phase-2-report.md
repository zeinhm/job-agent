# Phase 2 report: Intelligence

Date: 2026-10-09. Author: PM (card t_3f287cb1). Status: ready for owner review (t_a2206a16).

**Summary.** The Phase 2 pipeline is built and tested offline. Kept postings now go through an `enrich` command
(Haiku extracts facts, code resolves unclear flags, scores scams, applies the pay-policy registry, decides tier and ask;
Sonnet scores fit against your CV) under a hard $1/day cap, and the digest is ranked with a one-line "why" per posting.
Four new ATS/board sources and search-based company discovery are in. `pnpm check` is green on `main` (924 tests).

Two things stop me from calling the phase done:
1. **The phase-end audit (t_f2397696) failed** with 2 major and 5 minor findings. No blocker, nothing unsafe for you,
   no personal data. No fix cards exist yet (see "Open findings" and "Before you approve").
2. **No live LLM run yet.** The PLAN 8 "done when" (a ranked digest where each posting shows why) is met in code and in
   the offline end-to-end test, but the model prompts have never seen real postings. That needs your key and one run.

## What shipped

### LLM stages (`packages/core/src/llm/`, `packages/pipeline/src/enrich.ts`, `packages/pipeline/src/intel/`)

| Piece | What it does |
|---|---|
| Anthropic client + spend ledger | One shared client. Before every call it reserves the worst-case cost (prompt tokens x input price + `max_tokens` x output price); if today's spend plus the reserve passes the cap, no call is made. Every call is recorded in `llm_calls`. Hard cap $1.00 per Asia/Jakarta day; `JOB_AGENT_LLM_CAP_USD` can only lower it. Individually audited |
| Extraction (Haiku 5.5) | Pay context, listed salary, HQ country, remote region, seniority, contact channels and other facts, Zod-validated; invalid output retried once, then `failed` |
| Resolve | Settles `location_unclear`, `indonesia_unclear` and `role_unclear` from the extracted facts (code decides, see M1 below) |
| Scam scoring | 19 rule/fact signals, threshold 60, reasons that sum to the score, RDAP domain age, ATS verification that cannot offset decisive signals (fee, task scam, chat contact, personal e-mail, ID request ...). Suspicious postings are never fit-scored. Individually audited |
| Pay-policy registry | Stores a company's pay policy (location-agnostic / adjusted / unknown) from posting evidence, written after the scam stage |
| Company pay-policy research | Reads up to 2 careers pages per company per 90 days with Haiku. **Built and tested, but never called** (M2) |
| Fit scoring (Sonnet 5.5) | Fit 0-100 with up to 3 reasons against `config/cv.md`; only for postings still `keep` |
| Tier and ask (PLAN 5.3) | Plain code: tier from policy and listed range, ask in IDR/month and USD/year, floor always wins, US pay-transparency ranges take the unknown path with a text answer. Individually audited |
| Ranked digest | Top matches (rank = fit - 10 per unresolved flag + 5 if the listed max reaches your ask), Waiting for scoring, Needs a look, Suspicious, Source health, LLM spend |

### Rule and source work

| Piece | Notes |
|---|---|
| Role relevance filter | Rejects junior, non-engineering and out-of-target titles before any LLM call; 116-row golden set (your rule from the t_3765117e comment) |
| Location fix | Country lists and "Remote, <country>" are restricted |
| HN fix | Only top-level comments are job posts |
| web3.career fix | Follows the HTTP 302 |
| Digest grouping | Same company + title listed in several places = one entry |
| Edited postings | A changed posting is refreshed and re-enriched |
| New sources | SmartRecruiters, Workable, Recruitee (per company), Arbeitnow (keyless board, 5 pages max) |
| Company discovery | `discover-companies`: 12 Brave Search queries (max 20 requests per run, 1 per 2 s) for ATS board URLs; each new board is verified with one request and stored in the DB; `discover` then polls verified companies next to `config/companies.yaml` |
| `bin/smoke` | Runs every keyless source except Arbeitnow (M3), `process`, `enrich` (skips without a key) and `digest` on a temp DB |
| End-to-end test | `packages/pipeline/test/e2e.phase2.test.ts`: all adapters offline -> process -> enrich (mocked API) -> ranked digest |

Decisions made during the phase are in `docs/decisions.md` (entries dated 2026-10-08 and 2026-10-09).

## How to run it

Full guide: `docs/running.md`. Short version:

```sh
pnpm install
cp config/salary.example.yaml config/salary.yaml        # your floor
cp config/companies.example.yaml config/companies.yaml  # your companies
cp config/cv.example.md config/cv.md                    # then replace the fake persona with your CV

export ANTHROPIC_API_KEY=...   # needed for enrich; without it enrich prints a skip line and exits 0
export BRAVE_API_KEY=...       # needed for discover-companies; without it it prints a skip line and exits 0

pnpm job-agent fx                    # run first: tier and ask need a stored IDR rate (see F1)
pnpm job-agent discover-companies    # optional, once a day
pnpm job-agent discover
pnpm job-agent process
pnpm job-agent enrich                # LLM stages, newest first; --limit <n> to cap a run
pnpm job-agent digest                # data/digests/<today>.md
```

- **$1/day cap.** Enforced before every call. `JOB_AGENT_LLM_CAP_USD=0.25` lowers it; values above 1 are ignored with a
  warning; raising it means changing `DAILY_LLM_CAP_USD` in code (your decision). When the cap is hit, the remaining
  postings are marked `budget_wait` and picked up the next day; the digest shows today's spend vs the cap.
- **`config/cv.md`** is sent to the Anthropic API for fit scoring and never logged or committed. If missing, `enrich`
  says so, still extracts, and skips fit.
- **Search key.** `BRAVE_API_KEY` is sent as a header, never in a URL or log. Only result URLs are read and only
  ATS + slug are stored. The 20-request cap is per run, so do not schedule it more than once a day.
- **Cron.** `scripts/crontab.example`: `fx` 06:50, `discover-companies` 07:00, `discover` + `process` + `enrich` every
  2 h, digest at 08:00 (Asia/Jakarta). Put the keys in your local copy under `data/`, never in a committed file.

## Test status

`pnpm check` on `main` at `01f1bf4`, run by the PM on 2026-10-09:

```
 Test Files  63 passed (63)
      Tests  924 passed (924)
   Duration  39.21s (tests 83%, import 15%, transform 2%)
...
---- 31 passed, 0 failed        (pre-commit hook tests)
```

Typecheck, ESLint and Prettier run first in `pnpm check` and pass. No test calls the Anthropic or Brave API; all use
recorded or hand-built fixtures. The phase-end auditor's break-the-code checks all made tests fail: removing the
"suspicious never reaches Top" guard (3 tests), raising the cap guard (2), removing the floor in the ask (2), disabling
the non-engineering role reject (5).

Live run by the auditor (`bin/smoke`, no API key): himalayas 200, remoteok 6, remotive 5, weworkremotely 15, hn 143
postings; 369 processed, 65 kept; enrich skipped cleanly; rule-only digest written with "$0.0000 of $1.00 cap".
Arbeitnow was checked by hand (613 postings, ok). SmartRecruiters, Workable and Recruitee were not run live.

## LLM cost observed

**None yet.** You have not run `enrich` with a key: the local database has no `llm_calls` table, so it has not even been
migrated to the Phase 2 schema. Agents never use the key (decision 2026-10-08). Expected cost is bounded by the
$1/day cap; how many postings that covers per day is still unknown and is the first thing to read from the digest's
LLM spend section after your first run.

## Phase-end audit (t_f2397696): FAIL, all findings open

Full report: `docs/audits/phase-2.md`. Guards held, no personal data, smoke ok.

| # | Finding | Severity | Status |
|---|---|---|---|
| M1 | `resolve.ts`: `role_unclear` is resolved to keep from seniority alone, so "Senior Content Manager" or "Head of Operations" become "matches the target", cost a Sonnet call and can reach Top matches with a false "why" | major | **Open** |
| M2 | `researchCompanyPayPolicy` is never called (not in `enrich`, not a command), so the careers-page part of the registry never runs; `running.md` says it does. Effect is conservative: unknown policy -> regional ask + text answer | major | **Open** (also raised in batch audit #3) |
| M3 | `bin/smoke` skips Arbeitnow and every ATS adapter | minor | Open |
| M4 | Dedupe and digest only know 3 of the 6 ATS sources, so an aggregator copy can win over a SmartRecruiters/Workable/Recruitee original | minor | Open |
| M5 | A digest group can show one member's fit/scam score with another member's link | minor | Open |
| M6 | Failed or timed-out calls are recorded at $0; paid extraction is dropped on retry/budget; a bad key makes one failing call per posting instead of aborting | minor | Open |
| M7 | Without a key the scam rules never run; role rules keep "Account Executive, Web3"-style titles; RemoteOK mojibake; long UTC-offset lists; low prompt-injection exposure | minor | Open |

### Earlier batch-audit findings still open

I checked these against `main`; the phase-end audit did not repeat them.

| # | From | Finding | Severity | Status |
|---|---|---|---|---|
| F1 | Batch #3 | `enrich.ts:223-228`: if no IDR rate is stored, the tier stage finishes the posting as `done` with "tier skipped"; it is never re-tiered after `fx` runs, so those postings keep "no tier / no ask" forever | **major** | **Open**, no fix card was created. Workaround: run `fx` before the first `enrich` |
| F2 | Batch #3 | Careers-page fetch may follow redirects to any host except LinkedIn; stale FX rate used without warning | minor | Open |
| F3 | Batch #4 | Search-discovered companies keep the slug as their name and can be stored twice | minor | Open |
| F4 | Batch #4 | Arbeitnow stops at 5 pages without a warning | minor | Open |
| F5 | Batch #1/#2 | `failed` postings are never retried; concurrent `enrich` runs can each pass the cap check (overshoot max one call); `max_tokens`/refusal retried at full cost; `contentHash` on volatile text could trigger daily re-enrichment (bounded by the cap) | minor | Open |

Process gaps (not code): the batch #2 report exists only on its card, not in `docs/audits/`; `docs/audit-ledger.md`
still says "Last audit tag: (none yet)" and lists every Phase 2 row although audits 1-4 covered them; `audit-5` is not
tagged because the phase-end audit failed. Board leftovers from Phase 1, t_55542219 and t_6491b379, still sit in `triage`.

## Known limitations

- **Prompts unproven on real data.** All LLM tests use hand-built fixtures. Extraction quality, fit-score calibration
  and cost per posting are unknown until your first run. No `eval:<stage> --live` script was shipped.
- **Role noise.** The smoke run kept 65 postings, mostly non-engineering titles the rules do not recognise; with a key,
  M1 would let many of them through to fit scoring and spend.
- **Pay policy is mostly `unknown`** until M2 is fixed or a posting states its policy, so most asks are the regional
  number plus a text answer.
- **Budget coverage unknown.** $1/day may not cover every kept posting on a busy day; the rest wait a day.
- **SmartRecruiters, Workable, Recruitee** only proven against fixtures.
- **web3.career** still needs your token.
- **Digest is a local file.** The delivery channel (PLAN 9) is still open.

## Before you approve

1. **Decide on a fix round before Phase 3.** I recommend one, all high risk per AGENTS.md, as the auditor proposed plus F1:
   1. Resolve `role_unclear` without a seniority-only keep (M1), extend non-engineering phrases (M7).
   2. Wire company pay-policy research into `enrich` (M2), or record a deferral in `decisions.md` and fix `running.md`.
   3. Tier stage must not finish a posting without an FX rate (F1).
   4. Arbeitnow (+ one ATS board) in `bin/smoke`, `ATS_SOURCE_NAMES` in dedupe and digest (M3, M4).
   5. Digest groups: link and intel from the same member, no Top entry with a suspicious sibling (M5).
   6. Enrich robustness: keep paid extraction, abort after repeated API errors, scam rules without a key (M6, M7).
   Then a re-audit, `audit-5` tag and ledger clean-up. Say so on t_a2206a16 and the PM will create the cards.
2. **Do one live run** after the fix round (or now, with `fx` first and `enrich --limit 20`): it proves the "done
   when" on real data and gives the first real cost per posting. Check that the "why" lines make sense.
3. **Keys and files:** `ANTHROPIC_API_KEY`, `BRAVE_API_KEY`, `config/cv.md`; optionally `WEB3_CAREER_TOKEN`.
4. **Board housekeeping:** close t_55542219 and t_6491b379; save the batch #2 report to `docs/audits/batch-2.md`.

## Recommendations for Phase 3: More sources

PLAN 8 scope: JobSpy worker (LinkedIn, Indeed), YC and JobStreet adapters, Threads, LinkedIn posts via search. Done when:
LinkedIn jobs appear within an hour of posting.

1. **Finish Phase 2 first** (fix round + one live run). More sources multiply the role noise and the LLM spend; the
   filters and the cap need to be right on real data before volume grows.
2. **Prompt tuning card** once your first live run exists: compare extraction and fit output on 20-30 real postings,
   and ship the `eval:<stage> --live` scripts promised in `running.md`.
3. **JobSpy worker** as an isolated Python process behind the same `fetch(since)` adapter shape; LinkedIn and Indeed
   access stays inside JobSpy (AGENTS.md public-repo rule). Research first: rate limits, ToS exposure, and how often it
   can poll to meet "within an hour" without login.
4. **YC and JobStreet adapters** logged out only; research the public endpoints first.
5. **Threads** needs your Meta developer app (PLAN 9); plan it last or behind its own gate.
6. **Budget check.** A one-hour LinkedIn freshness target means `enrich` runs more often; size the $1/day cap against
   the real cost per posting from your first run.

What Phase 3 needs from you: the fix-round decision, a live `enrich` run, the Meta developer app for Threads, and
whether the digest channel (Telegram, email, dashboard) should be decided before volume grows.
