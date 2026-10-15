# Phase 4 backlog: Review workflow

Status: planned 2026-10-15 by the PM (card t_a35f415d); waiting for owner approval on gate **t_10be94d5**.
Done when (PLAN.md 8): a day's matches are processed in under 30 minutes (measured by `review-stats`, conventions
section 9).
Binding design decisions for all cards: `docs/phase-4-conventions.md` (plus the Phase 1-3 conventions).
Inputs: `docs/phase-3-report.md` (recommendations 2-6), the owner notes on t_a35f415d, `docs/audits/phase-3.md`.
Card bodies: `data/handoff/p4plan/` (local only).

## Cards (47: 1 owner gate, 1 research, 20 dev, 20 QA, 2 individual audits, phase-end audit, report, owner review)

Merge point = the card that merges into main (QA for medium/low, the auditor for high). Downstream cards wait for it.
Higher `--priority` runs first: gate 10, foundation 9-8, queue and feedback 7-6, inbox/stats/eval 6-4, e2e and docs 4-3.

| # | Dev card | Risk | QA | Audit | Waits for (merge points) |
|---|---|---|---|---|---|
| G | t_10be94d5 Phase 4: owner approves the plan (owner) | - | - | - | - |
| R1 | t_5c4e4567 Research: application questions from public ATS job APIs (researcher) | low | - | - | G |
| D1 | t_1099c9eb Phase 4 schema: reviews, answer_bank, posting_questions, unknown_questions; SQLite WAL | medium | t_3cef0999 | - | G |
| D4 | t_05df2eda Dashboard server: Hono on 127.0.0.1, host and origin guards, `--self-check`, `bin/smoke dash` | **high** | t_c9c1b338 | t_9dddc022 | G |
| D17 | t_f413f9ea Eval script `eval:extract` with a committed golden set | medium | t_481091fb | - | G (see note 1) |
| D2 | t_2d987b85 Answer bank: answers.yaml loader, fake example, `answers import` | medium | t_59a62308 | - | D1 |
| D3 | t_99deaa3f Demo seed: `seed-demo` fills a smoke DB with fake queue data | medium | t_8e2c363f | - | D1 |
| D5 | t_c269b5ab Dashboard web app skeleton: Vite + React + TanStack Query, four tabs | medium | t_ea646225 | - | D4 |
| D6 | t_53073918 Review queue API: shared day selection, queue, posting detail, POST /api/reviews | medium | t_5f17e853 | - | D3, D4 |
| D7 | t_add8c02f Review queue UI: table per section, detail panel, action buttons | medium | t_8aeeedc2 | - | D5, D6 |
| D9 | t_ff411096 Feedback: owner apply-link correction; resolve-apply never overwrites it | medium | t_43ff11af | - | D6 |
| D10 | t_49015ee6 Feedback: owner pay-policy mark updates the registry, recomputes tier and ask | **high** | t_55857677 | t_f1b9c247 | D6 |
| D8 | t_731c5fc6 Fast triage: keyboard shortcuts, auto-advance, bulk, undo, timer | medium | t_c08c1916 | - | D7 |
| D11 | t_da6ce498 Answer bank tab: list, edit, approve, alternatives, export to data/exports | medium | t_2e40122d | - | D2, D5 |
| D12 | t_22e91591 Fetch application questions from public ATS job APIs (`fetch-questions`) | medium | t_bfdcbaf5 | - | R1, D1 |
| D13 | t_8140d1bc Match questions to the answer bank; fill the unknown-questions inbox | medium | t_f1a0d174 | - | D12, D2, D7 |
| D14 | t_bb962b1b Unknown-questions inbox: answer, link, dismiss; re-match | medium | t_e119a538 | - | D13, D11 |
| D15 | t_55e60eeb Review stats: `review-stats` CLI and Stats tab | medium | t_65b66c9e | - | D6, D5 |
| D16 | t_8f401a3b Digest: reviewed postings leave Top matches; review line | medium | t_49ad3959 | - | D6 |
| D18 | t_33bd7696 Eval script `eval:fit` and `eval:export-reviews` | medium | t_7a95db90 | - | D17, D6 |
| D19 | t_3b914bae End-to-end test for Phase 4 and `bin/smoke` coverage | medium | t_b9197c40 | - | D8, D9, D10, D14, D15, D16, D18 |
| D20 | t_c5832945 Run docs for Phase 4 | low | t_607d7abb | - | D19 |

### End of phase
| Card | Assignee | Waits for |
|---|---|---|
| t_ca5ce6c3 Phase-end audit #4: Phase 4 (security re-check live, smoke, demo review pass, done-when line) | auditor | all 20 merge points |
| t_4b0651e2 Phase 4 report | pm | phase-end audit |
| t_acf2f9cd Phase 4: owner review | owner | report |

Notes:
1. D17 has the gate as its only parent (creation order slip). It needs the `llm_calls.purpose` values `eval_extract` /
   `eval_fit` from D1. Its priority (5) puts it well after D1 (9) in the dev queue; if D1 has not merged when D17
   starts, D17 adds the same two enum values itself and merges main before handing over.
2. **t_b90a4fc1** (triage, "Eval script eval:fit ...") is a stray duplicate of D18 created by mistake with wrong parents.
   It is not part of the plan. Please archive it; do not promote it. The real D18 is t_33bd7696.
3. The gate body says "48 cards"; the correct count is 47.

## Order
Approval -> research R1, schema D1 and dashboard server D4 (high) in parallel -> answer bank loader D2, demo seed D3, web
skeleton D5 -> queue API D6 -> queue UI D7, both feedback cards D9 / D10 (high), digest D16, stats D15 -> fast triage D8;
answer tab D11; questions D12 (after R1) -> matching D13 -> inbox D14; evals D17 -> D18 -> e2e D19 -> docs D20 ->
phase-end audit -> report -> owner review.

Critical path (done when): G -> D4 (+QA, audit) -> D5 -> D6 -> D7 -> D8 -> D19 -> D20 -> phase-end audit.
Inbox path: G -> R1 -> D12 -> D13 -> D14 -> D19.

Hotspots on purpose:
- `schema.ts`: only D1 (D17 note 1).
- `digest/index.ts`: D6 moves the selection out (byte-identical), then D16 changes output; D9 only reads apply links.
- Review POST handler: D6 creates it; D9 and D10 add side effects in parallel (different action branches). Each merges
  main before handing over; QA keeps both.
- Queue API rows / table: D6, D7, then D13 adds the `questions` field (D13 waits for D7).
- `bin/smoke`: D4 adds `dash`, D12 adds `fetch-questions`, D19 adds the rest.

Audits: 2 individual (D4 server security, D10 pay-policy/tier). 17 medium + 1 low merges -> the PM creates a batch audit
from the ledger at every 5 medium merges (about 3 during the phase); the phase-end audit covers the rest.

## Risks
- **Local server with personal data.** Bound to 127.0.0.1, host guard against DNS rebinding, origin and content-type
  guard against cross-site POSTs, text-only rendering, CSP. Individually audited and re-checked at phase end.
- **Salary logic through feedback.** A pay-policy mark changes asks; recompute uses the existing pure tier code, floor
  always applies, individually audited.
- **Personal data in a public repo.** Answers, reviews, notes and exports exist only in the DB under `data/` and in
  `config/answers.yaml`. Fake persona everywhere else; `seed-demo` refuses the real DB.
- **Question coverage.** Not every ATS exposes questions publicly; R1 decides which ones. Unsupported ATSs show `0/0`
  questions, not "covered".
- **30-minute goal depends on volume.** Real daily volume is still unknown (Phase 3 live day not reported yet). The
  dashboard measures it; if a day has too many matches, the lever is the fit threshold or the deny-list, not speed.
- **Frontend toolchain in `pnpm check`.** Vite build and jsdom tests make `pnpm check` slower; the web card keeps them in
  one workspace project.

## Assumptions (owner may veto on the gate)
- Delivery stays dashboard + markdown digest; a push channel only after your answer (one extra card).
- Action and reason lists as in conventions section 5; answer-bank fields as in section 7.
- Dashboard edits to answers stay in the DB; `config/answers.yaml` is only read; export to `data/exports/`.
- No LLM in the product paths of Phase 4; eval scripts are owner-run and share the $1/day cap.
- `later` keeps a posting open; scam verdicts are stored only.
- `fetch-questions` joins `bin/run-hourly` after `resolve-apply`.

## What I need from you (also on the gate card t_10be94d5)
1. Delivery channel: dashboard only (proposal), or Telegram / e-mail as well.
2. Review action list and not-interested reasons.
3. Answer-bank fields and "dashboard edits stay in the DB".
4. LLM cap: keep $1/day; no LLM drafting of answers in Phase 4.
5. Archive the stray triage card t_b90a4fc1 (and, as before, t_55542219 and t_6491b379 from Phase 1).
