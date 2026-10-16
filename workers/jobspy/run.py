"""JobSpy worker: one search (or one LinkedIn description fetch) in, JSON lines out.

Reads ONE JSON object of arguments from argv[1] (or stdin when no argument is given):
  site ("linkedin" | "indeed"), search_term, location, is_remote, hours_old, results_wanted, offset, country
  or, for the detail mode: {"mode": "details", "site": "linkedin", "job_ids": ["li-123", ".../jobs/view/123", ...]}

Prints one JSON object per job on stdout. On a block or any failure prints one JSON object
{"error": "<reason>", "kind": "blocked" | "error"} and exits 2.
Detail mode prints {"id": "<id as given>", "description": "<text>"} or {"id": "<id as given>", "error": "<reason>"} per id;
a block prints the lines of the ids done before it, then the blocked error line, and exits 2.

No database, no files, no cookies, no proxies, no user-agent rotation: all site access is inside JobSpy.
"""

import json
import logging
import re
import sys
import time

MAX_RESULTS = 100  # offset + results_wanted ceiling for one search (paging, conventions section 8)
SITES = {"linkedin": 25, "indeed": 50}  # site -> hard cap for results_wanted (conventions section 8)

JOB_FIELDS = (
    "id",
    "site",
    "job_url",
    "job_url_direct",
    "title",
    "company",
    "location",
    "date_posted",
    "job_type",
    "is_remote",
    "min_amount",
    "max_amount",
    "currency",
    "interval",
    "description",
)

# JobSpy logs a block instead of raising (research t_a46f63f1 Q5), so the worker reads its log records.
# The numbers count only next to status wording (JobSpy 1.3.0 logs "<Site> response status code <n>"), so a job id or a count never matches.
BLOCK_PATTERN = re.compile(
    r"\b(?:status(?:\s+code)?|http|response\s+code)\s*[:=]?\s*(?:429|999|403)\b"
    r"|\b(?:429\s+too\s+many\s+requests|403\s+forbidden|999\s+request\s+denied)"
    r"|blocked\?|authwall|captcha|too many requests",
    re.IGNORECASE,
)


# Detail mode (research t_8bf04d47): JobSpy swallows a failed detail request, so a redirect away from /jobs/view/ (authwall,
# login, checkpoint) counts as a block as well. A page that simply has no description is a per-id failure, not a block.
DETAIL_BLOCK_PATTERN = re.compile(
    BLOCK_PATTERN.pattern + r"|redirected\s+to\s+(?!/jobs/view/)\S+",
    re.IGNORECASE,
)
MAX_DETAIL_IDS = 20  # one call never asks for more (the TypeScript step caps a run at 20 detail requests)
DETAIL_GAP_SECONDS = 10  # between two ids of one call: the same gap as between two searches (SEARCH_GAP_MS)
LINKEDIN_LOGGER = "JobSpy:LinkedIn"  # JobSpy 1.3.0 names its loggers JobSpy:<Site> and does not propagate them to the root
JOB_ID_PATTERN = re.compile(r"^(?:li-)?(\d{4,20})$|/jobs/view/(?:[^/?]*-)?(\d{4,20})")


class WorkerError(Exception):
    def __init__(self, message, kind="error"):
        super().__init__(message)
        self.kind = kind


class _Collector(logging.Handler):
    def __init__(self, pattern=BLOCK_PATTERN):
        super().__init__(level=logging.WARNING)
        self.pattern = pattern
        self.errors = []
        self.blocks = []

    def emit(self, record):
        msg = record.getMessage()
        if self.pattern.search(msg):
            self.blocks.append(msg)
        elif record.levelno >= logging.ERROR:
            self.errors.append(msg)


def parse_args(raw):
    try:
        data = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise WorkerError("arguments are not valid JSON: %s" % exc)
    if not isinstance(data, dict):
        raise WorkerError("arguments must be a JSON object")
    site = data.get("site")
    if site not in SITES:
        raise WorkerError("site must be one of %s" % ", ".join(sorted(SITES)))
    term = data.get("search_term")
    if not isinstance(term, str) or not term.strip():
        raise WorkerError("search_term must be a non-empty string")
    location = data.get("location")
    if location is not None and not isinstance(location, str):
        raise WorkerError("location must be a string")
    hours_old = data.get("hours_old")
    if hours_old is not None and (
        not isinstance(hours_old, int) or isinstance(hours_old, bool) or hours_old < 1 or hours_old > 24
    ):
        raise WorkerError("hours_old must be an integer from 1 to 24")
    wanted = data.get("results_wanted", 10)
    if not isinstance(wanted, int) or isinstance(wanted, bool) or wanted < 1 or wanted > SITES[site]:
        raise WorkerError("results_wanted must be an integer from 1 to %d for %s" % (SITES[site], site))
    offset = data.get("offset", 0)
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
        raise WorkerError("offset must be an integer >= 0")
    if offset + wanted > MAX_RESULTS:
        raise WorkerError("offset + results_wanted must be at most %d" % MAX_RESULTS)
    is_remote = data.get("is_remote", False)
    if not isinstance(is_remote, bool):
        raise WorkerError("is_remote must be a boolean")
    country = data.get("country")
    if country is not None and not isinstance(country, str):
        raise WorkerError("country must be a string")
    return {
        "site": site,
        "search_term": term.strip(),
        "location": location,
        "hours_old": hours_old,
        "results_wanted": wanted,
        "offset": offset,
        "is_remote": is_remote,
        "country": country,
    }


def build_kwargs(args):
    kwargs = {
        "site_name": [args["site"]],
        "search_term": args["search_term"],
        "results_wanted": args["results_wanted"],
        "verbose": 0,
    }
    if args["offset"]:
        kwargs["offset"] = args["offset"]
    if args["location"]:
        kwargs["location"] = args["location"]
    if args["hours_old"] is not None:
        kwargs["hours_old"] = args["hours_old"]
    if args["site"] == "indeed":
        # LinkedIn's guest endpoint takes neither is_remote nor a country (research Q2).
        if args["is_remote"]:
            kwargs["is_remote"] = True
        if args["country"]:
            kwargs["country_indeed"] = args["country"]
    return kwargs


def _load_scrape():
    from jobspy import scrape_jobs  # imported late so the argument tests run without JobSpy installed

    return scrape_jobs


def run_search(args, scrape=None):
    """Returns the list of job dicts, or raises WorkerError (kind "blocked" for a block)."""
    collector = _Collector()
    root = logging.getLogger()
    root.addHandler(collector)
    try:
        scrape = scrape or _load_scrape()
        try:
            frame = scrape(**build_kwargs(args))
        except WorkerError:
            raise
        except Exception as exc:  # noqa: BLE001 - every JobSpy failure becomes one JSON error
            text = "%s: %s" % (type(exc).__name__, exc)
            kind = "blocked" if BLOCK_PATTERN.search(text) else "error"
            raise WorkerError(text, kind)
    finally:
        root.removeHandler(collector)
    if collector.blocks:
        raise WorkerError(collector.blocks[0], "blocked")
    rows = json.loads(frame.to_json(orient="records", date_format="iso"))
    if not rows and collector.errors:
        raise WorkerError(collector.errors[0], "error")
    return [{k: row.get(k) for k in JOB_FIELDS} for row in rows]


def is_detail_request(raw):
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return False
    return isinstance(data, dict) and data.get("mode") == "details"


def parse_detail_args(raw):
    try:
        data = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise WorkerError("arguments are not valid JSON: %s" % exc)
    if not isinstance(data, dict) or data.get("mode") != "details":
        raise WorkerError('detail arguments must be an object with "mode": "details"')
    if data.get("site") != "linkedin":
        raise WorkerError("details are only fetched for site linkedin")
    ids = data.get("job_ids")
    if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids):
        raise WorkerError("job_ids must be a non-empty list of strings")
    if len(ids) > MAX_DETAIL_IDS:
        raise WorkerError("job_ids must hold at most %d ids" % MAX_DETAIL_IDS)
    parsed = []
    for given in ids:
        match = JOB_ID_PATTERN.search(given.strip())
        if match is None:
            raise WorkerError("not a LinkedIn job id or job URL: %r" % given[:60])
        parsed.append((given, match.group(1) or match.group(2)))
    return parsed


def _load_linkedin():
    # Imported late (like _load_scrape). `_fetch_details` is JobSpy's private per-job call: there is no public one
    # (research t_8bf04d47), so a JobSpy bump that renames it must fail loudly here, not silently return nothing.
    try:
        from jobspy.linkedin import LinkedIn
        from jobspy.model import DescriptionFormat, ScraperInput, Site
    except ImportError as exc:
        raise WorkerError("JobSpy has no LinkedIn detail call any more: %s" % exc)
    if not callable(getattr(LinkedIn, "_fetch_details", None)):
        raise WorkerError("JobSpy has no LinkedIn detail call any more: LinkedIn._fetch_details is missing")
    scraper = LinkedIn()
    # `_fetch_details` reads scraper_input.description_format, which JobSpy only sets inside scrape().
    scraper.scraper_input = ScraperInput(
        site_type=[Site.LINKEDIN], description_format=DescriptionFormat.MARKDOWN
    )
    return scraper


def run_details(parsed_ids, scraper=None, sleep=time.sleep, emit=None):
    """Fetches one description per id, one GET each (JobSpy `_fetch_details`), DETAIL_GAP_SECONDS apart.

    Calls emit(line_dict) per id as it finishes. Raises WorkerError (kind "blocked") at the first block: the ids
    done before it were already emitted, the rest is not requested.
    """
    emit = emit or (lambda line: None)
    collector = _Collector(DETAIL_BLOCK_PATTERN)
    logger = logging.getLogger(LINKEDIN_LOGGER)
    root = logging.getLogger()
    old_level = logger.level
    logger.addHandler(collector)
    root.addHandler(collector)
    if logger.level == logging.NOTSET or logger.level > logging.WARNING:
        logger.setLevel(logging.WARNING)  # `verbose` is not passed in this mode: make sure the warnings are emitted
    try:
        scraper = scraper or _load_linkedin()
        for n, (given, job_id) in enumerate(parsed_ids):
            if n > 0:
                sleep(DETAIL_GAP_SECONDS)
            collector.blocks.clear()
            collector.errors.clear()
            try:
                details = scraper._fetch_details(job_id)
            except WorkerError:
                raise
            except Exception as exc:  # noqa: BLE001 - every JobSpy failure becomes one JSON line
                text = "%s: %s" % (type(exc).__name__, exc)
                if DETAIL_BLOCK_PATTERN.search(text):
                    raise WorkerError(text, "blocked")
                emit({"id": given, "error": text})
                continue
            if collector.blocks:
                raise WorkerError(collector.blocks[0], "blocked")
            description = details.get("description") if isinstance(details, dict) else None
            if isinstance(description, str) and description.strip():
                emit({"id": given, "description": description})
            else:
                emit({"id": given, "error": collector.errors[0] if collector.errors else "no description"})
    finally:
        logger.removeHandler(collector)
        root.removeHandler(collector)
        logger.setLevel(old_level)


def main(argv, stdin, stdout, scrape=None, scraper=None, sleep=time.sleep):
    try:
        raw = argv[1] if len(argv) > 1 else stdin.read()
        if is_detail_request(raw):
            run_details(
                parse_detail_args(raw),
                scraper,
                sleep,
                lambda line: stdout.write(json.dumps(line) + "\n"),
            )
            return 0
        jobs = run_search(parse_args(raw), scrape)
    except WorkerError as exc:
        stdout.write(json.dumps({"error": str(exc), "kind": exc.kind}) + "\n")
        return 2
    for job in jobs:
        stdout.write(json.dumps(job) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv, sys.stdin, sys.stdout))
