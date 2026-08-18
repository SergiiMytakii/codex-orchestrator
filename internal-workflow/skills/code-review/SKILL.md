---
name: code-review
description: Read-only Review entrypoint for a settled diff. Substantial changes receive independent Spec and Standards review; targeted repair review runs only the affected lens.
---

# Review

Review a settled change through two independent lenses:

- **Spec:** requirement fidelity, missing or partial behavior, incorrect
  implementation, and scope drift.
- **Standards:** correctness, failure paths, repository policy, maintainability,
  legacy residue, duplicate ownership, and unnecessary machinery.

Review is inspection-only. Never edit, repair, stage, commit, push, or open a
PR. Substantial behavior or contract changes require Review; obvious local
docs, copy, formatting, mechanical config, or corrections may use direct proof.

## Boundaries

- **Authorized outcome:** the request, issue, or Parent PRD plus existing
  invariants and mandatory repository rules.
- **Impact cone:** callers, data, runtime, and proof surfaces that may be
  inspected to establish effects. Inspection creates no authority.
- **Repair scope:** the smallest change that restores a proven obligation,
  invariant, or mandatory rule without widening the authorized outcome.

A reviewer verdict is evidence, not authority. Mark a finding `BLOCKER` only
when evidence links a concrete defect or required-proof gap to an authorized
obligation, existing invariant, or mandatory rule. Include its source,
file/line, trigger, impact, and evidence. Treat unsupported preferences,
hypothetical hardening, and architecture or cleanup beyond the outcome as
`OBSERVATION`.

Treat unsupported machinery as a scope blocker when the target adds runtime
behavior, ownership, persisted state, compatibility, or a public contract that
neither the authorized outcome nor a proven failure path requires. Keep private
implementation preferences as observations unless they cause a concrete
defect.

For Standards, read [standards-smells.md](references/standards-smells.md).
Fowler smells remain non-blocking observations unless separate evidence meets the blocker
threshold. Repository policy wins, and tooling-enforced rules need no duplicate
finding. If optional machinery causes a defect, prefer deleting it; extend it
only when the authorized outcome requires it.

## Process

1. Pin an existing baseline and settled target, then verify the comparison is
   valid and non-empty. Supply the exact diff, changed files, proof, authority
   source, and repository policy. Missing required authority or proof is a gap;
   never silently skip a lens.
2. Select the mode:
   - initial Review launches one fresh `spec_reviewer` and one fresh `standards_reviewer`
     in parallel;
   - targeted Review runs only the affected lens: Spec-only repair for
     requirement coverage or behavior, Standards-only repair for correctness,
     invariants, architecture, or mandatory rules, and both lenses when the
     repair affects both or cannot be isolated.
   Give targeted reviewers the previous reviewed revision, repair delta,
   repaired blockers, direct impact cone, and affected proof. Untouched
   previously approved scope retains approval.
3. Give both reviewers the same target, diff, proof, authority, policy, and
   boundaries above. Keep each brief under 400 words and begin it with
   `Assigned role: <role>`.
   - `spec_reviewer` checks only missing, partial, incorrect, or extra behavior
     against cited authority.
   - `standards_reviewer` checks correctness, failure paths, policy, cleanup,
     zero legacy, duplicate ownership, unnecessary machinery, and the smell
     baseline without inventing product obligations.
   - Standards returns one compact `Minimum solution` line naming the direct
     path, necessary additions, and removable additions, if any.
4. Use fresh children without history fork (`fork_context=false` on V1;
   `fork_turns="none"` on V2). Capture every non-empty child identity and wait
   for those same children. An empty bounded wait means wait again, not failure.
   Silence is not a hang; request status only without interruption. Never
   interrupt, terminate, close, or replace an active reviewer. Missing identity,
   terminal failure, interruption, or incomplete final wait blocks Review;
   root never substitutes self-review.
5. Reconcile each finding from its evidence, preserving its lens and defect
   identity. Reclassify unsupported `BLOCK` labels as observations; an
   `APPROVE` label cannot erase a verified blocker. Consolidate all verified
   blockers into one repair batch for the active Implement or Tickets
   Orchestrator owner. Their original authority covers repairs inside Repair
   scope without another confirmation. For review-only requests, report and
   stop without invoking Implement.
6. Return `Spec` and `Standards` results separately, then consolidated blockers,
   observations, and proof gaps. Approve only after every selected independent
   reviewer completed and no verified blocker or required-proof gap remains.
   Review may approve with observations. A complete Review repeats only when a
   repair cannot be isolated.

Each reviewer returns findings first, labelled `BLOCKER` or `OBSERVATION`, then
`APPROVE` or `BLOCK` with a concrete reason. Do not create durable review state,
maps, ledgers, aliases, adapters, or compatibility routes.
