# JobSpy worker

Runs ONE logged-out search through [JobSpy](https://github.com/speedyapply/JobSpy) and prints one JSON object per job
on stdout. The TypeScript adapter (`packages/sources/src/jobspy/`) spawns it, validates every line and is the only
writer of the database. The worker has no database access, writes no files and uses no cookies, proxies or
user-agent rotation. All LinkedIn / Indeed access lives inside the JobSpy dependency.

## Setup (from the repo root)

```
python3 -m venv workers/jobspy/.venv
workers/jobspy/.venv/bin/pip install -r workers/jobspy/requirements.txt
```

Needs Python >= 3.10. Without the venv the `linkedin` source run is recorded as `skipped`
("jobspy worker not installed").

## Protocol

Arguments: one JSON object in argv[1] (or on stdin): `site` (`linkedin` | `indeed`), `search_term`, `location`,
`is_remote`, `hours_old`, `results_wanted` (<= 25 for LinkedIn, <= 50 for Indeed), `country`.

Exit 0: one job object per line. Exit 2: one line `{"error": "...", "kind": "blocked" | "error"}`. A block is a
429 / 999 / 403 status, an authwall or CAPTCHA, read from JobSpy's log records (JobSpy logs blocks instead of raising).

## Tests

`python3 -m unittest discover -s workers/jobspy -p 'test_run.py'` (JobSpy mocked, never touches the network).
`pnpm check` runs it when `python3` exists.
