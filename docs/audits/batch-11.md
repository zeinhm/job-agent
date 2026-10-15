# Batch audit #11 (audit-10..main @ a392311)

Tasks: t_da6ce498 (answer bank tab), t_8140d1bc (question matching), t_bb962b1b (inbox), t_3b914bae (phase-4 e2e + smoke), t_c5832945 (run docs), t_af1e9656 (tests never start real JobSpy worker), t_22582616 (seed-demo hardening, redirect-free question fetch). Also docs/PM commits and the phase-4 audit report.

## Setup
- `pnpm install --frozen-lockfile` ok; `pnpm exec tsc -b` clean; `pnpm lint` (eslint + prettier) "No issues found"
- `pnpm test`: 116 files, 2172 tests passed. Expected error log lines in the output come from tests of failing adapters.

## Checked
- Personal data / secrets: diff touches only the fake persona (answers.example.yaml, demo fixtures); no real contact data found in the changed files.
- Guardrails: dashboard binds 127.0.0.1 only (fixed), hostGuard (DNS rebinding) and mutationGuard (JSON content type + same-origin) cover all new POST/PATCH routes. Export writes to data/exports, never config/. No LinkedIn code, no submit, no new live HTTP.
- Salary rule: `matchQuestion` checks the salary regex before standard fields and the bank; the inbox refuses answer/link on a pay wording (`InboxError invalid ["salary"]`).
- Break-the-code: removed the SALARY check in match.ts -> 12 tests failed (match.test, match-questions.test). Reverted. The salary guard is well tested.
- Redirect refusal in fetch-questions (`followRedirects:false`, http.ts honours it with `redirect: "manual"`; 3xx becomes a failed fetch). Consistent with the ATS-host rule.
- seed-demo: realpath resolution of the DB path, dangling-symlink handling, refusal on a DB with non-demo postings. Logic reads correctly; tests added.
- Unapproved answers are excluded from the match index; editing answer text clears approval.

## Findings
- [MINOR] packages/apply/src/answers-store.ts (createAnswer, updateAnswer): the type-vs-answer check (`checkTyped`: yes_no must be yes/no, number numeric, choice must be in choices) runs only in the inbox answer path. `POST /api/answers` and `PATCH /api/answers/:key` only check type/choices consistency, so e.g. a yes_no answer "banana", or a choice answer outside `choices`, can be stored and approved. Reproduce: PATCH `{answer:"banana", type:"yes_no", approved:true}`. Impact is low (owner-only, localhost, dry-run applying until Phase 6), but the same validation should be shared before apply fills forms.
- [MINOR] answers-store.ts updateAnswer: editing `question` or `alternatives` of an already approved answer keeps `approved=true`, so a newly added wording starts matching without re-approval. Only a change of the answer text resets approval. Consider resetting approval on wording changes too (or document it as intended).
- [MINOR] inbox.ts answerInbox/linkInbox: createAnswer/updateAnswer, `decide` and `matchQuestions` are separate transactions; a crash between them leaves an answer created with the inbox row still open. Self-heals on the next re-match for covered wordings, so low impact.
- [MINOR] match.ts SALARY regex is keyword based ("how much do you expect to be paid?" is not caught). Only matters if the owner adds such a wording to a bank entry; worth extending the pattern list before Phase 6.

No BLOCKER or MAJOR findings.

## Deep dive
t_8140d1bc/t_bb962b1b (matching and inbox) because they decide which questions may be auto-answered; re-read match.ts, match-questions.ts, inbox.ts in full and did the salary break-the-code check. t_22582616 was read for symlink/guard logic.

## Fix tasks
(Optional, all MINOR; fix tasks are high risk)
1. Share typed-answer validation (yes_no / number / choice membership) across createAnswer, updateAnswer and the inbox; add tests for PATCH/POST with an invalid typed answer.
2. Decide and test whether editing `question`/`alternatives` of an approved answer clears approval.
3. Widen the SALARY patterns ("expect to be paid", "pay expectation" variants) with golden-table tests.

## Verdict
PASS. Tag audit-11 should go on a392311 (not done by me).
