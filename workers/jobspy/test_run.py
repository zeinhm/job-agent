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


if __name__ == "__main__":
    unittest.main()
