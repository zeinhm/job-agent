# Digest-quality fixes (planned in t_35936679)

Source: the owner's live run of 2026-10-09 (58 kept, 21 Sonnet fit calls, $0.18). Not a new phase: no gate, report or
owner-review card. Every dev card is **high** risk: QA, then an individual audit that merges; then one round audit that
runs `bin/smoke` before/after. Planned at `main` 7c69896. Card bodies: `data/handoff/digestfix/` (local only).

| # | Owner item | Dev | QA | Audit | Waits for | Prio |
|---|---|---|---|---|---|---|
| 1 | Top matches only at fit >= 60; "Scored, not a fit" list | t_26be01b3 | t_6e8011be | t_a43cae82 | - | 6 |
| 2 | Role family in extraction; resolve rejects non-target families before fit | t_bdf10529 | t_73c5618d | t_0b7ea4c8 | - | 7 |
| 3 | Fit failures: exact reason, no max_tokens truncation, retry next run | t_d34fbf05 | t_44d6c41c | t_5fc07b96 | - | 7 |
| 4 | HN: not_a_job reject; digest uses the extracted role title | t_c69e0d08 | t_8b965273 | t_90ef4e52 | audits of 2 and 1 | 6 |
| 5 | Pay-policy research "no page" for every company | t_03b7dbc8 | t_906de9ab | t_b3a6268b | - | 6 |
| 6 | `process --reprocess` | t_a5b45ed4 | t_3158ba21 | t_46542386 | audits of 4 and 3 | 5 |

Round audit: **t_c9a36eac** "Audit: digest-quality fixes (round audit with bin/smoke)", parents = all six audits.

## Sequencing

- 2 and 3 cut LLM spend, so they go first. 1, 2, 3 and 5 can start at once (they touch different hunks of `enrich.ts` /
  `digest/index.ts`).
- 4 adds `roleTitle` to the same extraction schema and prompt as 2, and edits the digest heading after 1.
- 6 re-applies the final rule and resolve set and edits `enrich.ts` after 3, so it waits for 4 and 3.

## PM findings while planning (for the dev cards to confirm)

- Item 3: `callStructured` retries once on any invalid output, including `stop_reason: max_tokens`, with the same limit
  (explains "two fit calls"); Sonnet runs with thinking enabled and `FIT_MAX_TOKENS = 1024`; a reason over 140
  characters fails the whole score; `enrich` only re-selects `pending` / `budget_wait`, so a `failed` fit is never retried.
- Item 5: nothing in the code writes `companies.domain` (only `process.ts:77` reads it), so `candidateUrls` is empty for
  every company, the reason is "no company domain", and `pay_policy_checked_at` is set, blocking a retry for 90 days.
- Union limit: the role family and role title are added as a plain enum (with "unknown") and a plain string (""), so the
  extraction wire schema gains no union parameter (`schema-limits.test.ts`, max 12).

## Assumptions (owner may veto)

- **Target families = frontend, fullstack** (`TARGET_ROLE_FAMILIES`, one constant). Backend, mobile, data/ML, DevOps/SRE,
  security, design, non-engineering and not_a_job are rejected before fit. This matches PLAN 1 and the rule filter, which
  already rejects backend and mobile titles. A generic "Software Engineer" is classed by its described work.
- **Extracted role title is display-only and HN-only.** ATS titles stay as stored.
- **`--reprocess` makes no LLM call.** Old extractions keep their old facts (null role family / role title), so they are
  not rejected by family until re-extracted.
- Fit reasons over 140 characters are shortened in code instead of failing the score (display text, not a decision).

## Open questions for the owner

1. Should old postings be re-extracted with the new prompt (Haiku, roughly the cost of one extraction per kept posting),
   e.g. an `enrich --reextract` flag? Not planned; say if you want a card.
2. Is the target only frontend + fullstack, or should backend (e.g. Node/TypeScript backend) or mobile be scored too?
   One constant either way.
