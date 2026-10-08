# Phase 1: remaining tasks

---
Task t_55542219: Implement daily digest (markdown file)

**Title:** Implement daily digest (markdown file)
**Assignee:** dev
**Risk:** medium
**Depends on:** t_bc27b1df (process command merged)

**Context**
- PLAN.md section(s): 8 Phase 1 done-when ("A daily list of real, remote-eligible postings"), 7 Pipeline and schedule (Digest daily), 9 To prepare (digest channel is an open decision)
- Research doc(s): none
- Related decisions: 2026-10-06 public repo: generated outputs live under gitignored data/
- Conventions: docs/phase-1-conventions.md ("Digest", CLI) — binding

**Goal**
`pnpm job-agent digest` writes today's list of kept postings plus source health to `data/digests/YYYY-MM-DD.md`.

**Decisions you must follow**
- Code in `packages/pipeline/src/digest/`; CLI command `digest` (flag `--date YYYY-MM-DD`, default today in Asia/Jakarta).
- Selection: canonical postings with `analysis.decision = 'keep'` and `digested_at IS NULL` are stamped with the digest date; the file lists every posting stamped with that date. Re-running for the same date regenerates the same file plus any newly stamped postings.
- File layout:
  1. Header: date, counts (kept today, flagged, rejected in the last 24h by reason).
  2. **Matches**: kept postings without flags; then **Needs a look**: kept postings with flags. Each sorted by `posted_at` desc (nulls last).
  3. Per posting: `### <title> — <company>`; location class + location text; salary as `IDR 25.0M–30.0M / month` (one decimal, M = million) or `salary unknown` / `salary not parsed` / `no FX rate`; flags; link = `apply_url` if the canonical is an ATS source, else `url`; `Sources:` canonical source plus duplicate sources; posted date.
  4. **Source health**: per source, its latest `source_runs` row in the last 24h (status, found, new, error message); sources with no `ok` run in 24h marked `NO SUCCESSFUL RUN`.
- Output only under `data/digests/` (gitignored); create the folder if missing. Print the file path.
- No salary floor/ask values, CV or answer content in the file.

**Acceptance criteria**
- [ ] Seeded DB (3 kept unflagged, 2 kept flagged, 2 rejected, 1 duplicate) -> file with 3 Matches, 2 Needs a look, correct ordering, duplicate shown only as an extra source on its canonical.
- [ ] Salary formatting tests: 25,000,000-30,000,000 -> `IDR 25.0M–30.0M / month`; min only -> `from IDR 25.0M / month`; max only -> `up to IDR 30.0M / month`.
- [ ] Running twice for the same date produces identical files; a posting kept after the first run appears on the second run and is stamped with the same date.
- [ ] A posting stamped yesterday does not appear today.
- [ ] Source health lists a source whose last run errored, with its message, and marks a source with no ok run in 24h.
- [ ] Empty day -> file still written with "No new matches" and the source health section.
- [ ] Tests use a temp dir, never the real `data/`.
- [ ] Tests cover the above; full suite passes.

**Out of scope**
- Sending the digest anywhere (Telegram/email — open human decision), instant alerts, ranking/scoring (Phase 2), dashboard.

**Evidence required**
A full digest generated from the seeded test DB (fake data only) pasted in the evidence comment.

---
Task t_5777d0f2: Add end-to-end fixture test for the Phase 1 pipeline

**Title:** Add end-to-end fixture test for the Phase 1 pipeline
**Assignee:** dev
**Risk:** medium
**Depends on:** t_e073141b (digest merged) and all adapter QA cards: t_b91e0080, t_cb51b7ef, t_1215344b, t_219450c4, t_81b5da2d, t_f64ed11b, t_1a01099f, t_1acae87e, t_b86f7f6e

**Context**
- PLAN.md section(s): 8 Phase 1 (Tier 1 sources, normalize, dedupe, rule filters, SQLite, daily digest)
- Research doc(s): none
- Related decisions: none
- Conventions: docs/phase-1-conventions.md ("Tests and fixtures") — binding

**Goal**
One test proves discover -> process -> digest works across all nine adapters, offline, so later changes can't silently break the chain.

**Decisions you must follow**
- Test in `packages/pipeline/test/e2e.test.ts`. msw serves the existing adapter fixtures; FX from a fixture; config = the example config files plus an inline companies list covering one greenhouse, one lever and one ashby company that have fixtures.
- Extra fixtures for this test only in `packages/pipeline/test/fixtures/e2e/`: copy real items and add ONE injected cross-source duplicate (same company + title on Remotive and Greenhouse), clearly named `injected-duplicate-*`. Do not modify the adapters' own fixtures.
- The test calls the same functions the CLI commands use (`discover` with force, `process`, `digest`) on a temp file DB and temp digest dir.
- `web3career` runs with a fake env token set inside the test.

**Acceptance criteria**
- [ ] After the run, `source_runs` has one `ok` row per adapter (9).
- [ ] Every analysis row with decision `keep` has location class other than `restricted` and Indonesia value other than `domestic`.
- [ ] The injected duplicate appears once in the digest, linked to the Greenhouse URL, with both sources listed.
- [ ] The digest file exists, has a Matches or Needs a look section, and a Source health section listing all 9 sources.
- [ ] Making any one adapter's fixture return HTTP 500 -> that source shows `error` in `source_runs` and in Source health, the other 8 still produce postings (second test case).
- [ ] Test runs offline (msw `onUnhandledRequest: "error"`) in under 30 s.
- [ ] Tests cover the above; full suite passes.

**Out of scope**
- Live network runs (that is the phase-end audit), new adapter behaviour, fixing bugs found in other modules (report them as a comment for the PM instead).

**Evidence required**
Test output and the generated digest from the e2e run (fixture data only).

Events (7):
  [2026-10-06 22:46] created {'assignee': 'dev', 'status': 'todo', 'parents': ['t_e073141b', 't_b91e0080', 't_cb51b7ef', 't_1215344b', 't_219450c4', 't_81b5da2d', 't_f64ed11b', 't_1a01099f', 't_1acae87e', 't_b86f7f6e'], 'creator_task_id': 't_338f17d2', 'tenant': None, 'workspace_kind': 'dir', 'workspace_path': '/Users/zein/projects/job-agent', 'branch_name': None, 'project_id': None, 'skills': None, 'goal_mode': None, 'model_override': None, 'provider_override': None}
  [2026-10-06 22:46] dependency_wait {'reason': 'parent_not_done', 'parent': 't_e073141b'}
  [2026-10-07 08:55] linked {'parent': 't_49e9c059', 'child': 't_5777d0f2'}
  [2026-10-07 08:55] linked {'parent': 't_60521b3c', 'child': 't_5777d0f2'}
  [2026-10-07 17:04] unlinked {'parent': 't_219450c4', 'child': 't_5777d0f2'}
  [2026-10-07 17:04] unlinked {'parent': 't_f64ed11b', 'child': 't_5777d0f2'}
---
Task t_383cf304: Add cron schedule example and Phase 1 run docs

**Title:** Add cron schedule example and Phase 1 run docs
**Assignee:** dev
**Risk:** low
**Depends on:** t_3a40cd7e (e2e test merged)

**Context**
- PLAN.md section(s): 7 Stack ("node-cron or system cron"), 7 Pipeline and schedule (Discover Tier 1 every 1-2 hours; digest daily)
- Research doc(s): none
- Related decisions: none
- Conventions: docs/phase-1-conventions.md (CLI commands `discover`, `fx`, `process`, `digest`) — binding

**Goal**
The owner can run Phase 1 daily on their Mac by following one doc and installing one crontab.

**Decisions you must follow**
- System cron, no daemon and no node-cron dependency.
- `scripts/crontab.example` (committed) with absolute-path placeholders: `fx` daily 07:00 Asia/Jakarta; `discover` then `process` every 2 hours; `digest` daily 08:00 Asia/Jakarta (after a `discover && process`). Output appended to `data/logs/<command>.log`. Comment at the top explaining that per-source intervals are enforced in code, so cron frequency can't exceed source limits.
- `docs/running.md`: prerequisites (Node LTS, pnpm), install, which `config/` files must exist (point at the example files, never real values), env vars (`JOB_AGENT_DB`, `WEB3_CAREER_TOKEN` name only), each CLI command with what it does, how to install the crontab, where digests and logs land, how to read Source health, how to reset the DB.
- README.md: add one line linking to `docs/running.md`.

**Acceptance criteria**
- [ ] Following `docs/running.md` on a fresh clone with the example config copied to real names: `pnpm install`, `pnpm job-agent fx`, `pnpm job-agent discover --source remotive`, `pnpm job-agent process`, `pnpm job-agent digest` all run and produce a digest file (paste the commands and trimmed output; one live run, intervals respected).
- [ ] `scripts/crontab.example` passes a syntax check (e.g. a crontab linter or `crontab -T` where available, or show each line parsed) and uses only the documented commands.
- [ ] Docs contain no real personal data, tokens, or salary numbers (grep for the example persona only).
- [ ] Full suite passes.

**Out of scope**
- Installing the crontab on the owner's machine, digest delivery channel, launchd plist.

**Evidence required**
Output of the fresh-clone run above.

Events (2):
  [2026-10-06 22:46] created {'assignee': 'dev', 'status': 'todo', 'parents': ['t_3a40cd7e'], 'creator_task_id': 't_338f17d2', 'tenant': None, 'workspace_kind': 'dir', 'workspace_path': '/Users/zein/projects/job-agent', 'branch_name': None, 'project_id': None, 'skills': None, 'goal_mode': None, 'model_override': None, 'provider_override': None}
