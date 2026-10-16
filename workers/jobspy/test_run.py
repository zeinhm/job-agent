import io
import json
import logging
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import run  # noqa: E402


class FakeFrame:
    def __init__(self, rows):
        self.rows = rows

    def to_json(self, orient="records", date_format="iso"):
        assert orient == "records" and date_format == "iso"
        return json.dumps(self.rows)


def call(args, scrape):
    out = io.StringIO()
    code = run.main(["run.py", json.dumps(args)], io.StringIO(""), out, scrape)
    return code, [json.loads(line) for line in out.getvalue().splitlines()]


LINKEDIN = {
    "site": "linkedin",
    "search_term": "react remote",
    "location": "Worldwide",
    "hours_old": 1,
    "results_wanted": 25,
}


class ParseArgsTest(unittest.TestCase):
    def test_valid_arguments(self):
        args = run.parse_args(json.dumps(LINKEDIN))
        self.assertEqual(args["site"], "linkedin")
        self.assertEqual(args["hours_old"], 1)

    def test_rejects_bad_input(self):
        for bad in (
            "not json",
            "[]",
            json.dumps({**LINKEDIN, "site": "glassdoor"}),
            json.dumps({**LINKEDIN, "search_term": " "}),
            json.dumps({**LINKEDIN, "results_wanted": 26}),
            json.dumps({**LINKEDIN, "hours_old": 0}),
            json.dumps({**LINKEDIN, "hours_old": 25}),
            json.dumps({**LINKEDIN, "is_remote": "yes"}),
        ):
            with self.assertRaises(run.WorkerError, msg=bad):
                run.parse_args(bad)

    def test_offset_rules(self):
        self.assertEqual(run.parse_args(json.dumps(LINKEDIN))["offset"], 0)
        self.assertEqual(run.parse_args(json.dumps({**LINKEDIN, "offset": 75}))["offset"], 75)
        for bad in (80, -1, True, "25", 1.5):
            with self.assertRaises(run.WorkerError, msg=repr(bad)):
                run.parse_args(json.dumps({**LINKEDIN, "offset": bad}))
        indeed = {"site": "indeed", "search_term": "react", "results_wanted": 50}
        self.assertEqual(run.parse_args(json.dumps({**indeed, "offset": 50}))["offset"], 50)
        with self.assertRaises(run.WorkerError):
            run.parse_args(json.dumps({**indeed, "offset": 51}))

    def test_offset_is_passed_to_scrape_jobs(self):
        seen = []

        def scrape(**kwargs):
            seen.append(kwargs)
            return FakeFrame([])

        self.assertEqual(call({**LINKEDIN, "offset": 75}, scrape)[0], 0)
        self.assertEqual(call(LINKEDIN, scrape)[0], 0)
        self.assertEqual(seen[0]["offset"], 75)
        self.assertNotIn("offset", seen[1])

    def test_hours_old_upper_bound(self):
        self.assertEqual(run.parse_args(json.dumps({**LINKEDIN, "hours_old": 24}))["hours_old"], 24)
        with self.assertRaises(run.WorkerError):
            run.parse_args(json.dumps({**LINKEDIN, "hours_old": 25}))

    def test_linkedin_gets_no_remote_or_country_argument(self):
        kwargs = run.build_kwargs(
            run.parse_args(json.dumps({**LINKEDIN, "is_remote": True, "country": "usa"}))
        )
        self.assertEqual(kwargs["site_name"], ["linkedin"])
        self.assertEqual(kwargs["hours_old"], 1)
        self.assertEqual(kwargs["results_wanted"], 25)
        self.assertNotIn("is_remote", kwargs)
        self.assertNotIn("country_indeed", kwargs)
        for forbidden in ("proxies", "user_agent", "linkedin_fetch_description"):
            self.assertNotIn(forbidden, kwargs)


class MainTest(unittest.TestCase):
    def test_prints_one_json_object_per_job(self):
        seen = {}

        def scrape(**kwargs):
            seen.update(kwargs)
            return FakeFrame(
                [
                    {"id": "li-1", "site": "linkedin", "title": "A", "emails": ["x@example.com"], "extra": 1},
                    {"id": "li-2", "site": "linkedin", "title": "B"},
                ]
            )

        code, lines = call(LINKEDIN, scrape)
        self.assertEqual(code, 0)
        self.assertEqual([j["id"] for j in lines], ["li-1", "li-2"])
        self.assertNotIn("emails", lines[0])
        self.assertNotIn("extra", lines[0])
        self.assertEqual(seen["search_term"], "react remote")
        self.assertEqual(seen["location"], "Worldwide")

    def test_no_jobs_and_no_error_is_success_with_no_lines(self):
        code, lines = call(LINKEDIN, lambda **kw: FakeFrame([]))
        self.assertEqual((code, lines), (0, []))

    def test_block_logged_by_jobspy_exits_2_even_with_rows(self):
        def scrape(**kwargs):
            logging.getLogger("JobSpy:LinkedIn").error("response status code 429")
            return FakeFrame([{"id": "li-1"}])

        code, lines = call(LINKEDIN, scrape)
        self.assertEqual(code, 2)
        self.assertEqual(lines, [{"error": "response status code 429", "kind": "blocked"}])

    def test_bare_numbers_are_not_a_block(self):
        for text in ("Found 429 jobs", "job id 4031999", "fetched 403 results"):
            self.assertIsNone(run.BLOCK_PATTERN.search(text), text)

            def scrape(**kwargs):
                logging.getLogger("JobSpy:LinkedIn").error(text)
                return FakeFrame([])

            code, lines = call(LINKEDIN, scrape)
            self.assertEqual((code, lines), (2, [{"error": text, "kind": "error"}]))

    def test_block_wording_is_a_block(self):
        for text in (
            "status code 429",
            "HTTP 999",
            "403 Forbidden while fetching, status unknown",
            "LinkedIn response status code 429",
            "Indeed response status code 403",
            "429 Too Many Requests",
            "LinkedIn: unexpected page with no jobs (blocked?)",
            "authwall",
            "captcha",
            "too many requests",
        ):
            self.assertTrue(run.BLOCK_PATTERN.search(text), text)

    def test_empty_result_with_error_log_is_error(self):
        def scrape(**kwargs):
            logging.getLogger("JobSpy").error("something broke")
            return FakeFrame([])

        code, lines = call(LINKEDIN, scrape)
        self.assertEqual((code, lines), (2, [{"error": "something broke", "kind": "error"}]))

    def test_exception_exits_2(self):
        def scrape(**kwargs):
            raise ValueError("response status code 999")

        code, lines = call(LINKEDIN, scrape)
        self.assertEqual(code, 2)
        self.assertEqual(lines[0]["kind"], "blocked")

    def test_bad_arguments_exit_2_without_calling_jobspy(self):
        def scrape(**kwargs):
            raise AssertionError("must not be called")

        code, lines = call({**LINKEDIN, "results_wanted": 500}, scrape)
        self.assertEqual(code, 2)
        self.assertEqual(lines[0]["kind"], "error")

    def test_reads_stdin_without_argv_argument(self):
        out = io.StringIO()
        code = run.main(["run.py"], io.StringIO(json.dumps(LINKEDIN)), out, lambda **kw: FakeFrame([]))
        self.assertEqual(code, 0)


class FakeLinkedIn:
    """Stands in for jobspy.linkedin.LinkedIn: `_fetch_details(job_id)` returns a dict, `{}` when it failed."""

    def __init__(self, responses, log_on=None):
        self.responses = responses
        self.log_on = log_on or {}
        self.calls = []

    def _fetch_details(self, job_id):
        self.calls.append(job_id)
        if job_id in self.log_on:
            logging.getLogger("JobSpy:LinkedIn").warning(self.log_on[job_id])
        outcome = self.responses[job_id]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def details(ids, scraper, sleeps=None):
    out = io.StringIO()
    arg = json.dumps({"mode": "details", "site": "linkedin", "job_ids": ids})
    code = run.main(
        ["run.py", arg],
        io.StringIO(""),
        out,
        scrape=lambda **kw: (_ for _ in ()).throw(AssertionError("search must not run")),
        scraper=scraper,
        sleep=(sleeps.append if sleeps is not None else lambda s: None),
    )
    return code, [json.loads(line) for line in out.getvalue().splitlines()]


class DetailModeTest(unittest.TestCase):
    def test_returns_a_description_per_id_and_a_failure_per_empty_page(self):
        scraper = FakeLinkedIn({"1001": {"description": "Fake text A"}, "1002": {}, "1003": {"description": "  "}})
        code, lines = details(["li-1001", "li-1002", "li-1003"], scraper)
        self.assertEqual(code, 0)
        self.assertEqual(
            lines,
            [
                {"id": "li-1001", "description": "Fake text A"},
                {"id": "li-1002", "error": "no description"},
                {"id": "li-1003", "error": "no description"},
            ],
        )
        self.assertEqual(scraper.calls, ["1001", "1002", "1003"])

    def test_accepts_ids_and_job_urls(self):
        scraper = FakeLinkedIn({"123456": {"description": "x"}, "777777": {"description": "y"}})
        code, lines = details(
            ["https://www.linkedin.com/jobs/view/senior-dev-at-fake-co-123456?ref=x", "li-777777"], scraper
        )
        self.assertEqual(code, 0)
        self.assertEqual(scraper.calls, ["123456", "777777"])
        self.assertEqual(lines[0]["id"], "https://www.linkedin.com/jobs/view/senior-dev-at-fake-co-123456?ref=x")

    def test_waits_the_gap_between_ids_but_not_before_the_first(self):
        scraper = FakeLinkedIn({"1001": {"description": "a"}, "1002": {"description": "b"}, "1003": {"description": "c"}})
        sleeps = []
        details(["li-1001", "li-1002", "li-1003"], scraper, sleeps)
        self.assertEqual(sleeps, [run.DETAIL_GAP_SECONDS, run.DETAIL_GAP_SECONDS])
        self.assertGreaterEqual(run.DETAIL_GAP_SECONDS, 10)

    def test_block_in_the_log_exits_2_with_blocked_and_stops_requesting(self):
        scraper = FakeLinkedIn(
            {"1001": {"description": "kept"}, "1002": {}, "1003": {"description": "never asked"}},
            log_on={"1002": "LinkedIn response status code 429 for job 1002"},
        )
        code, lines = details(["li-1001", "li-1002", "li-1003"], scraper)
        self.assertEqual(code, 2)
        self.assertEqual(lines[0], {"id": "li-1001", "description": "kept"})
        self.assertEqual(lines[1]["kind"], "blocked")
        self.assertEqual(len(lines), 2)
        self.assertEqual(scraper.calls, ["1001", "1002"])

    def test_redirect_away_from_the_job_page_is_a_block(self):
        scraper = FakeLinkedIn({"1001": {}}, log_on={"1001": "LinkedIn: job 1001: redirected to /authwall"})
        code, lines = details(["li-1001"], scraper)
        self.assertEqual((code, lines[0]["kind"]), (2, "blocked"))
        scraper = FakeLinkedIn({"1001": {}}, log_on={"1001": "LinkedIn: job 1001: redirected to /checkpoint/challenge"})
        self.assertEqual(details(["li-1001"], scraper)[0], 2)

    def test_other_status_codes_are_a_per_id_failure_not_a_block(self):
        scraper = FakeLinkedIn({"1001": {}}, log_on={"1001": "LinkedIn response status code 404 for job 1001"})
        code, lines = details(["li-1001"], scraper)
        self.assertEqual((code, lines), (0, [{"id": "li-1001", "error": "no description"}]))

    def test_exception_with_block_wording_is_a_block_other_exceptions_are_per_id(self):
        scraper = FakeLinkedIn({"1001": ValueError("response status code 999"), "1002": RuntimeError("boom")})
        code, lines = details(["li-1001"], scraper)
        self.assertEqual((code, lines[0]["kind"]), (2, "blocked"))
        code, lines = details(["li-1002"], scraper)
        self.assertEqual(code, 0)
        self.assertEqual(lines[0]["id"], "li-1002")
        self.assertIn("RuntimeError", lines[0]["error"])

    def test_bad_arguments_exit_2_without_a_request(self):
        scraper = FakeLinkedIn({})
        for bad in (
            {"mode": "details", "site": "indeed", "job_ids": ["li-1001"]},
            {"mode": "details", "site": "linkedin", "job_ids": []},
            {"mode": "details", "site": "linkedin", "job_ids": "li-1001"},
            {"mode": "details", "site": "linkedin", "job_ids": ["not an id"]},
            {"mode": "details", "site": "linkedin", "job_ids": ["li-%d" % (1000 + n) for n in range(21)]},
        ):
            out = io.StringIO()
            code = run.main(["run.py", json.dumps(bad)], io.StringIO(""), out, scraper=scraper, sleep=lambda s: None)
            self.assertEqual(code, 2, bad)
            self.assertEqual(json.loads(out.getvalue())["kind"], "error")
        self.assertEqual(scraper.calls, [])

    def test_missing_jobspy_detail_call_fails_loudly(self):
        class NoDetails:
            pass

        original = run._load_linkedin
        try:
            run._load_linkedin = lambda: (_ for _ in ()).throw(run.WorkerError("JobSpy has no LinkedIn detail call any more"))
            code, lines = details(["li-1001"], None)
        finally:
            run._load_linkedin = original
        self.assertEqual(code, 2)
        self.assertIn("no LinkedIn detail call", lines[0]["error"])
        self.assertEqual(lines[0]["kind"], "error")

    def test_the_search_path_is_unchanged_without_the_details_mode(self):
        code, lines = call(LINKEDIN, lambda **kw: FakeFrame([{"id": "li-1"}]))
        self.assertEqual((code, [j["id"] for j in lines]), (0, ["li-1"]))


if __name__ == "__main__":
    unittest.main()
