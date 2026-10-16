# Batch audit (card title "#12"): PASS

Audited commit: `origin/main` = `e2fd83ce6be1a51aa34f1f5a5b4b31d4a35cc0ff`. Diff `audit-11..origin/main` (139 files). Verdict **PASS**: no BLOCKER or MAJOR, 3 MINOR.

## Numbering note

The tag `audit-12` and `docs/audits/batch-12.md` already exist (task t_175eede7, "Re-audit #12", commit 3f02d01 plus its report commit 30c1dcd). This card repeats that number. It was created because the ledger still counts rows that audit already covered (see MINOR 3). What is new since `audit-12` is 18 commits (`git log audit-12..origin/main`): LinkedIn description backoff (2b0db3a, 7e14036), same-source variant dedupe (ccdc137), typed-answer validation (2f9cec0), salary detector (a7eb115), dry-run tables (c22a352), Phase 5 decisions (365d0e2), the dry-run harness (13866af), re-audit minors (23915ba), choice mapping (4608832), and `bin/agent-step` / `bin/step-git.sh` (f56b225). I audited the whole `audit-11..main` range at breadth and these at depth. `bin/agent-step`'s `record_audit` skips `audit-12` and `batch-12.md` (free_audit_number), so the report/tag should land as 13.

## Evidence

- `pnpm install --frozen-lockfile` ok. `pnpm check` exit 0: **Test Files 137 passed (137), Tests 2612 passed (2612)** (audit #12: 123 / 2406). Log: `data/handoff/t_e6383f77-check.log`. The `credit balance too low` and `jobspy worker failed` lines in it are logged by tests that fake those failures.
- Personal-data sweep over the added lines of `audit-11..main` (excluding lockfile and drizzle snapshots): email, `/Users/`, IPv4, owner name and domain, phone patterns. Only hits are `127.0.0.1` fixture host strings, a `t@example.invalid` git identity in `bin/test-agent-step.sh`, and the previous audit report's own description of its sweep. No personal data. I did not read `config/`, `data/` (except handoff), or `.env`.
- Guardrails: no LinkedIn login or cookies. The LinkedIn description fetch (`workers/jobspy/run.py` detail mode) calls JobSpy's own `LinkedIn._fetch_details`, so site access stays inside the JobSpy dependency. It is capped at 20 ids per call with a 10 s gap, treats a redirect away from `/jobs/view/` as a block and stops, and the loud failure on a JobSpy rename is deliberate. No custom LinkedIn scraping code, no CAPTCHA handling, no submit click anywhere.

## Deep dive 1: dry-run harness (t_e4ef741b, `packages/apply/src/dryrun/*`) - high risk, "never submits" guarantee

Read `request-guard.ts`, `page-guard.ts`, `browser.ts`, `session.ts` in full.

- Layers: context-level route aborts every non-GET/HEAD request that is not on the Ashby read-only allowlist; `routeWebSocket` closes every WebSocket before connect; in-page init script (every frame, before page scripts) locks `form.submit`, `requestSubmit`, `sendBeacon`, `WebSocket` and cancels `submit` events in the capture phase; service workers blocked; downloads off. The only context factory is `newGuardedContext` (no skip option). The page is an ES private field, so callers cannot click it. Fill helpers refuse submit-like elements (`closest(button, [role=button], [type=submit] ...)` or `submit` in id/name/data-qa) and only fill/select/check/upload. One run per process. A "filled" run in which the page tried to submit is recorded as `stopped/blocked_request`.
- Ashby allowlist: `operationName` must equal the `op` query parameter and be in the five confirmed read-only operations, the body must be JSON with a `query` string, and the query must not contain `mutation` or `submit` (case-insensitive). A body without `query` (persisted queries) is aborted. Conservative, correct.
- Break-the-code:
  - (a) `classifyRequest` allows every method (replace the GET/HEAD line with `return { allow: true }`): **caught**, 20 failed tests in `packages/apply/src/dryrun`.
  - (b) Ashby body check weakened (drop the `mutation`/`submit` regexes): **caught**, 3 failed tests in `request-guard.test.ts`.
  - Both reverted with `git checkout -- .`.
- No agent-reachable live mode: the `fixture` flag is an option of the session and nothing in this range exposes a CLI that sets it false (the owner-run CLI is a later Phase 5 card). Re-check that card.

## Deep dive 2: choice mapping (t_84aa4b70) and typed answers (2f9cec0)

- `choice-mapping.ts`: the pick is validated against the options of the stored form (not the request body), single-choice takes exactly one, duplicates rejected, a salary wording is refused, the answer must be approved, and nothing maps automatically; saving approves only the exact (answer, wording, option-set) triple. Consistent with the PLAN rule that the owner approves answers.
- `typed-answer.ts`: one rule set for import/POST/PATCH/approve/inbox; the number regex rejects hex, `Infinity` and thousands separators; the failure result never carries the value (no personal data in errors).

## Breadth notes (no finding)

- `dedupe/index.ts` same-source linking only links identical `content_hash` within one source and undoes links whose text positively diverged; `fits()` and the unknown-company "hashed, never merged" rule are unchanged. It rescans all hashed postings with a company on every `process` (O(n)); fine at the current size.
- New migrations 0005-0008 are additive, covered by migration tests (`description-migration.test.ts`, `dry-run-migration.test.ts`).
- `run-hourly` order (`process`, `fetch-descriptions`, `enrich`) matches the decision that no spend happens while a description is pending.

## Findings

1. **[MINOR] `packages/apply/src/dryrun/request-guard.ts:105`**: outside fixture mode every GET/HEAD to any host is allowed. A page script could therefore send a filled value in a GET query string (`fetch("https://x/?v=...")`). Form GET-submits are covered by the `submit` event guard; a script-initiated GET is not. This is accepted by design for a page that must load its own assets, and the real-site mode is owner-run, but the Phase 5 CLI card should decide explicitly (e.g. a host allowlist per ATS, or a query-string check once values are in the form) and add a test. Reproduce: `classifyRequest({method:"GET", url:"https://example.com/?v=secret", body:null}, {ats:"greenhouse", fixture:false})` returns `{allow:true}`.
2. **[MINOR] `bin/step-git.sh:10-25`**: `stash_foreign` runs `git stash push` in the main checkout, which AGENTS.md forbids for agents ("Nobody runs git stash in main"). It is automation protecting the owner's uncommitted work, so acceptable, but AGENTS.md should say so. `commit_docs` also commits **any** modified or new file under `docs/` (pm) or `docs/research/` (researcher) in main, including owner edits made there; the pre-commit hook is the only guard against personal data. Reproduce: read the two functions.
3. **[MINOR, process] `docs/audit-ledger.md`**: the ledger rewrite that audit #12 reported (empty table, `Last audited commit: 3f02d01`, counts 0/5 and 0/10) never reached main (`git log -- docs/audit-ledger.md` shows only per-task append commits, and the file still has "Last audit tag: (none yet)", stray `||` rows and `**Counts:**` lines in the middle of the table, 90+ rows). Consequence: the batch threshold fires on every append and this duplicate audit card was created. The auditor's worktree edit is not committed by `record_audit` (it adds only `docs/audits`).

## Fix tasks

1. **Reset the audit ledger (low, PM/QA).** Replace `docs/audit-ledger.md` with the proper header, `Last audited commit:` the commit this audit covers (`e2fd83c`), counts 0/5 and 0/10 and an empty table. Make `record_audit` (or the QA merge step) clear the covered rows on a PASS so the ledger does not depend on an agent edit in a detached worktree.
2. **Live-mode GET policy for the dry-run CLI (high, attach to the Phase 5 owner-run CLI card).** Decide and test what a non-fixture dry run may GET (per-ATS host allowlist or query-string rule); MINOR 1 above.
3. **AGENTS.md wording (low).** One line that `bin/agent-step` may stash and commit docs in main on the owner's behalf (MINOR 2).

## Tasks covered

All 19 listed by the card (t_e8dd3801, t_aaa0bf00, t_c08e4542, t_4f984ef5, t_0ee7b06b, t_b032ee04, t_44ce9ef4, t_c1b1a380, t_064ff6b5, t_e14e2597, t_70b5308f, t_38874a17, t_dcde0fbd, t_c5f69e5a, t_918664ed, t_a9f809f5, t_e4ef741b, t_ab72b1a1, t_84aa4b70) are inside `audit-11..origin/main`. Deep dive on the dry-run harness (highest risk: a bug there could submit a real application) and on choice mapping plus typed answers (acts on the owner's answers).
