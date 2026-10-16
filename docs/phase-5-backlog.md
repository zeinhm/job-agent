# Phase 5 backlog: Assisted applying (dry-run)

Planned 2026-10-16 by the PM (card t_72408550) from PLAN 8 Phase 5, the Phase 4 report ("Recommendations for Phase 5" 2-7,
"Fix round" -> "Still open"), `docs/pre-phase-5-report.md` and the owner's binding notes on t_72408550.
Gate: **t_2c20b3fa** "Phase 5: owner approves the plan" (owner). Every card without another parent hangs off the gate.

**Scope:** PLAN 8 Phase 5 **without** the JobStreet / YC semi-automated part (dropped by the owner). Greenhouse, then Lever, then
Ashby fillers in dry-run: fill, screenshot, never submit; CAPTCHA and anything uncovered -> stop.
**Done when:** 20-30 owner-run dry runs are reviewed and marked correct in the dashboard (rule in "Decisions" 9).

## Cards

| Id | Dev / research | QA | Audit | Risk | Prio | Title | Parents |
|---|---|---|---|---|---|---|---|
| L1 | t_70b5308f | t_b1ce9af8 | t_eb71ae30 | high | 10 | LinkedIn descriptions: count failures per job; one job that keeps failing is skipped and never starts the backoff | gate |
| A5 | t_38874a17 | t_c24266c4 | t_c21b1585 | high | 9 | bin/agent-step: commit PM/researcher doc edits instead of stashing them; never move an audit tag | gate |
| P1 | t_dcde0fbd | t_d0180ffe | t_efd0523a | high | 9 | Answer bank: one typed-answer validation on every write path | gate |
| P2 | t_c5f69e5a | t_a65bc420 | t_b385be63 | high | 9 | Salary detector: catch the re-audit #11 M2 wordings | gate |
| C1 | t_ab72b1a1 | t_af00a4db | - | low | 6 | Re-audit #12 minors: dead two-letter DOMAIN_TLDS entries; text answer shown once | gate |
| DC | t_a9f809f5 | t_38a0384f | - | low | 7 | Record the Phase 5 plan decisions in docs/decisions.md | gate |
| R1 | t_ec2ae4c6 (researcher) | - | - | low | 8 | Research: do Greenhouse, Lever, Ashby, Workable and Recruitee terms allow automated submission, and which bot checks exist | gate |
| R2 | t_d0698332 (researcher) | - | - | low | 8 | Research: apply form structure of Greenhouse, Lever and Ashby for a dry-run filler and its fixtures | gate |
| D1 | t_918664ed | t_275d5920 | - | medium | 8 | Dry-run tables: dry_runs, dry_run_fields, choice_mappings (migration) + store | L1 audit (migration order) |
| D4 | t_84aa4b70 | t_925ffae1 | - | medium | 7 | Choice mapping: show a form's options, owner maps them to an approved answer once | D1 QA, P1 audit, C1 QA |
| D3 | t_f083066c | t_f4f2dacb | t_fabe0c14 | high | 7 | Fill plan in plain code -> values or a stop reason | D4 QA, P2 audit |
| D2 | t_e4ef741b | t_c04cc9cb | t_b316552e | high | 7 | Dry-run harness: Playwright session that can never submit | R2, D1 QA |
| D5 | t_5ffb85b7 | t_68a1ad3b | t_3361aa6e | high | 7 | Greenhouse dry-run filler and the `dry-run <posting-id>` command | D2 audit, D3 audit, R1 |
| D6 | t_4fbf1521 | t_c203b466 | - | medium | 6 | Dashboard "Dry runs" tab, review, done-when line | D1 QA, D4 QA |
| D7 | t_9e9cfe1e | t_f801b8c9 | t_8c49fd0f | high | 6 | Lever dry-run filler | D5 audit |
| D8 | t_3b60e4e8 | t_43f8d421 | t_d0d1123d | high | 6 | Ashby dry-run filler (read-only GraphQL allowlist) | D7 audit |
| D9 | t_772e5705 | t_8fcf3732 | - | medium | 6 | Phase 5 end-to-end test and docs | D8 audit, D6 QA |

Then:
- t_2a8ba526 **Phase-end audit #13: Phase 5** (auditor). Parents: every final QA / audit card above, R1 and R2. Reviews
  `git diff audit-12..main` and everything in the ledger. Numbered 13 because `audit-1..12` exist; with A5 merged, an existing
  number is never reused anyway.
- t_552a5d42 Phase 5 report (pm): `docs/phase-5-report.md`.
- t_7a87ffba Phase 5: owner review (owner).

Ledger: the medium / low cards (D1, D4, D6, D9, C1, DC) are 4 medium + 2 low, below both batch thresholds, so no batch audit
should start during the phase; the phase-end audit covers them.

Card bodies: `data/handoff/p5/` (gitignored). Every dev / QA / audit body ends with the same rules block (`common.md`): nothing
submits, fixture forms only for agents, `bin/smoke` only, no `config/` / `data/`, dry-run output private, no LLM, and the
backup line for migrations.

## Owner notes and where they go

| Owner note (t_72408550) | Where |
|---|---|
| Greenhouse, then Lever, then Ashby, dry-run only | D5 -> D7 -> D8, each audited before the next |
| Done when 20-30 owner-run dry runs reviewed and marked correct | D6 (tab + line), D9, Decision 9 |
| Rec 2: no-submit in code, request interception, failing test | D2 (high, audited), re-checked in D5/D7/D8 and the phase-end audit |
| Rec 3: fixture forms only for agents | every card's rules block; D2 fixture mode aborts non-127.0.0.1 hosts; `--fixture` in D5/D7/D8 |
| Rec 4: data/dryruns private | D2 output modes, D6 path guard |
| Rec 5: salary from the tier ask; stop on anything uncovered | D3 |
| Rec 6: no LLM drafting | rules block; D3 out of scope |
| Rec 7: worktree-safe Playwright, owner runs real forms | D2 (browser install documented, data dir from the DB), D5 CLI |
| Choice / dropdown: show options, owner maps once | D4 (store from D1), used by D3 |
| Research card: ATS terms + bot checks | R1 |
| Re-audit #12 MINOR 1 and 2 | C1 |
| agent-step never stashes PM edits or moves a tag (A5) | A5 |
| Cards that rewrite stored data say so | rules block + QA / audit FAIL rule; L1 (if it adds a column) and D1 add migrations |
| LinkedIn poison job | L1 (early, priority 10); fallback L2 below |

## Decisions (to be appended to docs/decisions.md by card DC; owner "Answer:" comments on the gate override)

1. **Phase 5 scope:** PLAN 8 Phase 5 without JobStreet / YC (owner). Done-when is the dry-run count only.
2. **No submit in Phase 5, enforced in code:** every harness session aborts all non-GET/HEAD requests, WebSockets, beacons and
   service workers; form `submit` / `requestSubmit` throw; no generic click on submit elements. The only exception is a
   per-ATS allowlist of read-only operations named by R2 (Ashby GraphQL queries, matched on operation name and no `mutation`).
   No flag turns the guard off. A test proves zero POSTs reach a fixture server, and a twin test without the guard proves the
   test can fail.
3. **Agents never open a real employer form.** Agents and tests use committed fixtures served from 127.0.0.1 (fixture mode
   aborts every other host). Real dry runs are owner-run CLI commands, one per process, headed by default.
4. **Stop rule (strict):** the plan is computed before any field is filled. Any form field, required or optional, not covered by
   an approved answer, an approved choice mapping, a standard `profile.*` answer or the tier ask stops the run
   (`needs_input`), fills nothing, still takes a screenshot, and sends the uncovered labels to the Inbox. CAPTCHA, login wall,
   unexpected field type, changed form and page errors stop too.
5. **Salary:** a salary field (`isSalaryWording`) always takes the posting's tier ask, never a bank answer; no ask = stop.
6. **Choice mapping:** a choice / dropdown / radio / multi-select question is covered only when its matched answer is approved
   AND the owner has approved a mapping for (answer key, normalized label, option-set hash). The owner sees the form's
   options and picks once; a new option set needs a new mapping; clearing an answer's approval clears its mappings; salary
   questions never get one; nothing is mapped automatically.
7. **Resume:** from the approved answer `profile.resume_file` (local path to a PDF, under 10 MB); missing = needs input.
8. **Dry-run output is private:** `<data dir>/dryruns/<date>/<run id>/` (dir 0700, files 0600), run and field rows in the local
   DB; labels and counts only in logs. The dashboard serves a screenshot only by run id, realpath-checked under `dryruns/`.
9. **Done-when rule:** `dry runs: <c> correct of <r> reviewed (<f> full fills)`, met when at least 20 owner runs are marked
   correct and at least 10 of them are full fills (status `filled`). Fixture runs never count. "Wrong" needs a reason from:
   wrong_value, wrong_choice, missing_field, salary_wrong, stopped_wrongly, should_have_stopped, page_broken, other.
10. **No LLM on any Phase 5 path** (owner: no drafting). Unknown questions go to the Inbox for the owner.
11. **Playwright** is a new dependency (D2 justifies it and documents the Chromium install); browser tests fail loudly
    when the browser is missing, never skip.
12. **LinkedIn descriptions (L1):** failures are counted per job; one job failing (429 included) never starts the details
    backoff; only blocks from at least 2 different jobs do. A job that fails on 2 runs while others succeed becomes
    unavailable (stays `description_missing` in Needs a look). The exact rule is in L1's report.
13. **agent-step (A5):** PM / researcher edits to tracked docs are committed, not stashed; audit tags are set only on PASS,
    never moved (`git tag -f` removed), next free number when the title's number is taken.
14. **Review levels:** high for L1, A5, P1, P2 (fixes of audit findings or guardrails), D2, D3, D5, D7, D8 (applying);
    medium for D1, D4, D6, D9; low for C1, DC, R1, R2.
15. **Migrations:** a card adding a migration or rewriting stored rows starts its report with
    `OWNER: back up data/job-agent.db before this merges`; QA and the auditor FAIL a report without it. D1 waits for L1 so the
    migration numbers do not collide.

## Assumptions (PM)

- **P1 and P2 are in scope** although the owner's note did not list them: the Phase 4 report ("What you still have to do" 6)
  recommends both as high-risk cards "before any filler uses the bank", and D3 relies on both (typed validation and the salary
  detector). The owner can drop them at the gate.
- **R2 is added** next to the owner's R1: the fillers, the request allowlist and the fixtures cannot be built without knowing
  each form's DOM, its pre-submit requests and how to record a fixture. R1 answers a different question (terms, bot checks).
- **D5 waits for R1** because the CAPTCHA signatures come from it.
- **Lever / Ashby questions** are read from the page the filler opens and stored as `posting_questions`; no new hourly fetch.
- **The PM cannot edit `docs/decisions.md`** in this run (A5: agent-step stashes PM edits to tracked files). The decisions above
  go in through card DC.
- **The poison job id** from the owner's handoff is not repeated in the cards; L1's fixture uses a fake job id.

## LinkedIn fallback (draft, not created)

If the owner reports on the owner review card that LinkedIn detail pages stay blocked after L1, the PM creates:
**L2 "Descriptions from the company's ATS posting found by resolve-apply"** (dev, high). For a pending LinkedIn posting whose
resolved apply link (`apply_links`, method resolve-apply or owner) points at a Greenhouse / Lever / Ashby / Workable / Recruitee
job, fetch that job's description from the ATS's public JSON API (the same adapters as discovery, 2 s per host, no LinkedIn
request), store it like a fetched description and re-run the rules; LinkedIn detail requests are then only for postings with no
ATS link. Draft body: `data/handoff/p5/L2-draft.md`.

## Open questions for the owner (on the gate t_2c20b3fa)

1. Filler order Greenhouse -> Lever -> Ashby (as your notes).
2. Dry-run review UI (Decision 8, 9): tab layout, reasons and done-when rule (20 correct, at least 10 full fills).
3. Research scope: R1 five ATSs; R2 added by the PM.
4. Strict stop rule incl. optional questions (Decision 4).
5. Resume from `profile.resume_file` (Decision 7).
6. Headed browser by default; Playwright + Chromium download (Decision 11).
7. Ashby allowlist approach, or drop Ashby if R2 finds no safe way (Decision 2).
8. Back up the DB before L1 and D1 merge.
