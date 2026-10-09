# Running the pipeline (Phase 1 + Phase 2)

How to run the pipeline on your Mac: find remote postings, filter them with rules (Phase 1), then score them with
the LLM stages and write a ranked daily digest (Phase 2). It only reads public job feeds, calls the Anthropic API
for the LLM stages, and writes local files. It never applies anywhere.

## Prerequisites

- Node.js LTS (the repo declares `node >= 24` in `package.json` `engines`)
- pnpm (the version pinned in `package.json` `packageManager`; `corepack enable` picks it up)
- git

## Install

```sh
git clone <repo url> job-agent
cd job-agent
pnpm install
```

`pnpm install` also activates the pre-commit hook (`git config --get core.hooksPath` prints `.githooks`).

## Config files

`config/` is private and gitignored. The pipeline reads three files from it. Start from the example files and put your own
values in the copies; never commit them:

```sh
cp config/salary.example.yaml config/salary.yaml
cp config/companies.example.yaml config/companies.yaml
cp config/cv.example.md config/cv.md
```

| File | Used by | What it holds |
|---|---|---|
| `config/salary.yaml` | `process` | `floor_idr_month`: postings whose listed max is below it are rejected (plus later-phase fields) |
| `config/companies.yaml` | `discover` | companies whose ATS boards are polled (`name`, `ats`, `slug`) |
| `config/cv.md` | `enrich` | your CV in Markdown, used by the fit-scoring stage |

`config/cv.example.md` is a fake persona; replace the copy's content with your own CV. `cv.md` is **sent to the
Anthropic API** for fit scoring (that is what the stage is for). It is never logged or committed. If it is missing,
`enrich` prints `cv.md not found in the config dir, fit scoring skipped (extraction still runs)` and carries on
without fit scores.

`config/README.md` lists every example file. The other examples (`answers`, `private-patterns`) are not read by the
pipeline commands; `private-patterns.txt` is used by the pre-commit hook.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `JOB_AGENT_DB` | `data/job-agent.db` | SQLite database file |
| `JOB_AGENT_CONFIG_DIR` | `config` | Folder holding `salary.yaml` and `companies.yaml` |
| `WEB3_CAREER_TOKEN` | (none) | API token for the web3.career source. Without it, that source shows `error` in Source health; the other sources still run |
| `ANTHROPIC_API_KEY` | (none) | Anthropic API key for the LLM stages of `enrich`. Without it `enrich` prints `ANTHROPIC_API_KEY not set, LLM stages skipped`, makes no calls and exits 0; postings stay `pending` and the digest lists them under Waiting for scoring |
| `BRAVE_API_KEY` | (none) | Brave Search API key for `discover-companies`. Without it the command prints `BRAVE_API_KEY not set, company discovery skipped` and exits 0 |
| `JOB_AGENT_LLM_CAP_USD` | `1` | Daily LLM spend cap in USD. It can only **lower** the cap (see "LLM cost cap") |

Never put a key or token in a committed file. Set them in your shell profile or in your local crontab's environment
lines. `.env.example` lists the names with empty values.

## Commands

Run from the repo root as `pnpm job-agent <command>` (add `-s` to hide pnpm's own banner).

| Command | What it does |
|---|---|
| `fx` | Fetches today's USD exchange rates (IDR, EUR, GBP, SGD, AUD, CAD, CHF) and stores them. Salaries are converted with the latest stored rate on or before the analysis date, so run it daily. Without a stored IDR rate, `enrich` parks kept postings as `fx_wait` (digest: "Waiting for scoring"); after `fx` the next `enrich` tiers them without any LLM call. |
| `discover [--source <name>] [--force]` | Polls every source that is due and stores new postings. Each source has a minimum poll interval enforced in code; a source polled too recently is recorded as `skipped` and gets no request. `--source` runs one source (`greenhouse`, `lever`, `ashby`, `himalayas`, `remoteok`, `remotive`, `web3career`, `weworkremotely`, `hn`, `arbeitnow`); `--force` ignores the interval (manual use only). Exits 1 if any source errored. |
| `discover-companies` | Finds new companies to poll: runs a fixed list of 12 web searches (Brave Search API, at most 20 requests per run, one every 2 seconds) for Greenhouse, Lever, Ashby, SmartRecruiters, Workable and Recruitee board URLs, checks each new board with one request and stores it in the database (`verified` only if the board answered). Companies already known are skipped. Needs `BRAVE_API_KEY`. Prints `discover-companies: <q> queries (<n> failed), <c> candidates, <v> new verified, <n> not found, <k> known, <e> verify errors`. Exits 1 only if every search query failed. Run it once a day; the next `discover` polls the verified companies. |
| `process` | Normalizes and dedupes new postings, then applies the rule filters (location, Indonesia rule, role, salary floor, language) and records keep / reject with flags. Prints the counts. |
| `enrich [--limit <n>]` | Runs the LLM stages on kept postings, newest first, one posting at a time: extract facts (Haiku) -> resolve unclear flags -> scam score -> pay-policy registry -> fit score against `config/cv.md` (Sonnet, only for postings that were kept) -> tier and salary ask. Postings already done are not redone. `--limit` caps how many postings this run handles. Prints `enriched <n>, budget_wait <n>, failed <n>, spent $<x> today`. Exits 0 except for an invalid `--limit`. Details below. |
| `status` | Prints the row count of every table and the latest run (status, found, new, error) per source. Read-only. |
| `digest [--date YYYY-MM-DD] [--out-dir <dir>]` | Writes `data/digests/<date>.md` (or into `--out-dir`) with the kept postings not yet sent in an earlier digest, plus Source health and LLM spend, and prints the file path. Sections: Top matches (fit-scored at 60 or more, ranked, each with a one-line why; see "Reading the ranked digest"), Scored, not a fit (fit-scored below 60, one line each), Waiting for scoring (no intel yet, budget wait, failed or no fit score), Needs a look, Suspicious, Source health, LLM spend (today's cost vs the cap, calls per model). Without an `ANTHROPIC_API_KEY` every kept posting sits under Waiting for scoring. Default date: today in Asia/Jakarta. Re-running for the same date rewrites the same file and adds postings kept since. |

A first manual run:

```sh
pnpm job-agent fx
pnpm job-agent discover --source remotive
pnpm job-agent process
pnpm job-agent enrich      # needs ANTHROPIC_API_KEY, otherwise it only prints a skip line
pnpm job-agent digest
```

Optional, once a day, to grow the company list (needs `BRAVE_API_KEY`): `pnpm job-agent discover-companies`, before
`discover`.

## LLM stages and cost cap

`enrich` is the only command that calls the Anthropic API. It uses `claude-haiku-5-5` for extraction and company
research and `claude-sonnet-5-5` for fit scoring only. The model only extracts facts and gives the fit score with its
reasons; keep / reject, scam score, tier and ask are decided by plain code.

- **Hard cap: $1.00 per day** (Asia/Jakarta day). Before every call the client reserves the worst-case cost; if
  today's spend plus that reserve would pass the cap, the call is not made. The real cost of every call is recorded in
  the `llm_calls` table. A call that failed with an API error response (400, 401, 429, 529, ...) is billed nothing and
  is recorded at $0; a timeout (request sent, tokens unknown) is recorded at the reserved worst case so the cap holds.
- **Failed calls are logged**: each failed attempt writes an `llm call failed` log line with `status`, `error_type` and
  `error_message` (key redacted, 300 characters at most). When `enrich` stops after 3 API errors in a row, the stderr
  line ends with the last error, e.g. `enrich aborted after 3 consecutive API errors: status 400 invalid_request_error: Your credit balance is too low ...`.
- **Lower the cap** with `JOB_AGENT_LLM_CAP_USD`, e.g. `JOB_AGENT_LLM_CAP_USD=0.25 pnpm job-agent enrich`, or
  `JOB_AGENT_LLM_CAP_USD=0.25` in your crontab environment lines. The variable can only lower the cap: a value above 1
  is ignored with a warning and the cap stays at $1.00; a value that is not a number is ignored too. `0` makes no
  calls. Raising the cap means changing `DAILY_LLM_CAP_USD` in the code, which is the owner's decision.
- **When the cap is reached**, `enrich` stops calling the API. The postings it did not reach are marked `budget_wait`
  (shown under Waiting for scoring in the digest) and are picked up by the next day's run. Nothing is skipped silently.
- Because postings are handled newest first and each is scored completely before the next, a small cap fully scores the
  newest postings rather than half-scoring all of them.
- To spend less per run, use `enrich --limit <n>` or lower the cap. The digest's LLM spend section shows today's cost
  against the cap and the calls per model.
- **Company pay-policy research** runs inside `enrich`, after the scam check and before the registry, fit and tier
  stages, and only for postings that are kept (suspicious and rejected postings never trigger it). It looks at the
  company's own `/careers` and `/jobs` pages (at most 2 pages, never LinkedIn) for wording about location-based pay, at
  most once per company per run, and only when the company's policy is unknown and was not checked in the last 90
  days. A company with a policy set by a posting, a careers page or by you is never researched. The result is stored in
  the company registry (`careers:<url>`), so the tier of the posting being enriched uses it in the same run. A page
  fetch redirect is followed only within the company's own domain or to a known ATS host; any other host is refused.
  If the budget is reached during research the posting waits (`budget_wait`); any other research failure (page not
  reachable, API error, unusable answer) does not fail the posting: the policy stays unknown, the tier uses the
  unknown-policy ask, and `enrich` prints one warning line per company. Research costs one Haiku call per fetched page
  and is logged in `llm_calls` with purpose `company_research`.
- Invalid model output is retried once, then the posting is marked `failed` and shown under Waiting for scoring.
- Logs hold counts, ids, model, tokens and cost only. Prompts, your CV, posting text and model output are never logged.

## Eval scripts

Every LLM stage is meant to have an optional eval script (`pnpm --filter @job-agent/pipeline eval:<stage>`) that runs
the real model on a golden set, only with an explicit `--live` flag and `ANTHROPIC_API_KEY` set, and prints accuracy
and cost. No eval script is shipped yet, so there is nothing to run. Until then:

- `pnpm test` checks the rule and decision code (resolve, scam score, tier and ask) against the golden sets in
  `fixtures/golden/*.json`. These never call the model.
- All tests mock the Anthropic API; no test makes a live call.
- Evals cost real money and are run by you, not by the agents. When one exists it counts against the same daily cap.

## Smoke test

`bin/smoke [dir]` runs the whole pipeline once against the live public feeds without touching `config/` or `data/`:
it copies the `config/*.example.*` files, uses a temp DB (`<dir>/smoke.db`, default dir from `mktemp`), then runs
`fx`, `discover --force --source <s>` for each keyless source one by one (`himalayas`, `remoteok`, `remotive`,
`weworkremotely`, `hn`, `arbeitnow`, plus one public ATS board: Greenhouse `gitlab`, written into the
temp `companies.yaml`; `web3career` only if `WEB3_CAREER_TOKEN` is already in your environment), `process`,
`enrich` (it runs without a key and prints its skip line), and `digest` into
`<dir>/digests/`. It ends with `status` (row counts and per-source result) and the smoke dir and digests paths.

A failing source shows as `error` and does not stop the others. The script exits 0 when `process` and `digest`
completed, 1 if either failed. It makes no LLM calls (`ANTHROPIC_API_KEY` is unset for the run).

## Schedule with cron

`scripts/crontab.example` runs:

- `fx` daily at 06:50 Asia/Jakarta
- `discover-companies` daily at 07:00 Asia/Jakarta (before the first `discover` of the day)
- `discover`, `process`, then `enrich` every 2 hours (at :30)
- `discover`, `process`, `enrich`, then `digest` daily at 08:00 Asia/Jakarta

So the order in a day is `fx` -> `discover-companies` -> `discover` -> `process` -> `enrich` -> `digest`.

Cron uses the Mac's local time. The example assumes the clock is set to Asia/Jakarta; otherwise convert the hours.

To install:

1. Copy it: `cp scripts/crontab.example data/crontab` (`data/` is gitignored).
2. In the copy, replace `/ABSOLUTE/PATH/TO/job-agent` with the repo root (`pwd`) and `/ABSOLUTE/PATH/TO/node/bin` with
   `dirname "$(command -v pnpm)"` (cron has a minimal `PATH`). Add `ANTHROPIC_API_KEY=<key>`, `BRAVE_API_KEY=<key>`,
   `JOB_AGENT_LLM_CAP_USD=<lower cap, optional>` and `WEB3_CAREER_TOKEN=<token>` (if you use web3.career) under the
   `PATH` line. Keep the copy in `data/`, never commit it.
3. Check what is already installed: `crontab -l`. `crontab <file>` **replaces** your whole crontab, so merge any
   existing lines into the copy first.
4. Install: `crontab data/crontab`, then `crontab -l` to confirm.

On macOS, cron may need Full Disk Access (System Settings → Privacy & Security → Full Disk Access → add `/usr/sbin/cron`)
if the repo lives in a protected folder such as Documents or Desktop. To remove the schedule: `crontab -r` (removes all
your cron jobs) or edit with `crontab -e`.

## Where output lands

| Path | Contents |
|---|---|
| `data/digests/YYYY-MM-DD.md` | The daily ranked digest |
| `data/logs/<command>.log` | Cron output per command (`fx`, `discover-companies`, `discover`, `process`, `enrich`, `digest`): plain lines plus JSON log lines |
| `data/job-agent.db` | The SQLite database |

Everything under `data/` is gitignored and may contain personal data. Never commit it.

## Reading the ranked digest

Open `data/digests/YYYY-MM-DD.md`. Sections, in order:

- **Top matches**: kept postings with a fit score of 60 or more (`TOP_MATCH_MIN_FIT` in `digest/rank.ts`), best first. Each shows title, company, link, fit score with up to 3
  reasons, the pay tier and your ask (or the text answer to use when the posting has no numeric field), the listed
  salary if any, the scam score with its top reason if above 0, and a one-line **why**. The rank is the fit score, minus
  10 per unresolved flag, plus 5 when the listed salary max is at or above your ask; ties go to the newer posting. The
  same company and title listed in several places is one entry with the locations joined.
- **Scored, not a fit**: kept postings scored below 60, one line each, so the list is quick to skim:
  `- title — company — fit N/100 — first fit reason — link` (no reason part when there is none). Highest fit first, then
  newer posting. They are not in Needs a look. The summary shows the count; "Kept" counts Top matches, Scored, not a
  fit and Waiting for scoring.
- **Waiting for scoring**: kept postings without a fit score yet: not enriched (no `ANTHROPIC_API_KEY`), `budget_wait`
  (daily cap reached, retried tomorrow), or `failed`.
- **Needs a look**: postings with a flag the rules and the LLM could not settle (location, Indonesia rule, role).
- **Suspicious**: scam score at or above 60. Listed only; never fit-scored and never acted on. Each has its reason lines.
- **Source health**: see below.
- **LLM spend**: today's cost against the cap, and calls per model.

## Reading Source health

The last section of every digest has one line per source that has ever run, built from its latest run in the last
24 hours:

```
- **remotive**: ok, found 19, new 4
- **web3career**: error, found 0, new 0, error: [web3career] WEB3_CAREER_TOKEN not set — NO SUCCESSFUL RUN
- **hn**: skipped, found 0, new 0
```

- `ok, found N, new M`: the source answered; N postings in its response window, M not seen before.
- `skipped`: the latest run came too soon after the previous successful one (poll interval). Normal between polls.
- `error, ..., error: <message>`: the latest run failed; the message says why (HTTP status, invalid response, missing token).
- `no run in the last 24h`: cron or `discover` has not run this source for a day.
- `NO SUCCESSFUL RUN`: no `ok` run in the last 24 hours. A source with this mark for more than a day needs a look:
  check `data/logs/discover.log`, then run `pnpm job-agent discover --source <name>` by hand.

## Resetting

- Start over completely: delete the database and its side files, `rm -f data/job-agent.db data/job-agent.db-*`.
  The next command recreates it (migrations run on open). The next `discover` looks back 7 days per source.
- Regenerate a digest: `pnpm job-agent digest --date YYYY-MM-DD` rewrites that day's file.
- Delete old digests or logs: remove the files under `data/digests/` or `data/logs/`.
