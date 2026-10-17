# Phase 5 fix round: backlog

Planned 2026-10-17 by the PM (card t_e3f354ae), based on the owner's first real dry runs (2026-10-17) and `docs/phase-5-report.md`.
There is no owner gate, because the owner already decided every item (t_e3f354ae decisions 1-6; `docs/decisions.md` 2026-10-17 entries
"Dry-run CAPTCHA rule", "Live-mode GET policy", "Phase 5 fix round review levels", "Audit ledger reset").
The Phase 5 owner review t_7a87ffba stays open until this round is done and the done-when is met.

## Owner items and where they go

| # | Owner item | Card(s) |
|---|---|---|
| 1 | CAPTCHA option (b), dry runs only: passive script / badge does not stop, visible challenge stops, never click | C1 |
| 2 | Greenhouse `?gh_jid=` links on company career pages: read the id, resolve the board slug, golden rows | G1 |
| 3 | Ashby "Phone Number" stopped `unexpected_field`: support the real phone field, fixture updated, consent untouched | A1 |
| 4 | LinkedIn L2: first explain and fix "from the ATS board 0", fold in audit #14 MINOR 4 and the L1 note; then the ATS posting as description source | L2a, then L2b |
| 5 | Live-mode GET policy option (a) for Phase 5, (b) before Phase 6 submit | `docs/decisions.md` (this commit); no card. Option (b) goes into the Phase 6 plan |
| 6 | Audit fix 1 (Ashby allowlist exact-list test), fix 3 (ledger cleared on PASS, AGENTS.md line) | H1, H2 (+ ledger reset in this commit) |

## Cards

| Key | Dev | QA | Audit | Risk | Prio | Title | Depends on |
|---|---|---|---|---|---|---|---|
| C1 | t_cbcbc227 | t_ab88eed4 | t_5753a0fe | high | 10 | Dry-run CAPTCHA: a passive script or badge no longer stops a run; a visible challenge still stops it, also mid-run | - |
| G1 | t_5b6fb1d5 | t_a3e87bce | t_099cbcff | high | 9 | Greenhouse career-page links: read gh_jid, resolve the board slug (stored, then verified boards-api lookup) | - |
| A1 | t_a31b041a | t_8821df67 | t_f8a5834f | high | 9 | Ashby dry run: fill the real-form phone field from profile.phone | - |
| L2a | t_bee8ac6e | t_94ad2f08 | t_4871d88a | high | 8 | LinkedIn L2a: why the free ATS route finds 0 on every run, fix it; clear stale 429 marks | - |
| L2b | t_3b2d9ff0 | t_e8e1daf6 | t_5bd9eeaa | high | 7 | LinkedIn L2b: description from the company's ATS posting found by the resolved apply link | L2a audit, G1 audit |
| H1 | t_9e75a5d6 | t_3314a12a | - | low | 6 | Pin the Ashby read-only allowlist with an exact-list test (audit #14 MINOR 1) | - |
| H2 | t_bfe5e86b | t_5fc21c72 | - | low | 6 | Audit ledger cleared by automation on an audit PASS; AGENTS.md line on docs commits in main (MINOR 3, 5) | - |

Then:
- t_bb5c6dc8 **Re-audit #15: Phase 5 fix round** (auditor). Parents: the five audit cards and the QA cards of H1 and H2. It reviews
  `git diff audit-14..main`, gives the status of every owner item and of audit #14 MINOR 1-5, runs `bin/smoke --demo` and six break checks.
- t_8e8e6e9c **Phase 5 fix round report** (pm): a "Fix round" section in `docs/phase-5-report.md`.
- t_4532cd2c **Phase 5: owner review after the fix round** (owner).

Card bodies: `data/handoff/p5fix/` (gitignored). Every dev / QA / audit body ends with the same rules block: nothing submits, fixtures
only for agents, `bin/smoke` only, no `config/` / `data/`, the owner's posting ids stay out of the repo, the OWNER backup line for
stored-row rewrites, no LLM.

## Expected OWNER backup lines
G1 (if it stores the verified slug), L2a (clears stale marks on stored rows) and L2b (writes descriptions). No card plans a migration.

## Assumptions (PM)
- **Review levels.** The owner set C1 to high and item 6 to low. The PM set G1, A1, L2a and L2b to high:
  - G1 changes which form page a dry run opens;
  - A1 changes a filler;
  - L2a and L2b fix L1 and audit findings, which are high by default.

  The two low cards are an owner exception to "fix tasks are always high" (decisions.md).
- **L2 is split** into L2a (root cause + L1 leftovers) and L2b (the new description source). Each one stays one reviewable change,
  and the owner's order ("first explain ... and fix that cause") becomes a dependency. L2b also waits for G1, because it reuses the
  `gh_jid` board resolver.
- **G1 cause, PM reading (to be confirmed by a failing test):** `resolveTarget` parses `postings.apply_url ?? url`, while the
  resolved career-page link lives in `apply_links.apply_url`. Also, a `?gh_jid=` link has no board slug. The slug lookup only accepts
  a slug that `boards-api.greenhouse.io` verifies for that exact job id, with at most 5 GETs per posting. A guessed slug is never used.
- **A1:** the agents cannot see the real Ashby form. The card asks the dev to infer the phone field's shape from the code and R2,
  and to make an unknown field's stop detail carry its type / DOM kind, so the owner's next report is diagnostic.
- **C1 and A1 run in parallel** and both touch Ashby files. C1 adds its CAPTCHA fixtures as separate files, and A1 leaves the CAPTCHA
  parts alone. QA / audit catch a merge conflict as usual.
- **Item 5 needs no code.** The PM recorded option (a) in `docs/decisions.md`. Option (b) is a Phase 6 prerequisite.
- **Ledger.** Phase-end audit #14 covered every row (the last row, `de6bdcc`, is an ancestor of `audit-14`). In this commit, the PM
  cleared the ledger and set `Last audit tag: audit-14`. H2 makes the automation do this from now on.
- **Re-audit number.** `audit-1..14` exist, so the re-audit is titled #15.

## Open questions for the owner
None blocking. After C1 merges, please send the labels (never values) of any field that still stops a real run, and say whether
LinkedIn descriptions arrive after L2a / L2b.
