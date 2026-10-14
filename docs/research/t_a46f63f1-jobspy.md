# JobSpy for LinkedIn and Indeed (t_a46f63f1)

Access date for every source below: 2026-10-14. No live LinkedIn or Indeed request was made; only GitHub, PyPI and the
two sites' public legal/robots pages were read. Where a claim comes from source code, the file is on `main` of
`speedyapply/JobSpy` (HEAD 2026-10-13, three commits after the 1.3.0 tag), so pin and re-read the pinned tag in the dev card.

## Answer

Use `python-jobspy==1.3.0` (MIT, Python >= 3.10). It was rewritten in the first half of October 2026, so most older
blog advice is stale. The big surprises: LinkedIn **ignores `is_remote` and `job_type`** (the logged-out endpoint takes
neither), so "remote" must come from the search term and a post-filter; and LinkedIn `date_posted` is a **date only**,
so "within an hour" cannot be proven from the library output, only from `f_TPR=r3600` plus our own `first_seen_at`.
Blocks surface as an error log line plus an empty or short DataFrame, **not as an exception** (see Q5), so the worker must
detect them itself.

## Q1. Version, licence, maintenance, install

| Fact | Value | Source |
|---|---|---|
| Latest | 1.3.0, uploaded 2026-10-08 (1.2.0 on 2026-10-02; before that 1.1.82 on 2025-07-28) | https://pypi.org/project/python-jobspy/ |
| Licence | MIT | PyPI JSON https://pypi.org/pypi/python-jobspy/json |
| Python | `>=3.10` | same |
| Runtime deps | beautifulsoup4, curl_cffi>=0.16.2, markdownify, pandas>=2.1.2, pydantic>=2.3.0, requests | same |
| Activity | Very active: 20+ commits 2026-10-01..2026-10-13 (https://api.github.com/repos/speedyapply/JobSpy/commits) | GitHub API |

Install (exact):

```
python3 -m venv workers/jobspy/.venv
workers/jobspy/.venv/bin/pip install "python-jobspy==1.3.0"
workers/jobspy/.venv/bin/pip freeze > /dev/null   # optional: pin transitive deps in requirements.txt
```

SOCKS proxies would additionally need `requests[socks]` (README); we do not use proxies.

Breakages / changes in the last 6 months relevant to us (all from the PR list, https://api.github.com/repos/speedyapply/JobSpy/issues?state=all):
- Nothing between 2025-07-28 and 2026-09-30 was released (gap of 14 months on PyPI), then a burst of fixes.
- #404 (LinkedIn, 2026-10-06): `is_remote`/`job_type` now warn and are not sent; paging fixed, `offset` exact, hard stop at 1000; "an empty or throttled page (HTTP 429) is logged. It used to look like the end of the results"; failed job pages (404/429/999) are logged and the job is kept; jobs from companies without a LinkedIn page are no longer dropped; missing company is empty, not "N/A".
- #380 (2026-10-01): LinkedIn salaries restored.
- #403 (Indeed, 2026-10-06): `is_remote` true only for fully remote (not hybrid); `hours_old` no longer returns jobs outside the window; `date_posted` is the UTC date; `job_url_direct` no longer an indeed.com link; HTTP 400 on backslash in the term fixed.
- #409 (2026-10-07): `user_agent` is sent as given; "a refused value now fails with a 403 and no jobs". For Indeed a custom UA is only honoured if it contains "Indeed App" (#403). **Do not set `user_agent`.**
- #395: `tls-client` replaced by `curl_cffi` (Chrome TLS impersonation) for Glassdoor/ZipRecruiter/Bayt.
- #415 (2026-10-12): all `scrape_jobs` args validated: bad values raise `ValueError` naming argument and value; unknown argument names raise `TypeError`; `site_name`, `job_type`, `description_format` must be lowercase; `country_indeed` any case.
- Not found: a reported LinkedIn/Indeed outage in the window. UNKNOWN whether Indeed's hard-coded mobile-app API key (in `jobspy/indeed/constant.py`) will keep working; it is a single point of failure.

## Q2. Parameters per search

JobSpy 1.3.0 signature facts: README https://github.com/speedyapply/JobSpy/blob/main/README.md, `jobspy/__init__.py`, `jobspy/model.py`.

- `results_wanted` default 15, `hours_old` and `offset` must be `>= 0`, no maximum (model.py).
- `linkedin_fetch_description` is a deprecated alias (DeprecationWarning, removed in 2.0); the current flag is `fetch_description` (default off). Use `fetch_description`.
- No combination of `hours_old` + `is_remote` is rejected on Indeed: the code adds filters to one list (`indeed/__init__.py`). The earlier community folklore "Indeed hours_old cannot be combined with job_type/easy_apply" is **not** in the current code. Treat as UNKNOWN server-side; keep `job_type` and `easy_apply` unset anyway.
- LinkedIn: `is_remote`, `job_type` are ignored with a log line "isn't supported, ignoring it". LinkedIn "searches globally and uses only location" (README). Params actually sent: `keywords`, `location`, `distance`, `f_AL` (easy_apply), `f_C` (company ids), `f_TPR`, `start`.
- Indeed `is_remote=True` adds "must have remote attribute" and "must not have hybrid" filters; `hours_old=N` adds `start: "Nh"`, server side.
- `country_indeed` accepts `"indonesia"` (enum `INDONESIA = "indonesia"`, listed for Indeed only in README). Whether Indonesia needs the `location` text to be set is UNKNOWN. For global remote use the default `usa`/or `worldwide`: **UNKNOWN** if a "worldwide" value exists; the Indeed global-remote search is therefore best expressed as `country_indeed="usa"` with `is_remote=True`, which is US-scoped. The card must flag this to the PM: Indeed has no global search, only per-country sites.

| Search | site_name | search_term | location | is_remote | hours_old | results_wanted | country_indeed | fetch_description | offset |
|---|---|---|---|---|---|---|---|---|---|
| LinkedIn Worldwide + remote | `["linkedin"]` | `remote senior frontend OR "full stack" OR react OR typescript engineer` (see below) | `Worldwide` | omit (ignored) | `1` | `25` | n/a | `False` (see Q5), fetch later only for new, relevant ids | `0` |
| LinkedIn Indonesia + remote | `["linkedin"]` | same term with `remote` | `Indonesia` | omit (ignored) | `1` | `25` | n/a | `False` | `0` |
| Indeed global remote | `["indeed"]` | `senior frontend OR "full stack" OR react OR typescript` | `""` omitted | `True` | `2` (poll every 2 h; Indeed date granularity is a day, so this effectively returns today's jobs, see Q4) | `50` | `"usa"` (UNKNOWN for a true global option) | `False` (Indeed returns the description in the search response) | `0` |
| Indeed Indonesia + remote | `["indeed"]` | same | `Indonesia` | `True` | `2` | `50` | `"indonesia"` | `False` | `0` |

Recommended terms: LinkedIn keywords go to the guest endpoint as `keywords=`; LinkedIn's UI supports `OR`/quotes, but whether the logged-out endpoint honours boolean operators is **UNKNOWN** (not tested; no live requests allowed). Safe fallback for the dev card: two short terms, one per LinkedIn search, e.g. `senior frontend engineer remote` and `react typescript remote`, rotated by run or run as the 2 searches with a different location each. Indeed searches descriptions too, so use `-` to exclude and quotes for phrases (README Troubleshooting). The conventions file caps LinkedIn at 2 searches per run, so the term choice per search is a PM decision: either (a) one broad term per location, or (b) alternate terms on odd/even hours.

LinkedIn `is_remote` in the output is **not** the filter; it is `is_job_remote(title, location)`: true if "remote", "work from home" or "wfh" appears in title or location (`jobspy/linkedin/util.py`). So "remote" must be in the search term, and the worker must post-filter or let the existing remote rules decide.

## Q3. Output columns

JobPost schema (README + `model.py`): id, site, job_url, job_url_direct, title, company, location, date_posted, job_type, salary_source, interval, min_amount, max_amount, currency, is_remote, job_level, job_function, listing_type, emails, description, company_industry, company_url, company_logo, company_url_direct, company_addresses, company_num_employees, company_revenue, company_description, skills, experience_range, company_rating, company_reviews_count, vacancy_count, work_from_home_type. "A column is empty when the job board doesn't provide that data." The DataFrame is sorted by `site` ascending then `date_posted` descending.

| Column | LinkedIn | Indeed | Basis |
|---|---|---|---|
| id | yes, `li-<jobid>` | yes, `in-<jk>` | linkedin/indeed `__init__.py` |
| job_url | yes (`/jobs/view/<id>`) | yes (`/viewjob?jk=`) | same |
| job_url_direct | **no** (not set in LinkedIn code) | usually the employer apply URL; `None` when the host is `*.indeed.com` | same |
| title / company / location | yes; missing title/company/location skips the card; location is the card text, parsed | yes | same |
| date_posted | `date` only (parsed from `<time datetime>`), `None` if tag missing | `date` (UTC date of `dateOnIndeed`) | same, model.py `date \| None` |
| is_remote | heuristic on title+location text | true only for fully remote (not hybrid) | #404, #403 |
| description | only with `fetch_description=True` (one extra GET per job) | yes, from the search response | same |
| min/max amount, currency, interval | only with `fetch_description=True` and when the page shows a `compensation__salary` in `$117,000.00/yr - $234,000.00/yr` shape; rarely filled | filled when Indeed provides compensation (non-US salaries since #392); more often than LinkedIn | same |
| job_type | only with `fetch_description=True` ("Employment type") | yes when attributes carry it | same |
| emails | extracted from the description text only (needs description) | extracted from the description | `format_description` |
| job_level, job_function, company_industry | only with `fetch_description=True` | partly (`company_industry`) | same |

Reliability grades from reading code, not from a real response: **medium**. A fixture-based check on the first live run is needed.

## Q4. Freshness

- `hours_old=1` → `f_TPR=r3600` exactly (`params["f_TPR"] = f"r{hours_old * 3600}"`, only if `hours_old` is truthy; `linkedin/__init__.py`). No client-side filtering exists, LinkedIn does the filtering. Whether LinkedIn honours `r3600` as an hour or rounds to its UI buckets (past hour = `r3600`, past 24 h = `r86400`) is **UNKNOWN**; `r3600` is the value LinkedIn's own "Past hour" filter uses (not verified live here).
- `date_posted` precision: LinkedIn **date** (day only), so "posted within an hour" can only be shown through the filter parameter, not the data. Indeed: UTC date; `hours_old` filters server-side on the day-granular add date (README: "the day a job was added to Indeed, the same date `hours_old` filters on"), so Indeed `hours_old=2` cannot mean two hours with certainty.
- How to prove "within an hour" on our side: store `first_seen_at` (poll time) per posting; comparing `first_seen_at` with the listing time is not possible without a timestamp, so the evidence is (1) the request carried `f_TPR=r3600` (log the params the worker used), (2) a posting first appears in our DB with `first_seen_at` within the hourly poll interval of its first sighting, (3) manual spot check of the `<time>` element's text ("X minutes ago") by the owner. Treat the "done when" as: LinkedIn postings first seen at most one poll interval after LinkedIn shows them in "Past hour".

## Q5. Requests, rate limits, block signals

Requests per search (code, linkedin/indeed `__init__.py` and `constant.py`):

| Case | Requests |
|---|---|
| LinkedIn search, no descriptions | `ceil(results_wanted/10)` GETs to `/jobs-guest/jobs/api/seeMoreJobPostings/search` (10 cards per page), each after the first preceded by `sleep(uniform(3, 7))`. `results_wanted=25` → at most 3 requests, 2 sleeps (6–14 s) |
| LinkedIn with `fetch_description=True` | + 1 GET to `/jobs/view/<id>` per card, **no sleep between them**, no retry. 25 cards → up to 28 requests per search in a burst |
| Indeed | 1 POST to `https://apis.indeed.com/graphql` per 100 jobs (`jobs_per_page = 100`), no delay, no retry, no per-job detail request. `results_wanted=50` → 1 POST |
| Two sites in one call | Threads in parallel (`ThreadPoolExecutor`); call one site per `scrape_jobs` call to control spacing |

Thresholds:
- LinkedIn: README only says "rate limits bursts of requests with a 429, which clears within about a minute." No numeric threshold published. Community-reported figures (e.g. blocks after about 10 pages per IP) were **not** verified here: UNKNOWN. The conventions' limits (<= 25 results, >= 10 s between searches, 2 searches/hour) are far below anything JobSpy itself does by default.
- Indeed: no published threshold; UNKNOWN. README: "429 response code: You've been blocked for sending too many requests. Wait between scrapes." Glassdoor throttles at ~30 requests per IP (#394) but that is not our site.

How a block shows up (important for the worker's block rule):
- `check_status` in `jobspy/util.py`: any status other than 200 raises `ValueError("response status code <N>")`. No retry, no special-casing of 429/999/403.
- But both scrapers catch it: LinkedIn logs the error (`self.log.error`) and **breaks the loop**; Indeed logs `str(e)` and breaks, returning whatever was collected. So `scrape_jobs` **returns an empty or partial DataFrame, not an exception**. An empty page body other than the known `empty_page` marker logs "unexpected page with no jobs (blocked?)"; an empty page at nonzero `start` logs "empty page at start=N (the end of the results, or throttled)". Blocks and "no new jobs" look identical in the data.
- Codes: LinkedIn 429 (rate limit), 999 (LinkedIn's anti-bot code, mentioned in #404 for job pages), redirects away from `/jobs/view/` (expired job or login wall; code treats as failed page); "authwall" is the redirect target for login walls (the code does not name it; UNKNOWN whether the list endpoint ever returns it). Indeed: 403 (also when a user_agent is refused, #409), 400 for malformed input (#403), GraphQL `errors` → `ValueError("API error: ...")` which is caught and logged.
- JobSpy uses stdlib `logging` (#414, 2026-10-12). **Dev card must attach a logging handler** and treat any record at ERROR level or containing `status code 429`, `999`, `403`, `blocked?` as a block. Rule suggested: if a LinkedIn/Indeed call returns 0 rows **and** logged at least one ERROR or "blocked?" record → source run `error`, enter the 6 h backoff. 0 rows with no error is legitimately "ok, nothing new".
- Never combine `hours_old=1` result of 0 rows with "ok" in the run record without checking the log.

Safe intervals (our judgement, not from a source): LinkedIn hourly with 2 searches, 25 results, no descriptions: 3 + 3 requests per hour spaced by sleeps; this is well under typical logged-out limits but unverified. Descriptions: prefer a second pass that fetches only the new, relevant ids one at a time with >= 3 s between them instead of `fetch_description=True` (which bursts). Indeed every 2 h with 2 POSTs: low risk (confidence medium-low). Both on the owner's home IP, as accepted in PLAN 2.

## Q6. Terms of service (what the texts say; not legal advice)

- LinkedIn User Agreement (effective 2025-11-03), section 8.2 Don'ts, https://www.linkedin.com/legal/user-agreement : prohibits to "Develop, support or use software, devices, scripts, robots or any other means or processes" to scrape/copy the Services, and to "Use bots or other unauthorized automated methods to access the Services", and to "Override any security feature or bypass or circumvent any access controls". The agreement binds members and visitors using the Services; logged-out use is still "using the Services". Verdict: JobSpy's LinkedIn mode is a scraping tool and is covered by those clauses. Items read via a summarizing fetch; exact numbering unverified.
- LinkedIn robots.txt, https://www.linkedin.com/robots.txt : the preamble states that automated access without express permission is prohibited; Googlebot group disallows `/jobs-guest/`; other groups not read in full (page truncated at 100k chars, wildcard group unseen): UNKNOWN whether `User-agent: *` disallows the guest endpoint JobSpy uses.
- Indeed Terms of Service (last updated 2026-09-29), https://www.indeed.com/legal : the part read (first 100k of 348k chars) only prohibits automation of the **Indeed Apply** process outside official tooling. Anti-scraping clause: UNKNOWN (rest of the page unread).
- Indeed robots.txt, https://www.indeed.com/robots.txt : generic group disallows `/graphql` and `/viewjob` on `www.indeed.com`; JobSpy calls `apis.indeed.com/graphql` (different host, with a mobile-app API key from the app) and builds `/viewjob` links but does not fetch them. robots.txt governs only its own host.
- Consequence for AGENTS.md: the hard guardrails ("never log into LinkedIn, no cookies") are met (no login, no cookies, logged out). Consequence in practice: account and IP-block risk only, already accepted by the owner (PLAN 2). Public repo rule: LinkedIn/Indeed access stays inside JobSpy; our code must not add its own HTTP calls to those hosts.

## Q7. Minimal JSON-lines script

Not run (no live requests allowed). Written from the 1.3.0 API; the dev card should run it once through `bin/smoke`.

```python
import json
import logging
import sys

from jobspy import scrape_jobs

blocked = []


class BlockCatcher(logging.Handler):
    def emit(self, record):
        msg = record.getMessage()
        if record.levelno >= logging.ERROR or "blocked?" in msg:
            blocked.append(msg)


logging.getLogger("jobspy").addHandler(BlockCatcher())  # logger name: assumed "jobspy" (UNKNOWN, see #393/#414)

args = json.loads(sys.argv[1])  # {"site_name": ["linkedin"], "search_term": "...", "location": "Worldwide", "hours_old": 1, "results_wanted": 25}
df = scrape_jobs(**args)

if df.empty and blocked:
    print(json.dumps({"error": blocked[0]}), file=sys.stderr)
    sys.exit(3)

for row in json.loads(df.to_json(orient="records", date_format="iso")):  # date -> "2026-10-14T00:00:00.000"
    print(json.dumps(row))
```

Notes: `to_json(orient="records", lines=True)` also works but emits NaN as `null` (fine) and dates as epoch milliseconds unless `date_format="iso"`. `df.to_dict` would keep Python `date` objects and break `json.dumps`. Validate each line with Zod; most columns are nullable.

## Risks and open questions for the PM

1. No LinkedIn remote filter: "remote" quality depends on the search term and on `is_job_remote` text matching. Expect noise.
2. No global Indeed: `country_indeed` is per country. "Indeed global remote" has no direct equivalent (UNKNOWN).
3. Blocks are silent (empty DataFrame plus a log line). The block rule in conventions section 8 needs the log handler above.
4. PyPI 1.3.0 is 6 days old and `main` has moved on three commits; pin an exact version and re-run fixtures on every bump.
5. LinkedIn date is day-only; the Phase 3 "within an hour" evidence needs the plan in Q4.
6. Indeed relies on a hard-coded mobile API key; its removal would break Indeed overnight.

## Confidence

Medium. Code behaviour (parameters, request counts, delays, date types) is read from source, high confidence for those lines; block thresholds, boolean keywords, "Worldwide" location handling, Indonesia domain and Indeed ToS scraping clause are UNKNOWN. A single `bin/smoke` run by the dev card with debug logging would raise it to high.
