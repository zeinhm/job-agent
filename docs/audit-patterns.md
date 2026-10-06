# Audit patterns

Known mistake patterns. The auditor checks every task against this list; the dev reads it before starting.
Every mistake the human catches that the auditor missed gets added here (with date and task id).

## Risk levels

| Risk | Examples | When audited | Audit depth |
|---|---|---|---|
| High | salary logic, scam filter, applying (any tier), scraping guardrails, secrets, anything touching the human's accounts, **every fix task from an audit finding** | Individually, before merge | Full checklist, re-run everything, read every changed line, break-the-code check |
| Medium | source adapters, filters, db schema, scoring | Batch, after 5 merged | Breadth + depth (below) |
| Low | docs, config examples, UI layout | Batch, after 10 merged | Breadth + depth (below) |

### Batch audit method

1. **Setup once:** fresh checkout of `main`, install, typecheck, lint, full test suite.
2. **Breadth** - the combined change `git diff audit-<last>..main`, checked for:
   - tests that can't fail, skipped or weakened tests
   - secrets, personal data, guardrail violations
   - drift from PLAN.md / decisions.md
   - **inconsistency between tasks** (e.g. adapters handling errors, rate limits or dates differently)
3. **Depth** - pick the 1-2 tasks that look most suspicious from the breadth pass (or, if nothing stands out, the most complex ones) and audit them fully: re-run their evidence, break-the-code check.
4. **Report** in `docs/audits/batch-<n>.md`: tasks covered, what was checked, findings in the standard format, which tasks got the deep dive and why.
5. Tag `audit-<n>` on the audited commit and clear those tasks from the ledger.

## Checklist

### Claims vs reality
- [ ] Re-run every command from the evidence comment. Output must match.
- [ ] Every acceptance criterion actually satisfied, not partially or "in spirit"
- [ ] No "done" without evidence

### Tests that pass for the wrong reason
- [ ] Mocks that replace the logic under test
- [ ] Weakened or removed assertions, `.skip`, `.only`, `it.todo`
- [ ] Snapshots updated to match a bug
- [ ] Tests that never fail (try breaking the code: does a test catch it?)

### Fake or shortcut logic
- [ ] Hardcoded values or sample data standing in for real logic
- [ ] Swallowed errors: empty catch, log-and-continue on failures that should stop
- [ ] TODOs, placeholders, "for now" code left behind
- [ ] Silent fallbacks that hide failure (e.g. returning [] when a source is blocked)

### Spec and scope
- [ ] Matches PLAN.md and decisions.md; deviations have a decision entry
- [ ] No changes outside the task's scope
- [ ] No new dependencies without justification

### Guardrails (always, any risk level)
- [ ] No secrets or personal data in code, fixtures, logs, docs, commits (public repo: check against AGENTS.md personal data rules)
- [ ] No LinkedIn login / cookies / account automation
- [ ] No CAPTCHA bypass, no submit click in semi-automated flows, no real submissions before Phase 6
- [ ] Scraping rate limits present and conservative

### Domain-specific (this project)
- [ ] Salary normalization: yearly / 12, hourly x 160, currency converted with the stored FX rate
- [ ] Floor applied after normalization, never compared across currencies
- [ ] US pay-transparency ranges not treated as global_flat
- [ ] Location "unclear" is flagged, not silently accepted or rejected

## Human-observed patterns
<!-- The owner adds patterns here. Format: YYYY-MM-DD | task id | what was wrong | how to detect -->
