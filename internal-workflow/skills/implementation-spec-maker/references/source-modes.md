# Source Modes

Read the section matching the active source. Apply the common source-authority and evidence rules from `SKILL.md` in every mode.

## Plan-Based

- Treat the approved plan as architectural authority.
- Preserve its scope, vertical-slice boundaries, guardrails, rejected paths, required docs, validation, and blocking assumptions.
- Block when missing guardrails would let implementation drift or require redesign.

## Issue-Based

- Treat one issue's acceptance criteria as the execution contract; parent material supplies product context, not sibling-ticket authority.
- Read comments for changed decisions, blockers, credentials, external contracts, live prerequisites, and rejected approaches.
- Preserve relevant `Implementation preparation`, `External contracts`, `Verification`, and `Blocked by` content.
- Use `source_type: "issue"` when no plan exists. Do not block merely because `source_plan` is absent.
- Block when acceptance criteria are ambiguous, non-verifiable, or contradicted by repository evidence.

## Contract Discovery

- Specify discovery only: exact sources/tools to inspect, evidence to collect, decision record to update, and issue fields/comments to update.
- Confirm the API surface, auth/secret source, license or terms constraints, acquisition path, deterministic fixture strategy, live-validation prerequisite, and rejected acquisition paths that matter to later implementation.
- Do not include downstream implementation slices while material external behavior remains unconfirmed.

## Revision

- Reconcile the entire existing spec against new authority and current repository evidence.
- Preserve still-valid completed `[x]` items exactly.
- Reopen invalid completed items to `[ ]` and add a short `Revision Note:` with evidence.
- Never silently delete progress or defect history.
- Mark the spec blocked when completed history or its contract ledger cannot be trusted.
