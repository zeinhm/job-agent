"""JobSpy worker: one search in, JSON lines out.

Reads ONE JSON object of arguments from argv[1] (or stdin when no argument is given):
  site ("linkedin" | "indeed"), search_term, location, is_remote, hours_old, results_wanted, country

Prints one JSON object per job on stdout. On a block or any failure prints one JSON object
{"error": "<reason>", "kind": "blocked" | "error"} and exits 2.

No database, no files, no cookies, no proxies, no user-agent rotation: all site access is inside JobSpy.
"""

import json
import logging
import re
import sys

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
BLOCK_PATTERN = re.compile(r"\b(429|999|403)\b|blocked\?|authwall|captcha|too many requests", re.IGNORECASE)


class WorkerError(Exception):
    def __init__(self, message, kind="error"):
        super().__init__(message)
        self.kind = kind


class _Collector(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.WARNING)
        self.errors = []
        self.blocks = []

    def emit(self, record):
        msg = record.getMessage()
        if BLOCK_PATTERN.search(msg):
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
    if hours_old is not None and (not isinstance(hours_old, int) or isinstance(hours_old, bool) or hours_old < 1):
        raise WorkerError("hours_old must be a positive integer")
    wanted = data.get("results_wanted", 10)
    if not isinstance(wanted, int) or isinstance(wanted, bool) or wanted < 1 or wanted > SITES[site]:
        raise WorkerError("results_wanted must be an integer from 1 to %d for %s" % (SITES[site], site))
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


def main(argv, stdin, stdout, scrape=None):
    try:
        raw = argv[1] if len(argv) > 1 else stdin.read()
        jobs = run_search(parse_args(raw), scrape)
    except WorkerError as exc:
        stdout.write(json.dumps({"error": str(exc), "kind": exc.kind}) + "\n")
        return 2
    for job in jobs:
        stdout.write(json.dumps(job) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv, sys.stdin, sys.stdout))
