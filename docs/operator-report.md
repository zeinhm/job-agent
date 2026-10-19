# Operator role report

Plan: `docs/operator-backlog.md` (plan card t_6084517b, owner gate t_fb1ae4e8, owner answers 1-8 on that card).
Phase-end audit #17: t_29710695, report `docs/audits/phase-17.md`, verdict **PASS**, tag `audit-17`.
Next card: owner review t_ede47337.

## What shipped

A sixth role, `operator`, runs your real dry-run loop: candidates -> real dry runs -> value-free report -> fix cards ->
re-run after a merged fix. It never sees a value (answer, contact detail, screenshot) and never submits.

| Plan id | What | Dev / QA / Audit | Merge commit on main | Risk |
|---|---|---|---|---|
| O2 | One value-free output helper (`packages/apply/src/dryrun/safe-output.ts`); `dry-run` prints no value on success or on any error path (pin test) | t_3a6af01a / t_678e6c9c / t_0ba8bab7 | `e774e40` | high |
| O3 | `dry-run-report`: per run status, stop reason/detail, fields (label, type, filled, source, key), previous run + `REGRESSION` flag; never value / note / screenshot | t_4d317b3e / t_736d0a0d / t_f3f8af04 | `c31d13a` | high |
| O1 | Dry-run lock shared with you (your runs win, never two at once); `operator-dry-run <batch> <posting>` with batch limit, CAPTCHA halt and candidate rule in code; migration `dry_runs.started_by`, `dry_runs.operator_batch` | t_8cc5ebc0 / t_acbc2927 / t_c8e1b2b6 | `0fb6743` | high |
| O4 | `dry-run-candidates` + the one shared candidate rule (`isDryRunCandidate`): kept, not scam, not not_interested / applied; Greenhouse + Lever first, fewest missing first | t_7fffe326 / t_4d91818c / t_fa161737 | `126b283` | high |
| O5 | `bin/operator` wrapper (the only allowed command), `.claude/roles/operator.json`, `prompts/roles/operator.md`, `MODEL_operator`, AGENTS.md, running.md; `bin/cc-run` keeps the union of deny lists for other roles | t_32d09f35 / t_04a07ff1 / t_963a6ee9 | `44e4673` | high |
| O6 | Dispatch: operator role in `bin/dispatch` / `bin/agent-step`, merge + daily triggers, start window, never two batches, summary file | t_f624a18b / t_ef58a082 / t_31bad7aa | `e6a005a` | high |
| O7 | `pnpm dashboard` runs `build:web` first | t_e8589b68 / t_0a7697b5 / (ledger, covered by audit #17) | `857ea95` | low |

Note on O5: the backlog lists dev card t_7b0eaabf; the merge commit names branch `task/t_32d09f35-operator-role-bin-operator-wra`
and audit t_963a6ee9. The merged content is the O5 scope as planned.

Audit report commit: `4e3e85b` (tag `audit-17`). Owner decisions are in `docs/decisions.md` (2026-10-18 entries).

## How the operator runs

Full reference: `docs/running.md`, sections "The dry-run lock and `operator-dry-run`" and "Operator".

- **Triggers** (`bin/operator-dispatch.sh`, settings in `bin/jobagent.conf`):
  1. **Merge:** a pushed squash merge touching `OPERATOR_PATHS` (`packages/apply/src/`, `packages/pipeline/src/dry-run*`,
     `packages/pipeline/src/cli.ts`) creates a card `Operator batch <YYYY-MM-DD HH:MM> (after <dev card ids>)`. Those dev
     cards' postings are re-run first.
  2. **Daily:** at `OPERATOR_DAILY_AT` = 10:00 if no batch card was created that day.
  3. **By hand:** create a card assigned to `operator`.
- **Window:** batches only start between 08:00 and 22:00 local time (merge-triggered too). A trigger outside the window is
  kept in `data/dispatch/operator-pending` and fires when the window opens.
- **Never two batches:** while an operator card is todo / ready / running / blocked, a new trigger becomes a comment on it.
- **Batch size (in code, `packages/apply/src/operator-batch.ts`):** 5 forms per batch for the first 3 batches ever
  started, then 10. Re-runs count. There is no per-day limit of 5 or 10; a safety ceiling of **100 operator forms per
  rolling 24 h** across all batches applies. A random gap of **60 to 120 s** between two operator forms is enforced in code
  (your own runs never wait and do not count); `bin/operator run` sleeps for it and prints `waiting:<seconds>`.
- **One form at a time, headed.** `operator-dry-run` has no headless option. Expect a browser window on your screen during a
  batch.
- **Lock:** mkdir lock at `<data dir>/locks/dryrun`, shared with your own `pnpm job-agent dry-run`. Your run always wins: it
  waits for the operator's *current form* only (never a whole batch), and the operator is refused while you wait. A stuck
  form goes stale after 30 minutes.
- **CAPTCHA:** the first run that stops on a visible CAPTCHA halts that batch and every operator batch for 24 h; the card is
  held `[OWNER]` (`OWNER: CAPTCHA seen on <ats> posting <id> in batch <card id>`).
- **Two failed fixes:** if the same root cause still fails after two merged fixes, the operator blocks with `OWNER:`.
- **What it can run:** only `bin/operator candidates|report|run|card|note|release` and `hermes kanban list|show`. `pnpm`,
  `node`, `sqlite3`, shell readers, `git`, `data/`, `config/`, `.env`, screenshots and the DB are denied; it runs in
  `--permission-mode dontAsk` with its own settings file only (your overrides file is not merged for it).
- **Fix cards:** titled `Operator fix [rc:<slug>]: ...`, high risk for filler or merge-automation changes (dev -> QA ->
  auditor), body from a fixed template with page text JSON-quoted.
- **Summary:** the `## Owner summary` section of its report (runs ready for your Correct/Wrong, open root causes, `[OWNER]`
  holds) is copied by `agent-step` to `data/dispatch/operator-summary.md` after every batch (DONE or BLOCKED), overwriting
  the previous one. You still mark runs Correct/Wrong in the dashboard; the operator never does.
- **How to stop it:** `hermes kanban block <operator card>`. A form already open ends by itself; your own `dry-run` always
  wins the lock. To pause triggers for longer, block the open batch card (new triggers only comment on it).

## Test status

`pnpm check` on main `4e3e85b` (this run, 2026-10-18), exit 0:

```
 Test Files  168 passed (168)
      Tests  3151 passed (3151)
...
51 passed, 0 failed        (bin/test-operator-dispatch.sh)
...
Ran 25 tests in 0.001s
OK
```

Shell suites in the same run: `31 / 15 / 38 / 18 / 68 / 51 passed, 0 failed`. The auditor also ran `pnpm check` on a fresh
checkout (exit 0), a mutation check on the 24 h cap (test fails when the cap is disabled), and an end-to-end smoke
(`bin/smoke --demo`: candidates -> `operator-dry-run` refuses the scratch DB, exit 2 -> `dry-run-report`), all value-free.

Not run by anyone yet: `bin/test-operator-live.sh` (real `claude` permission check, owner-run, uses the Pro plan).

## Phase-end audit #17 findings

No blocker, no major. Three minor, all **open** (no fix card created yet):

| # | Finding | Status | Recommendation |
|---|---|---|---|
| 1 | `packages/pipeline/src/dry-run-report.ts:180`: `started_by` NULL (your runs before O1, fixture runs) prints `by=other`; decision says NULL = owner. The operator cannot tell your runs from unknown ones. | open | low fix card: print `by=owner` for NULL, adjust `dry-run-report.test.ts` |
| 2 | Operator permission set is proven by static tests only; the live test is owner-run. Admitted residuals: the Write tool could overwrite another card's file in `data/handoff/`; Read denies cover Grep/Glob best-effort only. | open (owner action) | you run `bin/test-operator-live.sh` once before the first real batch and after each Claude Code upgrade |
| 3 | `packages/pipeline/src/dry-run.ts:390`: `operator-dry-run` checks the candidate rule but not "canonical posting" / `decision = keep` list-only checks; a duplicate posting id named by hand would run. Low impact (still passes the safety rule and must be an ATS link). | open | low fix card: move `canonical_posting_id IS NULL` into the shared rule, with a test |

Findings 1 and 3 are small and independent; the PM can plan them as one low-risk fix round if you want them before the first
batch. Neither blocks a safe batch: #1 only affects the label the operator reads, #3 needs the operator to pick an id that
`candidates` never offers.

## Owner applies (outside the repo)

1. **NEEDS-ZEIN include:** add `data/dispatch/operator-summary.md` to the NEEDS-ZEIN generator in job-agent-ops (gate answer 3).
2. **Overrides check:** you confirmed on the gate that `~/.config/job-agent/claude-overrides.json` and your global Claude
   settings allow nothing the operator denies. The operator no longer merges the overrides at all (O5), and the other roles
   keep the union of both deny lists. Re-check only if you add `permissions` to either file later.
3. **Live permission test:** run `bin/test-operator-live.sh` once before the first real batch (audit finding 2).
4. **DB backup:** O1's migration added two nullable columns (`dry_runs.started_by`, `dry_runs.operator_batch`). The squash
   commit body of `0fb6743` names no backup file, so check that a `data/job-agent.db.bak-*` from 2026-10-18 exists before
   the first batch; if not, take one by hand (`sqlite3 data/job-agent.db ".backup 'data/job-agent.db.bak-manual'"`).

## Known limitations

- Headed only: a window opens on your screen for each form during a batch (08:00-22:00).
- The 24 h rolling ceiling (100 forms) and the 24 h CAPTCHA halt apply across batch ids.
- The pacing gap (60 to 120 s) makes a batch of 10 forms take about 10 to 20 minutes.
- The operator reads page text (labels, stop details) as untrusted data. The prompt and the fixed card template limit what it
  does with it, and `bin/operator` constrains every argument, but a page could still steer the wording of a fix card's
  root-cause paragraph. QA and the auditor review every fix card's code change as usual.
- Root-cause state lives on the board (`Operator fix [rc:<slug>]` titles); renaming those cards by hand breaks the
  operator's matching.
- QA / auditor stay fixtures-only; realform checks with a fake persona wait for the Phase 6 gate (gate answer 6).

## What to watch in the first real batch

1. **Before it starts:** run `bin/test-operator-live.sh`; confirm the NEEDS-ZEIN include shows the summary file.
2. **Batch 1 is 5 forms max.** Check the card report: 5 or fewer `operator-dry-run` lines, one at a time, each
   `status=... reason=... fields=n/m` and nothing else (no values, no screenshot path).
3. **Re-runs first:** a merge-triggered batch should start with the postings of the dev cards named in its title.
4. **Lock:** start your own `pnpm job-agent dry-run <id>` during a batch once; expect `dry-run: waiting for the operator's
   current form`, then your run, and the operator's next call refused (`an owner run is waiting`) with the batch stopped.
5. **CAPTCHA:** if any run stops with reason `captcha`, the card must be held `[OWNER]` and no further run attempted.
6. **Fix cards:** titles `Operator fix [rc:<slug>]: ...`, a QA card and (filler change) an auditor card under each; body
   has posting ids, ATS, JSON-quoted labels and reasons, no values, no instructions copied from a page.
7. **Summary file:** `data/dispatch/operator-summary.md` holds exactly the three `## Owner summary` lines.
8. **`by=other` on your old runs** in the report is audit finding 1, not a bug in the batch.
9. **Correct/Wrong stays with you** in the dashboard's Dry runs tab.

## Recommendations

- Plan findings 1 and 3 as a small low-risk fix round (one card each) before or right after the first batch.
- Keep the first 3 batches at 5 (as in code) and review each one before the next daily trigger; if a batch shows a wrong
  pattern, block the next operator card until it is fixed.
- After the first week, decide whether 10:00 and 08:00-22:00 still fit, and whether the 24 h cap should rise; both are
  settings (`bin/jobagent.conf`) or constants (`operator-batch.ts`) with a decisions.md entry.
