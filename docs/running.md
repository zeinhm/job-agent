# Running Phase 1

How to run the Phase 1 pipeline (find remote postings, filter them, write a daily digest) on your Mac.
Phase 1 only reads public job feeds and writes local files. It never applies anywhere.

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

`config/` is private and gitignored. Phase 1 reads two files from it. Start from the example files and put your own
values in the copies; never commit them:

```sh
cp config/salary.example.yaml config/salary.yaml
cp config/companies.example.yaml config/companies.yaml
```

| File | Used by | What it holds |
|---|---|---|
| `config/salary.yaml` | `process` | `floor_idr_month`: postings whose listed max is below it are rejected (plus later-phase fields) |
| `config/companies.yaml` | `discover` | companies whose Greenhouse / Lever / Ashby boards are polled (`name`, `ats`, `slug`) |

`config/README.md` lists every example file. The other examples (`cv`, `answers`, `private-patterns`) are not read by
Phase 1 commands; `private-patterns.txt` is used by the pre-commit hook.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `JOB_AGENT_DB` | `data/job-agent.db` | SQLite database file |
| `JOB_AGENT_CONFIG_DIR` | `config` | Folder holding `salary.yaml` and `companies.yaml` |
| `WEB3_CAREER_TOKEN` | (none) | API token for the web3.career source. Without it, that source shows `error` in Source health; the other sources still run |

Never put the token in a committed file. Set it in your shell profile or in your local crontab's environment lines.

## Commands

Run from the repo root as `pnpm job-agent <command>` (add `-s` to hide pnpm's own banner).

| Command | What it does |
|---|---|
| `fx` | Fetches today's USD exchange rates (IDR, EUR, GBP, SGD, AUD, CAD, CHF) and stores them. Salaries are converted with the latest stored rate on or before the analysis date, so run it daily. |
| `discover [--source <name>] [--force]` | Polls every source that is due and stores new postings. Each source has a minimum poll interval enforced in code; a source polled too recently is recorded as `skipped` and gets no request. `--source` runs one source (`greenhouse`, `lever`, `ashby`, `himalayas`, `remoteok`, `remotive`, `web3career`, `weworkremotely`, `hn`, `arbeitnow`); `--force` ignores the interval (manual use only). Exits 1 if any source errored. |
| `process` | Normalizes and dedupes new postings, then applies the rule filters (location, Indonesia rule, salary floor) and records keep / reject with flags. Prints the counts. |
| `status` | Prints the row count of every table and the latest run (status, found, new, error) per source. Read-only. |
| `digest [--date YYYY-MM-DD] [--out-dir <dir>]` | Writes `data/digests/<date>.md` (or into `--out-dir`) with the kept postings not yet sent in an earlier digest, plus Source health and LLM spend, and prints the file path. Sections: Top matches (fit-scored, ranked, each with a one-line why), Waiting for scoring (no intel yet, budget wait, failed or no fit score), Needs a look, Suspicious, Source health, LLM spend (today's cost vs the cap, calls per model). Without an `ANTHROPIC_API_KEY` every kept posting sits under Waiting for scoring. Default date: today in Asia/Jakarta. Re-running for the same date rewrites the same file and adds postings kept since. |

A first manual run:

```sh
pnpm job-agent fx
pnpm job-agent discover --source remotive
pnpm job-agent process
pnpm job-agent digest
```

## Smoke test

`bin/smoke [dir]` runs the whole pipeline once against the live public feeds without touching `config/` or `data/`:
it copies the `config/*.example.*` files, uses a temp DB (`<dir>/smoke.db`, default dir from `mktemp`), then runs
`fx`, `discover --force --source <s>` for each keyless source one by one (`himalayas`, `remoteok`, `remotive`,
`weworkremotely`, `hn`; `web3career` only if `WEB3_CAREER_TOKEN` is already in your environment), `process`,
`enrich` (only once that command exists; it runs without a key and prints its skip line), and `digest` into
`<dir>/digests/`. It ends with `status` (row counts and per-source result) and the smoke dir and digests paths.

A failing source shows as `error` and does not stop the others. The script exits 0 when `process` and `digest`
completed, 1 if either failed. It makes no LLM calls (`ANTHROPIC_API_KEY` is unset for the run).

## Schedule with cron

`scripts/crontab.example` runs:

- `fx` daily at 07:00 Asia/Jakarta
- `discover` then `process` every 2 hours (at :30)
- `discover`, `process`, then `digest` daily at 08:00 Asia/Jakarta

Cron uses the Mac's local time. The example assumes the clock is set to Asia/Jakarta; otherwise convert the hours.

To install:

1. Copy it: `cp scripts/crontab.example data/crontab` (`data/` is gitignored).
2. In the copy, replace `/ABSOLUTE/PATH/TO/job-agent` with the repo root (`pwd`) and `/ABSOLUTE/PATH/TO/node/bin` with
   `dirname "$(command -v pnpm)"` (cron has a minimal `PATH`). Add `WEB3_CAREER_TOKEN=<token>` under the `PATH` line
   if you use web3.career.
3. Check what is already installed: `crontab -l`. `crontab <file>` **replaces** your whole crontab, so merge any
   existing lines into the copy first.
4. Install: `crontab data/crontab`, then `crontab -l` to confirm.

On macOS, cron may need Full Disk Access (System Settings → Privacy & Security → Full Disk Access → add `/usr/sbin/cron`)
if the repo lives in a protected folder such as Documents or Desktop. To remove the schedule: `crontab -r` (removes all
your cron jobs) or edit with `crontab -e`.

## Where output lands

| Path | Contents |
|---|---|
| `data/digests/YYYY-MM-DD.md` | The daily digest |
| `data/logs/<command>.log` | Cron output per command (`fx`, `discover`, `process`, `digest`): plain lines plus JSON log lines |
| `data/job-agent.db` | The SQLite database |

Everything under `data/` is gitignored and may contain personal data. Never commit it.

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
