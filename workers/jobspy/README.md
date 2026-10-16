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
`is_remote`, `hours_old` (1 to 24), `results_wanted` (<= 25 for LinkedIn, <= 50 for Indeed), `offset` (integer >= 0, default 0; `offset + results_wanted` <= 100; passed to `scrape_jobs(offset=...)`, JobSpy 1.3.0), `country`.

Exit 0: one job object per line. Exit 2: one line `{"error": "...", "kind": "blocked" | "error"}`. A block is a
429 / 999 / 403 status, an authwall or CAPTCHA, read from JobSpy's log records (JobSpy logs blocks instead of raising).

**Details mode** (LinkedIn descriptions, `fetch-descriptions`): argument `{"mode": "details", "site": "linkedin", "job_ids": ["li-123", ...]}`
(1 to 20 ids; a bare id, `li-<id>` or a `/jobs/view/` URL). JobSpy has no public per-job call, so the worker calls its private
`LinkedIn._fetch_details(id)` (one GET per id, logged out, 10 s apart inside one call) and fails loudly when that method is gone.
Exit 0: one line per id, `{"id": "<as given>", "description": "..."}` or `{"id": "<as given>", "error": "..."}` (an empty page is
a per-id failure, not a block). A block (429 / 999 / 403 status, authwall, CAPTCHA, a redirect away from `/jobs/view/`) prints the
lines of the ids done before it, then `{"error": "...", "kind": "blocked"}` and exits 2.

## Tests

`python3 -m unittest discover -s workers/jobspy -p 'test_run.py'` (JobSpy mocked, never touches the network).
`pnpm check` runs it when `python3` exists.
