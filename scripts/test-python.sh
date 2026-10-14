#!/usr/bin/env bash
# Runs the JobSpy worker unit tests (JobSpy mocked, no network). Skipped with a printed reason when python3 is missing.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v python3 >/dev/null 2>&1; then
  echo "python tests skipped: python3 not found"
  exit 0
fi
python3 -m unittest discover -s workers/jobspy -p 'test_run.py'
