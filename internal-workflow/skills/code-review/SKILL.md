---
name: code-review
description: Read-only Review entrypoint for a settled diff. Substantial changes receive one fresh Standards reviewer covering requirement fidelity and correctness.
---

# Review

Review the settled change against two questions:

- **Spec:** does it implement the authorized request, issue, or Parent PRD
  completely and without scope drift?
- **Standards:** is it correct, maintainable, consistent with repository policy,
  and free of legacy paths, duplicate ownership, compatibility residue, or
  unnecessary machinery?

Gate: fresh `standards_reviewer` without history fork (`fork_context=false` on
V1; `fork_turns="none"` on V2) → child ID → wait → result. Any missing step is
`BLOCK`; never claim approval.

Review is inspection-only. It never edits, mutates, or repairs repository state,
regardless of whether a finding is small or material.

## Finding threshold

A finding may `BLOCK` only when the reviewer demonstrates a concrete
correctness defect, missing obligation, required-proof gap, or real ownership
or runtime conflict. Give the file and line, trigger or unmet requirement,
impact, and evidence.

Everything else is a non-blocking observation: a heuristic smell, optional
cleanup, general improvement, uncertain concern, or preference without a
concrete impact. A Fowler smell is always a judgement call and remains a
non-blocking observation unless separate evidence proves one of the blocking
categories above. Repository policy overrides the smell baseline, and tooling
already enforcing a rule makes a duplicate observation unnecessary. Read
[standards-smells.md](references/standards-smells.md) for that baseline.

## Applicability

Review is required when behavior or contract goes beyond an obvious local edit,
including public API, persistence, auth/payment, concurrency/shared state, and
cross-module interaction. Docs, copy, formatting, mechanical config, and an
obvious local correction may complete with direct proof unless the user asks
for Review explicitly.

## Process

1. Pin the review target and mode:
   - initial Review receives the complete settled result, authority, repository
     policy, changed files, and proof;
   - targeted repair Review receives the last reviewed revision as its
     baseline, the repair delta, repaired blockers, direct impact cone, and
     affected proof. Review only that delta and its directly affected caller
     seams and invariants. Untouched previously approved scope remains approved.
   Use a complete Review only when the repair impact cannot be isolated.
2. Launch exactly one fresh `standards_reviewer`. It receives the target,
   authority, changed files, proof, the complete relevant
   request/issue/Parent PRD, repository policy, and a brief to check requirement
   fidelity, correctness, failure paths, cleanup, zero legacy, duplicate
   ownership, unnecessary scripts, and the linked smell baseline. It reports
   missing, partial, incorrect, or extra behavior and distinguishes concrete
   defects from judgement calls. Begin the brief with `Assigned role:
   standards_reviewer`.
3. Capture its non-empty child identity and wait for that same child.
   A timeout, failed child, missing identity, or incomplete wait blocks approval.
   Root never substitutes self-review.
4. Verify every finding against the review target and its trigger path, preserve its
   defect identity, and classify it with the threshold above. Return
   observations separately and consolidate every blocker from the review into
   one repair batch for the caller. When Review was invoked by an active
   Implement or Tickets Orchestrator, that caller's original authority already
   covers every verified in-scope repair. Return the batch to that active owner
   with its preservation, proof, targeted fresh Review, and Git lifecycle. Do
   not ask the user for confirmation or require separate repair authority.
   If the current request is review-only, report the findings and stop; do not
   invoke Implement or infer repair authority.
5. Approval requires the completed reviewer to return `APPROVE` for the target
   with no blocker or required-proof gap. Initial approval covers the
   complete settled result; targeted repair approval covers the delta and its
   impact cone while preserving approval for untouched scope. Review may
   approve while reporting non-blocking observations. A failed or timed-out
   child, missing identity, incomplete wait, or non-approval blocks Review;
   root does not replace it with self-review.
6. Review performs one reviewer invocation and returns its result.
   Review remains read-only: it does not repair, start another reviewer,
   edit, stage, commit, push, or open a PR.

## Reviewer Output

Each reviewer returns findings first with file/line, concrete trigger or missing
obligation, impact, and evidence. Label each item `BLOCKER` with one blocking
category or `OBSERVATION`. If there are no blockers or required verification
gaps, it ends with `APPROVE`, even when it reports observations. Otherwise it
ends with `BLOCK` and the concrete reason.

The coordinator returns both review questions, observations, consolidated blockers,
proof gaps, and `APPROVE` only when the reviewer approves. It reports `BLOCK` only for a
concrete blocker, required-proof gap, or failed reviewer without repairing it.
Do not create durable review state, maps, ledgers, aliases, adapters, or
compatibility routes.
