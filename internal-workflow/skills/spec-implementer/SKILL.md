---
name: "spec-implementer"
description: "Executes approved specs continuously with honest checklist updates, proportional validation, opt-in Git checkpoints, and required review/signoff."
---

# Spec Implementer

Execute one approved implementation spec continuously. Keep its checklist
truthful and stop only at a real authority, evidence, safety, or explicit pause
boundary. Do not redesign approved scope.

Read before editing:

- the complete approved spec and applicable repository instructions;
- `references/review-loop.md` for approved-spec review ownership;
- `../../docs/agents/contract-test-ledger.md` only when the spec contains
  material contract invariants.

## Modes

Compact and full specs use the same direct phase flow. `compact` describes
document density, not implementation size or risk. Full mode adds only the
concrete `Risk Controls`, stop conditions, validation, or coordination contract
already present in the approved spec; it does not add review or reporting
ceremony by itself.

Use multiple agents only when the spec defines perfectly disjoint write scopes
and one integrator. Otherwise execute single-agent.

## Preflight

1. Confirm `status`, `spec_mode`, `implementation_size`, `review_profile`,
   repository count, authority, scope, and exclusions.
2. Confirm first-phase targets, required services/env/data/fixtures, commands,
   observable proof, protected paths, and rejected approaches.
3. Stop if execution needs invented paths, symbols, contracts, commands, or
   product decisions; if reality differs only in a bounded technical detail,
   resolve it from repository evidence and record the adjustment.
4. Keep an intermediate review checkpoint only when the spec explicitly names
   a stable high-risk slice that later work will not invalidate. Move every
   ordinary or unstable checkpoint to final review.
5. Do not create `## Implementation Review State` yet.

## Implementation

For each phase:

1. Re-read its scope and preconditions.
2. Implement narrow vertical behavior slices through `$tdd` when applicable.
3. Update reached checklist and Contract Test Ledger items at natural
   checkpoints; never save all updates for the end.
4. Run the phase's targeted exit proof.
5. Record a short `Blocked:` note for any item that cannot complete.
6. Continue immediately when the exit proof passes and no stop condition
   applies.

Do not add cleanup, comments, helpers, abstractions, retries, flags, fallbacks,
or compatibility paths outside the spec. A small implementation adjustment is
allowed only when it preserves approved behavior and is supported by current
repository evidence.

## Git Checkpoints

Default to no commits. `$spec-implementer` does not authorize Git writes.

Use per-slice commits only when explicitly authorized and they materially help
a disjoint multi-agent handoff, planned cross-session pause, or approved
rollback boundary. Require a passed slice proof, stage only owned paths, follow
`$commit`, and never push without separate authority. File/slice count and risk
profile alone do not justify checkpoints.

## Review And Validation

Run targeted behavior tests and the smallest affected integration checks first.
Use a full repository suite only when the spec or repository policy requires
it, broad contract fan-out cannot be isolated, or the task is genuinely high.

Run final `$code-review` only when the spec, repository policy, or
`../../docs/agents/review-gates.md` applies. Ordinary medium work gets one
`reviewer_standard` Full review on the settled diff. High gets two disjoint
`reviewer_deep` lenses. Cleanup stays inside spec/standards review.

Immediately before the first reviewer launch, create only the minimal
`## Implementation Review State` required by `references/review-loop.md`.
Reconcile a recorded live session before replacement after interruption.

Repair compatible findings once and rerun affected validation. Coordinator
verification closes ordinary medium/low behavior-preserving repairs. Use
Closure only for critical/high, protected trust/data/concurrency/shared-contract
impact, or invalidated mandatory coverage. Do not restart broad Full review
unless the repair actually invalidated its coverage.

## Stop Conditions

Stop and report the exact blocker when:

- a precondition, source contract, required proof, or protected path differs
  materially from the approved spec;
- exact execution requires a new product, scope, ownership, or risky trade-off
  decision;
- required validation or reviewer is unavailable and no approved substitute
  exists;
- multi-agent scopes overlap or integration ownership is missing;
- an explicit user pause or halt condition is reached.

Do not stop merely because the work is broad, review took time, or a medium/low
finding required one repair.

## Completion

Complete only when reached checklist items are reconciled, affected proof and
required review pass, protected paths and rejected approaches remain intact,
and every unfinished item has a concrete status.

For ordinary medium work report only:

- behavior/contract implemented;
- review result and repaired/open findings;
- affected validation;
- skipped checks and residual risk;
- changed files and any authorized commits.

For high, actual Closure, accepted risk, interrupted recovery, or multi-agent
delivery, add the relevant invariants, reviewer coverage, defect IDs, session
recovery, and handoff ownership. Do not create a separate report file unless
the spec or the complexity of that exceptional handoff requires it.
