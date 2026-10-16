# Fetching one LinkedIn job description through JobSpy (t_8bf04d47)

Checked 2026-10-16. No request to linkedin.com was made. Sources: `speedyapply/JobSpy` at tag `v1.3.0` (the version pinned in
`workers/jobspy/requirements.txt`), read through raw.githubusercontent.com / github.com. Bash was unavailable in this run, so the
files were read through a summarising fetch tool: **exact line numbers could not be obtained** (the tool strips blank lines).
Symbols and quoted strings are given instead; the dev should confirm lines when opening the tag.
Base URL: https://github.com/speedyapply/JobSpy/blob/v1.3.0/

## Answer

JobSpy 1.3.0 has **no public per-job call**. The only per-job code is the underscore method
`LinkedIn._fetch_details(job_id)` (`jobspy/linkedin/__init__.py`), one GET to `/jobs/view/<id>`. The public route is
`scrape_jobs(..., fetch_description=True)`, which fetches a description for **every** card of the search, with no id filter and no sleep.
So "description only for chosen ids" means calling the internal method from `run.py`: workable, but it relies on a private API
(Q6, decision for the PM).

## Q1. Per-job detail call

- Class `LinkedIn` (no underscore) in `jobspy/linkedin/__init__.py`; constructor
  `LinkedIn(proxies=None, ca_cert=None, user_agent=None)`.
- Method `_fetch_details(self, job_id: str) -> dict`. **Internal** (underscore), undocumented in README.
- It reads `self.scraper_input.description_format`, and `scraper_input` is only assigned inside `scrape()`. A direct call therefore needs the dev
  to set `scraper_input` first (a `ScraperInput` from `jobspy.model` with `description_format`), or it raises `AttributeError`. This is a
  second reason it is fragile.
- Request: `self.session.get(f"{self.base_url}/jobs/view/{job_id}")`, `job_id` is the bare number (our id is `li-<jobid>`: strip `li-`).
- Return shape (dict): `description` (str; format from `format_description`, README says `description_format` is `markdown` (default) or `html`),
  `emails`, `compensation` (parsed from `div.compensation__salary` via `_parse_salary`), `job_type` (**list with one enum**, or `None`; from
  "Employment type"), `job_level` (lowercased, from "Seniority level"), `job_function`, `company_industry`, `company_logo`.
  **No `job_url_direct`**: it is never set anywhere in the LinkedIn code; `job_url` is the only link.
  Description is taken from `div.show-more-less-html__markup`.
- Stability: UNKNOWN across releases in detail. Evidence: the flag was renamed `linkedin_fetch_description` -> `fetch_description` in 1.2.0
  (2026-10-02; old name deprecated, removed in 2.0), and PR #404 (2026-10-06) changed failed-job-page handling; #418 and #421 (2026-10-15) touch
  LinkedIn salary parsing. The library was rewritten in the first half of October 2026 after 14 months without a release, so an underscore
  method has changed within two weeks and should be assumed unstable. Pin the version and cover it with a fixture/contract test.

## Q2. Other ways to fetch descriptions for a subset

- `scrape_jobs` signature (v1.3.0 `jobspy/__init__.py`): `... results_wanted=15, ..., linkedin_fetch_description=False, linkedin_company_ids, offset=0,
  hours_old, ..., verbose=1, user_agent, fetch_description=False`. There is **no id filter and no detail-only entry point**; it only calls each
  scraper's `scrape(scraper_input)`.
- Option A, `fetch_description=True` on a normal search: `ceil(n/10)` list GETs (3-7 s sleep between pages) **plus one GET per card**
  in a loop with no sleep (`_process_job`: `self._fetch_details(job_id) if self.scraper_input.fetch_description else {}`). 25 cards = up to 28 requests, burst.
  Fetches all cards, including ones we already know or reject.
- Option B, `fetch_description=True` with small `results_wanted` / `offset`: cannot target an id; results are ordered by LinkedIn, so it
  only re-fetches whatever is on top. Not a way to choose ids. (Our own judgement: not usable.)
- Option C, call `LinkedIn(...)._fetch_details(id)` per chosen id: 1 GET per posting, spacing under our control. Internal API.
- `linkedin_company_ids` filters the search by company, not by job id.

## Q3. What a block looks like on the detail request

From `_fetch_details` (strings quoted from v1.3.0, via the fetch tool; wording could differ slightly):
- Exception on request: warning `"LinkedIn: job {job_id}: {e}"`, returns `{}`.
- HTTP status other than 200 (429, 999, 404, ...): warning `"LinkedIn response status code {response.status_code} for job {job_id}"`, returns `{}`.
- Redirect: the session does not appear to follow redirects blindly; the code checks `urlparse(response.url).path` starts with `/jobs/view/`, otherwise
  warning `"LinkedIn: job {job_id}: redirected to {path}"`, returns `{}`. An authwall redirect would show here with a path like `/authwall`.
  (Note: a 3xx status that is not followed would instead hit the non-200 branch. UNKNOWN which; both are caught.)
- **JobSpy swallows all of this.** The job is kept, with no description (`{}` unpacked into `JobPost`; default for `description` is probably `None`,
  not confirmed). Nothing raises. A caller of `scrape_jobs` cannot tell "blocked" from "page has no description" except through the log.
  A direct `_fetch_details` caller gets `{}` for both too.
- **Existing `BLOCK_PATTERN` (`run.py:40-45`) matches** `status code 429|999|403` (the string above contains "status code 429") and `authwall`,
  but **not** the redirect line unless the path contains `authwall`. A redirect to `/login` or `/checkpoint/...` would not match. Add
  `redirected to` (only for paths outside `/jobs/view/`) to the pattern, or treat any `{}` return as "no description", and 2+ in a row as a block.

### Important finding about the worker's log capture (affects the whole worker, not only descriptions)

`jobspy/util.py` at v1.3.0 (`create_logger`) names loggers `JobSpy:<Site>` (e.g. `JobSpy:LinkedIn`), sets **`logger.propagate = False`**, and adds its
own `StreamHandler` at INFO. `set_logger_level(verbose)` maps `verbose=1` -> WARNING, `verbose=0` -> **ERROR**, anything else -> INFO.
`run.py:121` passes `verbose=0` and `_Collector` is attached to the **root** logger (`run.py:146-147`).
Consequences, if the fetch tool summarised correctly (medium confidence, needs one check):
1. Records never reach the root logger because propagation is off, so `_Collector` would see nothing from JobSpy.
2. With `verbose=0` the level is ERROR, so the **warning**-level detail-request failures above are not even emitted. Search-page errors are
   logged at error level but still do not propagate.
Verify with one `bin/smoke` run (or a unit test that attaches the collector to `logging.getLogger("JobSpy:LinkedIn")` and sets `verbose=1`).
The prior research (t_a46f63f1, Q7) assumed the logger was `jobspy` and root-capturable: UNKNOWN whether that held; it is flagged here.
For the description pass the dev must therefore attach the handler to `JobSpy:LinkedIn` (and call with `verbose=1` or set the level) so warnings arrive.
If calling `_fetch_details` directly, the `{}` return alone is the signal plus the log record; the dev need not depend on logs for "no description".

## Q4. Anything the worker does not already pass?

No. `LinkedIn.__init__` builds `create_session(..., is_tls=False, clear_cookies=True)` (plain `requests`, cookies cleared before each request,
module `headers`), so it is logged out and cookie-free by construction. Proxies, `ca_cert`, `user_agent` are optional constructor args; we pass none
(and #409 says a refused custom UA yields a 403). Session timeout: the summary says `request_timeout = 15` in `util.py` (TLS/Requests wrappers), not passed in
`_fetch_details` itself; UNKNOWN whether the 15 s default applies to the `is_tls=False` path.
Reusing one `LinkedIn` instance for several ids reuses one session; with `clear_cookies=True` that stays cookie-free.

## Q5. Spacing and cap

Sources: README: "LinkedIn rate limits bursts of requests with a 429, which clears within about a minute"; no numeric threshold is published
(UNKNOWN). JobSpy itself sleeps `uniform(3, 7)` seconds between **search pages** (`scrape()`, `if start > first_start`), which is the only
number the library offers; it applies no delay between detail requests.
Our judgement (not from a source): >= 5 s between detail GETs (match JobSpy's own 3-7 s band; use `uniform(4, 8)` so it is not metronomic),
cap 10 detail requests per run, at most 25 per hour, and stop the whole pass on the first block signal, record a block and enter the existing
backoff. Detail fetches go only after the title and location filters have passed, so volume is a fraction of the 25 cards per search.
Confidence low (no published limit).

## Q6. Is calling an internal method "LinkedIn access inside the JobSpy dependency"?

Literally yes: the HTTP call, URL, headers and parsing all stay in JobSpy code; our code would not contain a LinkedIn URL or selector.
Risk in one line: it depends on a private method that was reworked in October 2026 and needs `scraper_input` set by hand, so a JobSpy bump can
break it silently, and a reviewer could argue it is a custom LinkedIn call in spirit. Alternative with no private API: `fetch_description=True`
on the normal search (public, supported), at the cost of a no-sleep burst of up to 25 extra GETs per search and descriptions for postings we
would reject. Trade-off for the PM/owner; this research does not decide it.

## Recommendation for the dev card

Assuming the PM accepts the internal call (otherwise use Option A with `results_wanted` lowered and a longer interval):
- Call: new worker mode, e.g. `site="linkedin"`, `job_ids=[...]`, in `run.py`: `from jobspy.linkedin import LinkedIn`; build
  `LinkedIn()`; set `scraper_input` to a `ScraperInput` with `description_format` (markdown); loop `inst._fetch_details(id_without_li_prefix)`.
  Check the exact `ScraperInput` fields at the pinned tag first. Keep the import inside a function (as `_load_scrape` does) and add a
  contract test that fails loudly if `_fetch_details` or `ScraperInput` is missing.
- Requests per posting: exactly 1 GET to `/jobs/view/<id>`; no list request.
- Fields to use: `description`; optionally `job_type[0]`, `compensation` (rarely present), `job_level`. Do not expect `job_url_direct`.
- Block signals: (1) `_fetch_details` returned `{}` or no `description`; (2) log records on `JobSpy:LinkedIn` containing `status code 429|999|403` or
  `redirected to <non /jobs/view/ path>`; (3) 2 empty returns in a row = treat as a block. A single empty return can be an expired job (404): keep
  the posting, no description, do not retry in the same run. First fix the log-capture issue above.
- Spacing: `uniform(4, 8)` s between requests (our judgement); cap 10 per run, 25 per hour; abort the pass at the first block.
- Only for postings that already passed title and source-location rules, only new ids (no re-fetch when a description is stored).
- Run once through `bin/smoke` and store the observed log lines as a fixture.

## Confidence

Medium-low for line-level facts (source read through a summarising tool, no line numbers, wording of log strings may be paraphrased in places);
high for the structural conclusions (no public per-job API, one GET per id, failures swallowed and job kept). Would raise it: open
`jobspy/linkedin/__init__.py` and `jobspy/util.py` at tag v1.3.0 with line numbers, and run `bin/smoke` once with `verbose=1` while attaching a handler to `JobSpy:LinkedIn`.

## Sources (checked 2026-10-16)

- https://raw.githubusercontent.com/speedyapply/JobSpy/v1.3.0/jobspy/linkedin/__init__.py (`LinkedIn.__init__`, `_fetch_details`, `_process_job`, `scrape`)
- https://raw.githubusercontent.com/speedyapply/JobSpy/v1.3.0/jobspy/__init__.py (`scrape_jobs` signature, `SCRAPER_MAPPING`)
- https://raw.githubusercontent.com/speedyapply/JobSpy/v1.3.0/jobspy/util.py (`create_session`, `create_logger`, `set_logger_level`)
- https://github.com/speedyapply/JobSpy/blob/v1.3.0/README.md (rate limit sentence, `fetch_description`, `description_format`, verbose levels)
- PRs #404, #409, #418, #421 via https://api.github.com/repos/speedyapply/JobSpy/issues?state=all
- Existing: `docs/research/t_a46f63f1-jobspy.md`, `workers/jobspy/run.py`
