---
name: code-review
description: Read-only Review entrypoint for a settled diff. Substantial changes receive independent Spec and Standards review; targeted repair review runs only the affected lens.
---

# Review

Review a settled change through two independent lenses:

- **Spec:** missing, incorrect, partial, or extra behavior against cited authority.
- **Standards:** correctness, failure paths, repository policy, maintainability,
  cleanup in scope, duplicate ownership, and unnecessary machinery.
  Read [standards-smells.md](references/standards-smells.md); report smells as
  observations unless evidence meets the blocker threshold. Repository policy
  takes precedence; do not duplicate tooling-enforced findings.

Review is inspection-only. Never edit, repair, stage, commit, push, or open a PR.
Use Implement's change classification to determine whether independent Review
is required. Explicit review requests and repository requirements still apply.

## Boundaries

- **Authorized outcome:** the request, issue, or Parent PRD plus existing
  invariants and mandatory repository rules.
- **Impact cone:** callers, data, runtime, and proof surfaces that may be
  inspected to establish effects. Inspection creates no authority.
- **Repair scope:** the smallest change that restores a proven obligation,
  invariant, or mandatory rule without widening the authorized outcome.

## Evidence and Findings

Authority defines obligations, not facts about the current system. Verify
material premises independently of the implementation and its derived tests;
repetition across artifacts is not corroboration.

A verdict is evidence, not authority. A `BLOCKER` requires a concrete defect
or required-proof gap linked to an authorized obligation, invariant, or
mandatory rule. Include the obligation source, file/line, trigger, impact,
and evidence. Preferences, hypothetical hardening, and unrelated improvements
are `OBSERVATION`s.

Runtime behavior, ownership, persisted state, compatibility, or public contracts
added by the diff are scope blockers when neither the authorized outcome nor a
proven failure path requires them. Private implementation preferences remain
observations unless they cause a concrete defect.
For optional machinery causing a defect, recommend removal before expansion;
extend it only when required by the authorized outcome.

## Process

1. **Prepare:** pin an existing baseline and settled target; verify the comparison
   is valid and non-empty. Collect the exact diff, changed files, proof, authority
   source, and repository policy. Missing required authority or proof is a gap;
   never silently skip a required lens.
2. **Select:** initial Review launches one fresh `spec_reviewer` and one fresh
   `standards_reviewer` in parallel. Targeted Review runs only the affected lens:
   Spec for requirement coverage or behavior; Standards for correctness,
   invariants, architecture, or mandatory rules; both for mixed or unisolatable
   impact. For targeted Review, include the previous reviewed revision, repair
   delta, repaired blockers, direct impact cone, and affected proof. Untouched
   approvals remain valid. Repeat complete Review only when repair impact cannot
   be isolated.
3. **Assign:** give each selected reviewer the same applicable inputs and
   boundaries above, with its lens duties. Keep each brief under 400 words and
   begin it with `Assigned role: <role>`.
4. **Wait:** use fresh children without history fork (`fork_context=false` on V1;
   `fork_turns="none"` on V2). Capture every non-empty child identity and wait
   for those same children. An empty bounded wait means wait again, not failure.
   Silence is not a hang; request status only without interruption. Never
   interrupt, terminate, close, or replace an active reviewer. Missing identity,
   terminal failure, interruption, or incomplete final wait blocks Review;
   root never substitutes self-review.
5. **Reconcile:** assess each finding from its evidence, preserving its lens and
   defect identity. Reclassify unsupported blocker labels as observations; an
   `APPROVE` label cannot erase a verified blocker. Consolidate verified blockers
   into one repair batch for the active implementation owner. Existing authority
   covers repairs within Repair scope without another confirmation. For
   review-only requests, report and stop without invoking Implement.

## Output

Each reviewer returns findings labelled `BLOCKER` or `OBSERVATION`, followed by
`APPROVE` or `BLOCK` with a concrete reason. Standards also returns one compact
`Minimum solution` line naming the direct path, necessary additions, and
removable additions, if any.

The coordinator reports selected lens results separately, then consolidated
blockers, observations, and proof gaps. Approval requires every selected
independent reviewer to complete and no verified blocker or required-proof gap.
Observations do not prevent approval.

Do not create durable review state, maps, ledgers, aliases, adapters, or
compatibility routes.
