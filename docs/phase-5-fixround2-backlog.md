# Phase 5 fix round 2: backlog

Planned 2026-10-17 by the PM (card t_3e3cb038). Based on the owner's real dry runs after fix round 1: every one stopped on the
contact fields before filling anything (0 / 0 fields). The owner already decided every item on the planning card, so there is no
owner gate. The owner reviews t_4532cd2c (fix round 1) and t_7a87ffba (Phase 5) stay open until the done-when is met.

## Owner items and where they go

| # | Owner item | Card |
|---|---|---|
| 1 | Lever stop `other` "ambiguous match" on the five contact fields: dedupe by answer key; ambiguity only for two different keys | M1 |
| 2 | Ashby stop `form_changed` "different: Phone Number": phone compared by digits only, fixture that reformats the phone | P2 |
| 3 | Greenhouse stop `form_changed` "missing: Location; extra: Search, Location (City)": the location autocomplete is the stored Location question, `needs_input` like Lever | G2 |
| 4 | Cards with the OWNER backup line merged before the owner could back up: `bin/agent-step` backs up the DB itself (`sqlite3 .backup`, keep 5) or holds `[OWNER]` | B1 |

## Cards

| Key | Dev | QA | Audit | Risk | Prio | Title | Depends on |
|---|---|---|---|---|---|---|---|
| B1 | t_3625211b | t_e954d3fa | t_2d48ed96 | high | 10 | Merge automation: back up data/job-agent.db before merging a card with the OWNER backup line, else hold [OWNER] | - |
| M1 | t_bd12e1a8 | t_dc0b8789 | t_165f503d | high | 9 | Dry-run ambiguous match: one answer key reached by two routes fills; two different keys stop and are named | audit waits for B1 audit |
| P2 | t_73f3d2e8 | t_432edbc9 | t_02369457 | high | 9 | Ashby dry run: phone readback by digits only; a reader change on the phone is not a changed form | audit waits for B1 audit |
| G2 | t_eafe628c | t_9bac4a90 | t_70cf4f09 | high | 9 | Greenhouse dry run: the location autocomplete is the stored Location question (needs_input, the owner picks) | audit waits for B1 audit |

Then:
- t_f6cfb948 **Re-audit #16: Phase 5 fix round 2** (auditor). Parents: the four audit cards. It reviews `git diff audit-15..main`,
  gives the status of owner items 1-4, runs `bin/smoke --demo` and six break checks.
- t_7ebeda21 **Phase 5 fix round 2 report** (pm): a short "Fix round 2" section in `docs/phase-5-report.md`.
- t_1df7c94a **Phase 5: owner review after fix round 2** (owner).

Card bodies: `data/handoff/p5fix2/` (gitignored). Every dev / QA / audit body ends with the same rules block as fix round 1, plus:
only the B1 code copies the DB (through `sqlite3 .backup`, at merge time); the owner's posting ids stay out of the repo.

## Assumptions (PM)
- **All four cards are high risk.** They are fixes of owner findings in the fillers (the default for fix tasks), and B1 changes
  the merge automation and touches the real DB file. All four are individually audited.
- **B1 goes first in effect.** The dev work of all four runs in parallel, but the audit cards of M1, P2 and G2 also wait for the
  B1 audit card, so no card of this round can merge before the automatic backup exists. M1 and P2 may rewrite stored rows (see
  below), which is exactly the case item 4 is about.
- **M1, PM reading of the code:** the ambiguity check (`packages/apply/src/fill-plan.ts:358-369`) already collects keys in a
  `Set`, so the same key reached twice should count once. The stop on all five contact fields therefore suggests two different
  key strings per field, for example `answer_bank` rows that are no longer in the YAML (the owner checked the YAML, not the
  table), or an answer that repeats a standard wording under another key. The card keeps the owner's rule (same key fills,
  different keys stop), asks the dev to reproduce the exact stop in a test and fix the real cause, and makes the stop detail name
  the colliding keys (keys only, never values).
- **P2, PM reading of the code:** a readback mismatch gives the per-field note `page kept a different value`, not
  `form_changed`. `form_changed "different: ..."` comes from the stored-vs-page comparison (`lever/form.ts:163-196`, used by Ashby).
  A plausible second cause: the run before fix round 1's A1 stored the phone row with another type, and the A1 reader now reads
  it differently. The card does the owner's digits-only phone compare and also asks the dev to find and fix the path that really
  produced `form_changed`, without hiding a real form change.
- **G2** follows the Lever location precedent (`docs/running.md` Lever "Location"): the field is never typed into a suggestion
  list, it is recorded as not filled, and the run is `needs_input`.
- **B1 hold:** `bin/agent-step` cannot block cards. It ends with `question "OWNER: ..."`, and `bin/dispatch` `hold` labels any
  question starting with `OWNER:` as `[OWNER]`.
- **Re-audit number:** `audit-1..15` exist, so the re-audit is #16. The ledger is empty (`Last audit tag: audit-15`) and this round
  adds no ledger rows (all high).

## Open questions for the owner
None blocking. After the round, re-run the three dry runs and send any remaining stop detail (labels and key names, never values).
