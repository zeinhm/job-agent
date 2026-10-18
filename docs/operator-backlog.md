# Operator role backlog (real dry-run loop)

Plan card: t_6084517b. Owner gate: **t_fb1ae4e8** (every card without another parent waits on it).
Owner decisions 1-9 are on t_6084517b and recorded in `docs/decisions.md` (2026-10-18). Gate questions are listed below.

## Goal

A sixth build-team role, `operator`, runs the owner's real dry-run loop (candidates -> real dry runs -> report -> fix cards
-> re-run after a merged fix) so the owner stops relaying results by hand. The operator never sees a value: it runs only
agent-safe commands whose output is proven value-free by tests, on success and on every error path.

## Cards

| Plan id | Dev | QA | Audit | Risk | Depends on | What |
|---|---|---|---|---|---|---|
| O2 | t_3a6af01a | t_678e6c9c | t_0ba8bab7 | high | gate, audit t_dff34b6e | One value-free output helper; pin test that `dry-run` prints no value on success and every error path (today `cli.ts:278` prints `e.message`); labels / stop details sanitised (no forged lines) |
| O1 | t_8cc5ebc0 | t_acbc2927 | t_c8e1b2b6 | high | O2 audit | Dry-run lock shared with the owner (owner runs win, never two at once); `operator-dry-run <batch> <posting>` enforces batch max, captcha halt and candidate rule in code; migration `dry_runs.started_by`, `operator_batch` (OWNER backup line) |
| O3 | t_4d317b3e | t_736d0a0d | t_f3f8af04 | high | O2 audit | `dry-run-report`: per run status, stop reason/detail, fields (label, type, filled, source, key), previous run + REGRESSION flag; never value / review_note / note / screenshot |
| O4 | t_7fffe326 | t_4d91818c | t_fa161737 | high | O2 audit | `dry-run-candidates` and the shared candidate rule (owner decision 4): kept, not scam, not not_interested / applied; Greenhouse + Lever first, fewest missing |
| O5 | t_7b0eaabf | t_04a07ff1 | t_963a6ee9 | high | O1, O3, O4 audits | `bin/operator` wrapper (only allowed command), `.claude/roles/operator.json` (deny sqlite3, pnpm, node, readers, data/, config/, .env, screenshots), cc-run keeps both deny lists, `prompts/roles/operator.md` (loop 5a-5h, untrusted input, fixed card template), MODEL_operator, AGENTS.md, running.md |
| O6 | t_f624a18b | t_ef58a082 | t_31bad7aa | high | O5 audit | Dispatch: operator role in bin/dispatch / agent-step (main checkout, no lock, no commit), merge trigger on dry-run paths, daily trigger, never two batches, summary to `data/dispatch/operator-summary.md` |
| O7 | t_e8589b68 | t_0a7697b5 | - | low | gate | `pnpm dashboard` runs `build:web` first (owner decision 8) |

End of plan: Phase-end audit #17 t_29710695 (auditor; parents: every final audit / QA card) -> Operator role report
t_51d2db6f (pm) -> Operator role: owner review t_ede47337 (owner). The automation uses the next free audit number if #17 is
taken.

Order: O2 first (every operator command builds on its helper), then O1 / O3 / O4 in parallel (expect small `cli.ts`
registration conflicts; the sync automation handles them), then O5, then O6 last so no operator card can be created before
the role exists. O2 also waits for the audit of t_735d7f01 (t_dff34b6e), which changes the same dry-run files.

## Review levels

High for O1-O6 (personal-data guardrail, real-form access, role permissions, merge automation); low for O7. Recorded in
`docs/decisions.md` 2026-10-18.

## Design notes (PM)

- **Why a wrapper.** The project `.claude/settings.json` allows `pnpm:*`, `sqlite3:*`, `cat:*`, `grep:*` for every role, and
  in Claude Code a deny wins over an allow. Allowing `pnpm job-agent dry-run-report` alone is not possible without allowing
  all of `pnpm`. So the operator gets one allowed entry point, `bin/operator`, and pnpm / node / readers are denied.
- **Why `operator-dry-run`.** Batch limits (max per batch, captcha halt, one at a time, candidate rule) must hold even if
  the model misbehaves or a page injects instructions, so they are code in the command, keyed by the batch id (= the operator
  card id) stored on each run.
- **cc-run deny lists.** `jq '.[0] * .[1]'` replaces arrays; an owner override with a `deny` list would wipe the operator's
  deny list. O5 merges deny lists as a union for every role.
- **State lives on the board.** Root causes are fix cards titled `Operator fix [rc:<slug>]: ...`; the operator finds an open
  root cause with `hermes kanban list`, comments new evidence there, counts merged fixes for the two-fix [OWNER] rule, and
  re-runs a merged fix's postings (listed in the card) at the start of the next batch.
- **Summary.** The operator ends its report with `## Owner summary`; O6 copies it to `data/dispatch/operator-summary.md`.
  The NEEDS-ZEIN file lives in job-agent-ops (outside this repo), so the owner wires the include.

## Phase 6 reconciliation (PM proposal, gate question 6)

No Phase 6 gate notes are recorded in the repo; the proposal assumes "realform checks for QA/auditor with a fake persona" is
an owner intent for the Phase 6 gate.
1. The operator is the only role that opens a real form with the owner's data, on the owner's DB, value-free output only.
2. QA / auditor realform checks, once approved at the Phase 6 gate, use a fake persona on a scratch DB (`bin/smoke`), never
   the owner's DB or answers; headless; D2 guard on; only to verify a filler fix on posting ids the operator reported; they
   take the same dry-run lock and the same captcha stop and count toward the same batch limit.
3. Until then QA / auditor stay fixtures-only; the operator's re-run after a merge (decision 5f) is the real-form evidence.

## Questions for the owner (on the gate card t_fb1ae4e8)

1. Batch size (max 10; PM recommends 5 for the first 3 batches, then 10).
2. Trigger schedule: daily time, time window, merge trigger paths (default 10:00, window 08:00-22:00).
3. Summary format and place (PM proposal on the gate card); the owner wires the NEEDS-ZEIN include.
4. Headed or headless (PM recommends headed: matches the owner's runs and scores better on bot checks).
5. Command shape: `bin/operator` + `operator-dry-run` instead of plain `dry-run` for the operator.
6. Phase 6 reconciliation above.
7. Owner applies outside the repo: NEEDS-ZEIN include; overrides / global settings allow nothing the operator denies.
8. Re-runs of a merged fix count toward the batch limit and go first (PM assumption).

## Assumptions

- Defaults in the cards apply when a gate question is unanswered: batch 10, daily 10:00, window 08:00-22:00, headed,
  wrapper + `operator-dry-run`, re-runs count and go first.
- The operator writes only its comment file under `data/handoff/` (created fresh by agent-step each run).
- `bin/release` is allowed for the operator as the owner listed it; the prompt limits it to releasing the operator's own
  held batch cards after an owner answer.
