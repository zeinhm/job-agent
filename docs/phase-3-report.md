# Phase 3 report: More sources

Date: 2026-10-14. Author: PM (card t_0185322f). Status: ready for owner review (t_cff37d06).

**Summary.** All seven carry-over items you set for this phase are on `main`. Two new sources are in: LinkedIn and
Indeed through a JobSpy worker, and LinkedIn hiring posts found through Brave Search results. One partial source is
in: YC directory companies added to the ATS polling list. You dropped YC jobs, JobStreet and Threads. The pipeline now
runs hourly from one cron line with a lock. `pnpm check` is green on `main` (84 files, 1554 tests). The phase-end audit
#3 (t_747e3bc8) **passed** with 5 minor findings and no blocker or major.

Before you approve, look at these two things:
1. **The YC directory part runs although you dropped YC.** Your answer on t_e9d06901 (10:17) dropped "the YC adapter
   and the YC directory" because the YC terms forbid scraping. That answer was posted on the adapter card only. The
   directory card (t_c26830be) never got it, so it was built and merged at 13:36 (`d096002`). Now every
   `discover-companies` run reads `ycombinator.com/companies` and YC's public search index. Neither QA nor the
   phase-end audit caught the conflict. **You decide:** remove it (I create a high-risk card), or keep it and I record
   your decision in `decisions.md`. Until you decide, you can avoid it by not running `discover-companies` (it is a
   separate daily cron line).
2. **The "done when" has no live proof yet.** "LinkedIn jobs appear within an hour" holds in code and tests. The proof
   is one day of hourly runs on your machine with the JobSpy worker installed. No agent ran LinkedIn or Indeed live
   (your decision on the gate, question 5). The checklist is in "Done-when status" below.

## What shipped

### Your carry-over items (in your order)

| # | Item | Card(s) | What it does |
|---|---|---|---|
| 1 | Location truth | t_56bbe118 (high, audited) | A country restriction written in the posting text ("can only hire in the US", "must be based in ...") beats the source's region label. A vague list sets `location_unclear` and never rejects. This runs as a rule and again in resolve after extraction |
| 1 | Time zones for GMT+7 | t_fb5c9fac | Your rule as proposed. Residence wording ("must live in a European time zone") rejects. Working-hours wording keeps the posting and adds a digest `Hours:` line. Americas overlap above 3 h rejects (`MAX_AMERICAS_OVERLAP_HOURS`). Extraction prompt `extract-v7` adds `hoursZone` and `overlapHours` |
| 2 | Apply links | t_2e9e402a, t_7f305c0c, t_0bfea274 | New `resolve-apply` command, run after `enrich`. Steps in order: an ATS copy already in the DB, the company's stored board, its careers page, slug guesses on the 6 ATS APIs, links in the posting text, then one Haiku call only for strong matches (fit >= 60) with 2-10 candidate links. Types: `ats`, `company_form`, `paid_aggregator`, `signup_required`, `unknown`. Nothing is ever signed up for or paid for |
| 2 | Save a found ATS to `companies.yaml` | t_b7d65734 (high, audited) | Append-only. A backup goes to `data/backups/` first. The file is validated after writing and renamed atomically; the original is kept on any failure |
| 2 | Digest apply lines | t_fbc60316 | Top matches show `- Apply: <url> (<type>)` and `- Found on: <source> — <listing>`. Paid-only jobs stay in their rank and section with a `(paid-only apply)` label |
| 3 | Re-extract outdated extractions | t_8e27df96 | `enrich` re-extracts postings whose stored extraction used an older prompt (seen in the last 14 days). They are queued after all new work and stay inside the $1/day cap. Flags `--no-reextract` and `--reextract-only` |
| 4 | `unknown_tier_ask` | t_fe52a1af (high, audited) | Optional key in `salary.yaml`, used when a company's pay policy is unknown. Without it, the regional ask is used and one warning line is printed per run |
| 5 | Larger title deny-list | t_fa40baa4 (+ rework t_f9b3db0c) | About 70 non-engineering phrases added, with 96 new golden rows. Domain words never reject a title that contains an engineer noun, a target skill or "engineering" |
| 6 | Shorter digest | t_d46f2a41 | No Why line, compact time zones, employment type, only open flags, one-line waiting entries |
| 7 | `.env` + hourly schedule | t_432132ff (high, audited) | The CLI loads `<repo>/.env` itself and never prints a key, value or count. `bin/run-hourly` runs discover -> process -> enrich -> resolve-apply -> digest under a lock (`data/locks/hourly`). A lock older than 3 h is removed |

### Sources

| Source | Status | Card | Notes |
|---|---|---|---|
| `linkedin` (JobSpy) | **Built, never run live** | t_e781cb5e (high, audited) | Python worker `workers/jobspy/` (`python-jobspy==1.3.0`), logged out, no cookies or proxies. It prints JSON and the TS adapter is the only DB writer. Two searches per run (Worldwide, Indonesia), adaptive `hours_old` (last ok run + 10 min, 1 to 24 h), 25 results each, 10 s apart, minimum 50 min between runs. A block (429/999/403/authwall/captcha) gives an `error` run, then 6 h of `skipped` runs, also under `--force`. Nothing is retried |
| `indeed` (JobSpy) | **Built, never run live** | t_f6be6d67 (high, audited) | Same worker and backoff. Searches: "global remote" (US Indeed site, because Indeed has no worldwide site) and "Indonesia remote". same adaptive `hours_old`, minimum 2 h between runs |
| `linkedin_posts` (Brave) | Built, never run live | t_74a60bf8 (high, audited) | Reads only Brave's result list. Our HTTP client refuses `linkedin.com`, `*.linkedin.com` and `lnkd.in`. It stores only the post URL plus facts built by plain code (storage option (a), your answer). Brave's title, snippet and poster are never stored. Hard cap: 30 Brave requests per UTC day across all callers |
| YC directory -> ATS list | Built, **conflicts with your drop** | t_c26830be (medium) | See item 1 above |
| YC jobs | Dropped by you | t_e9d06901 | YC terms forbid scraping; applying needs a YC login |
| JobStreet | Dropped by you | t_fd830d09 | Terms forbid scrapers and Cloudflare blocks it. Indeed Indonesia covers part of it |
| Threads | Dropped by you | t_72b37d2c | Your gate answer, question 4 |
| Freshness line | Built | t_4eaabb57 | Source health and `status` show `last ok HH:MM WIB, max gap N min in 24h`, plus `LATE` above 65 min (linkedin) or 130 min (indeed) |
| Phase 3 e2e + smoke | Built | t_1700ae4a | `e2e.phase3.test.ts`; `bin/smoke` adds `greenhouse` (gitlab board), `linkedin_posts` (skips without a key) and `resolve-apply` |

Decisions made during the phase are in `docs/decisions.md` (entries dated 2026-10-14).

## How to run it

The full guide is `docs/running.md`. New since Phase 2:

```sh
# 1. Keys go in the repo's .env (git-ignored). The CLI loads it itself; cron needs no key lines.
cp .env.example .env    # then fill in ANTHROPIC_API_KEY, BRAVE_API_KEY (and WEB3_CAREER_TOKEN if you have one)

# 2. Your unknown-policy ask (optional; without it the regional ask is used and a warning is printed):
#    config/salary.yaml ->  unknown_tier_ask: { ask_idr_month: <your number> }

# 3. JobSpy worker, once (Python >= 3.10). Without it linkedin/indeed record `skipped`, never `ok`.
python3 -m venv workers/jobspy/.venv
workers/jobspy/.venv/bin/pip install -r workers/jobspy/requirements.txt

# 4. Try it once by hand (from your IP; one LinkedIn + one Indeed search, at most 10 results each):
bin/smoke --with-jobspy

# 5. Schedule: copy, fill in the two path placeholders, merge with `crontab -l`, install.
cp scripts/crontab.example data/crontab && crontab data/crontab
```

Schedule in `scripts/crontab.example` (Mac clock set to WIB): `fx` at 06:50, `discover-companies` at 07:00,
`bin/run-hourly` at :05 every hour. Logs go to `data/logs/<command>.log`, and the hourly wrapper also writes
`data/logs/run-hourly.log`. After you pull a rule change, run `pnpm job-agent process --reprocess` once (no LLM, no
network).

Keys and tokens:
- `ANTHROPIC_API_KEY`: `enrich` and the Haiku apply-link step.
- `BRAVE_API_KEY`: `discover-companies` and `linkedin_posts`.
- `WEB3_CAREER_TOKEN`: optional.
- `JOB_AGENT_LLM_CAP_USD`: can only lower the $1/day cap.
- None of these belongs in a committed file or in the crontab.

## Test status

`pnpm check` on `main` at `1608cff`, run by the PM on 2026-10-14 (summary lines; the expected error-log lines from
tests are cut):

```
$ pnpm typecheck && pnpm lint && pnpm test && bash .githooks/test-pre-commit.sh && bash scripts/test-python.sh
$ tsc -b
$ eslint . && prettier --check .
All matched files use Prettier code style!
$ vitest run
 Test Files  84 passed (84)
      Tests  1554 passed (1554)
   Duration  38.92s (tests 83%, import 16%, transform 1%)
---- 31 passed, 0 failed
Ran 10 tests in 0.000s
OK
```

Phase 2 ended at 924 tests; Phase 3 adds 630. No test calls Anthropic, Brave, LinkedIn or Indeed: JobSpy output,
Brave results and ATS responses are recorded fixtures. The Python worker has its own 10 tests.

Live smoke run by the auditor (`bin/smoke`, no keys, temp DB):
- Sources: himalayas 200, remoteok 16, remotive 2, weworkremotely 17, hn 35, arbeitnow 1430, greenhouse 30.
  `linkedin_posts` skipped (no key).
- `process`: 1719 processed, 59 kept.
- `resolve-apply --limit 3`: 2 ATS boards found in 12 requests.
- The temp `companies.yaml` got 2 lines and a backup.

## Phase-end audit #3 (t_747e3bc8): PASS

The full report is on the card (`data/handoff/t_747e3bc8-report.md`, to be saved as `docs/audits/phase-3.md`). The
auditor broke four things on purpose and checked that the tests catch them:
- **LinkedIn host guard:** caught.
- **Brave daily cap:** caught.
- **Freshness 65-min limit:** caught.
- **Corrupt Brave counter that fails open:** not caught (finding P3-4).

On PASS, the auditor asked the automation to tag `audit-7` on `1608cff` and clear the audit ledger. When I wrote
this report neither was visible: `docs/audit-ledger.md` still says "Last audit tag: (none yet)".

### Findings from this audit (all open, no fix cards yet)

| # | Finding | Severity |
|---|---|---|
| P3-1 | `save-ats.ts:21-25`: company names or slugs such as `Null`, `True` or `2020` are written to YAML unquoted. Validation refuses the write, so `companies.yaml` stays safe, but every hourly `resolve-apply` then exits 1 and no further board is saved. This is also open from batch 6 | minor |
| P3-2 | `freshness.ts:47-60`: the gap from the last `ok` run to now is not counted. If LinkedIn has been erroring for 5 h, the line can still read `max gap 60 min`. The run status next to it does show the error | minor |
| P3-3 | `linkedin-posts/index.ts:63-73`: every post with no company name becomes the company `(unknown)`. `resolve-apply` and company research may then probe the slug `unknown`. This wastes requests and carries a small risk of a wrong board | minor |
| P3-4 | `discovery/search.ts:31-36`: no test checks that a corrupt Brave counter counts as spent | minor |
| P3-5 | `docs/audit-ledger.md` is stale: about 60 Phase 1-3 rows that earlier audits already covered, and a header that was never updated | minor (process) |

**Owner check from the audit:** `config/salary.example.yaml:10` has `unknown_tier_ask: { ask_idr_month: 16500000 }` as
a fake placeholder. Please confirm it is **not** your real number. Agents cannot read your `config/`.

### Earlier Phase 3 audit findings still open

None of these got a fix card. Batch audits #5 and #6 passed and listed them as optional.

| From | Finding | Severity |
|---|---|---|
| Batch 5 | "Candidates must be located in Europe or Asia" is rejected, because the generic phrase fires before the covering-place check | minor |
| Batch 5 | "French speaker markets" is rejected as a language requirement | minor |
| Batch 5 | "Must be authorized to work in the United States" with location Worldwide is not read as a restriction. This needs your decision: reject or flag? | minor |
| Batch 5 | `bin/agent-step` runs `git checkout` / `git stash` in the main checkout and calls the external ops `push-main` script (automation, please confirm intent) | minor |
| Batch 6 | A careers-page board is saved (and appended to `companies.yaml`) without a same-company check | minor |
| Batch 6 | When Haiku answers `company_form` or `paid_aggregator`, code does not check that answer against its host lists | minor |
| Batch 6 | An API outage during the Haiku apply step stores `unknown`, which is re-checked only after 7 days | minor |
| Batch 6 | `bin/run-hourly` has a race on taking over a stale lock (only possible once, after a crash) | minor |
| Batch 6 | `run.py` `BLOCK_PATTERN` matches a bare 429/999/403 in any JobSpy warning, so a harmless line can start a 6 h backoff (safe for your IP, but costs coverage) | minor |

Not Phase 3 code, but still open: the MAJOR finding from audit t_f75d6948 (pre-Phase 3, "German is not required"
wording rejected by the language filter). I found no fix commit for it on `main`.

## Known limitations

- **Coverage of LinkedIn posts:**
  - The 30/day Brave cap is shared. `discover-companies` runs first at 07:00 WIB (00:00 UTC, so right after the
    counter resets) and can use up to 20 requests. That leaves about 10 for posts, which is 2-3 of the 8 planned
    runs. The rest of the day posts record `skipped`.
  - Brave only returns posts it has indexed, with `freshness=pd`, so posts are not real-time.
  - Many posts carry no company name, so they show as `(unknown)` with only the role wording we derived.
  - Posts are a supplement. They do not count toward the one-hour goal.
- **Tier 2 block risk:**
  - LinkedIn and Indeed run from your home IP every hour (LinkedIn) and every 2 h (Indeed).
  - A block costs that source 6 h, and the digest shows `in backoff`. No login is used, so there is no account risk.
  - JobSpy can break when LinkedIn changes its pages. The worker is pinned, and a parse failure is an error, never a
    silent empty run.
  - The block detector is deliberately trigger-happy (batch 6 finding).
- **Indeed "global" search is US-scoped.** Indeed has no worldwide site. Most of those postings will be rejected by
  the location rules, and each one still costs nothing but a rule pass.
- **LLM budget under the hourly schedule:**
  - `enrich` now runs 24 times a day. It shares the $1/day cap with re-extraction (queued last) and the apply-link
    Haiku step (fit >= 60 only, about $0.0005 per call).
  - New postings are served first. When the cap is hit, the rest wait as `budget_wait` and the digest shows them.
  - I have no spend numbers from your runs; agents do not read `data/`. After your first hourly day, the digest's
    "LLM spend" section shows whether $1 covers the day. If many postings sit in `budget_wait` by evening, the cap or
    the source mix needs a decision.
- **Never run live by any agent:** `linkedin`, `indeed`, `bin/smoke --with-jobspy`, `linkedin_posts` (needs your
  Brave key), `enrich` / `resolve-apply` Haiku steps (need your key), the real `companies.yaml` append, and cron
  installation.
- **YC directory and terms of use:** see the top of this report.
- **Eval scripts** (`eval:<stage> --live`) are still not shipped; prompt quality is checked only against fixtures.

## Done-when status (PLAN 8: "LinkedIn jobs appear within an hour of posting")

The code and tests are in place. The auditor confirmed each item:

| Item | Where |
|---|---|
| Adaptive `hours_old` (`lookbackHours`) | `packages/sources/src/jobspy/index.ts` |
| Hourly at :05 with a lock | `scripts/crontab.example`, `bin/run-hourly` |
| 50-minute minimum interval | `jobspy/index.ts:176`, enforced in `discover.ts` |
| `LATE` when the max gap exceeds 65 min | `digest/freshness.ts:7` |

**Not yet shown live.** After one full day of hourly runs, please check:
1. **Source health in the digest:** the `linkedin` line reads `last ok HH:MM WIB, max gap <= 65 min in 24h`, with no
   `LATE` and no `in backoff`. Also check that the last `ok` is within the last hour; the line does not flag this
   yet (P3-2).
2. **`data/logs/run-hourly.log`:** every `previous run still active, skipped` line is a missed hour.
3. **Timing:** for a few `linkedin` postings, compare when the tool first saw them with the posting age LinkedIn
   shows.
4. **Worker installed:** if `workers/jobspy/.venv` is missing, every run is `skipped`, which never counts as `ok`.

If all four hold, the phase goal is met. If LinkedIn blocks your IP during that day, the goal is not met at the
current rate. The next step would then be a lower LinkedIn rate (a decision for you), not retries.

## Before you approve

1. **YC directory:** remove it, or keep it as a recorded decision (item 1 at the top).
2. **One day of hourly runs** with the JobSpy worker installed. Then read the four checks above and the LLM spend
   section.
3. **Confirm** that `16500000` in `salary.example.yaml` is not your real number, and add your own `unknown_tier_ask`
   to `config/salary.yaml` if you have not yet.
4. **Optional fix round (low cost):** P3-1 to P3-4 plus the batch 6 findings. If you say so, I plan them as one
   high-risk fix batch (fix tasks are always high risk per AGENTS.md).
5. **Decide on work-authorization wording** ("must be authorized to work in the US" with location Worldwide):
   reject, or flag `location_unclear`?
6. **Brave cap use:** run `discover-companies` weekly instead of daily, or move it to after the evening, so posts get
   most of the 30 requests. This is a one-line crontab change on your side.

## Recommendations for Phase 4: Review workflow

PLAN 8 Phase 4 is the review workflow: you go through the digest and mark postings, and the tool learns from that.
1. **Prove Phase 3 live first.** One week of hourly runs gives the real volume per source, the real LLM spend and the
   real block rate. Phase 4 should be sized on those numbers, not on fixtures.
2. **Pick the delivery channel early** (PLAN 9 is still open: Telegram, e-mail or a local dashboard). A review
   workflow needs a place to click "interested / not interested / applied", and that choice shapes the whole phase.
3. **Store review decisions as data:** a `reviews` table keyed by the canonical posting, with reasons from a fixed
   list. That data can later tune the deny-list, the time-zone constant and the fit threshold (PLAN 5.5, learning
   from data), with code deciding and the LLM only extracting.
4. **Feed your decisions back to the apply-link and pay-policy registries.** A "wrong apply link" or "this company pays
   location-agnostic" mark should correct the stored row rather than wait for a re-check.
5. **Ship the eval scripts** (`eval:extract`, `eval:fit`) with a 20-30 posting golden set taken from your reviews
   (fake persona in the repo, your real set only under `data/`).
6. **Keep "no submit" intact.** Phase 4 marks and drafts. Any applying stays in Phase 6 behind its own approval.
