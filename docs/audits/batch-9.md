# Batch audit #9 (audit-8..origin/main)

Covered: t_53073918 (queue API), t_f413f9ea (eval:extract), t_add8c02f (queue UI), t_ff411096 (apply-link correction), t_49015ee6 (owner pay-policy, high), t_55e60eeb (review stats). 52 files, +5599/-412.

## Setup
- install ok; lint: "ESLint: No issues found"; there is no `typecheck` script in the workspace (`pnpm -r typecheck` -> ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT), so typecheck is not part of this run. Existing state, not a regression.
- `pnpm test`: 103 files, 1917 tests passed.

## Breadth
- Personal data: grep of fixtures/eval/extract.json for emails/phones/LinkedIn profile URLs: none. No secrets found in diff.
- Guardrails: no LinkedIn, CAPTCHA, or submit paths added. Dashboard only writes review rows, registry pay policy, apply_links.
- POST /api/reviews: strict zod schema; action-specific fields enforced; apply_url limited to http(s); UI ExternalLink only renders http(s) with `rel="noopener noreferrer"`. Mutations sit behind the existing mutationGuard/hostGuard.
- Pay policy mark runs in one DB transaction (registry write, tier recompute, review row); a salary config failure rolls back. Review row snapshots values before the recompute. Owner source `owner:<date>` is protected from careers research (including a mark landing mid-lookup, tested) and from postings.
- Apply link correction: owner rows are excluded from `resolve-apply` re-selection; a reset row that re-resolves to the same URL stays `unknown`.
- Consistency: `PROTECTED_SOURCE` is defined separately in registry.ts and company-research.ts, with different sets (careers: only in registry). Intentional, both include owner.

## Depth (t_49015ee6, high risk, QA-only merge)
Break-the-code: removed `owner:` from registry.ts `PROTECTED_SOURCE`; all 1350 pipeline tests still pass. Not a defect: the owner can only set agnostic/adjusted, never `unknown`, so the `current.policy === "unknown"` branch that consults the set is unreachable for owner rows. The mutation is equivalent. Reverted.

## Findings
- [MINOR] packages/pipeline/src/intel/registry.ts:15 `owner:` entry in `PROTECTED_SOURCE` has no test that could fail (see above); harmless but dead protection.
- [MINOR] No `typecheck` script in package.json files, so definition of done "typecheck passes" cannot be run by script.

No BLOCKER or MAJOR.

## Fix tasks
None required. Optional: add a `typecheck` script (`tsc --noEmit`) to the workspace.

Tag `audit-9` should go on origin/main at 0caad1d (automation does it; I did not tag or push).
