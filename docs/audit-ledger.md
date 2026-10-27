# Audit ledger

Merged medium/low tasks not yet covered by a batch or phase-end audit.
QA appends a row when it merges. The PM creates a batch audit task when the counts reach **5 medium** or **10 low**. The auditor clears the rows it covered and records the batch number.

Last audit tag: audit-17 (e6a005a). Rows merged up to that commit were cleared by the automation.

| Task id | Title | Risk | Merged commit | Merged on |
|---|---|---|---|---|
| t_6d99e420 | Dispatch: a blocked operator batch never stalls later batches, and shows in the owner summary | medium | 0f1c5a0 | 2026-10-19 |
| t_c459a940 | Operator fix [rc:greenhouse-cover-letter-unfilled]: Greenhouse Cover Letter long_text field with key misc.cover_letter_text ends unfilled with note other | medium | 77b167e | 2026-10-27 |
| t_c0c2b45a | Operator fix [rc:greenhouse-form-not-found]: Greenhouse dry run stops form_changed with application form not found | medium | a463fa7 | 2026-10-27 |
