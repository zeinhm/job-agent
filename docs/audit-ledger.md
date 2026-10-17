# Audit ledger

Merged medium/low tasks not yet covered by a batch or phase-end audit.
QA appends a row when it merges. The PM creates a batch audit task when the counts reach **5 medium** or **10 low**. The auditor clears the rows it covered and records the batch number.

Last audit tag: audit-14 (`5162ebd`, phase-end audit #14: Phase 5). Every earlier row was covered by it and cleared on 2026-10-17 (t_e3f354ae).

| Task id | Title | Risk | Merged commit | Merged on |
|---|---|---|---|---|
| t_9e75a5d6 | Pin the Ashby read-only allowlist with an exact-list test (audit #14 MINOR 1) | low | cfb4a4c | 2026-10-17 |
