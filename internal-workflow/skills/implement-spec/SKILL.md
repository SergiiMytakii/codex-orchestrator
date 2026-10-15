---
name: implement-spec
description: Implement an approved spec and multi-ticket dependency graph with fresh workers, root-owned integration checkpoints, and cumulative Spec and Standards review. Route a single ticket to Implement.
---

# Implement Spec

Deliver the complete approved Parent through its executable child tickets.
This skill owns graph scheduling, integration, and final Parent acceptance.
A single deterministic ticket routes to `$implement`; planning stays with Plan.

## Authority and ownership

Require the complete Parent PRD, complete tickets, authoritative tracker blockers,
repository policy, bounded child scopes, and proof of the requested behavior.
Root prepares one clean isolated integration worktree and pinned baseline for
each repository. Root is the only integrator and Git writer. Workers perform
no Git action. Push, PR, tracker writes, merge to the destination branch, and
release each require separate authority.

Every child receives a unique fresh `implementer`. The complete child ticket is
its only executable scope; bounded Parent context is acceptance authority.
Root never implements a child, mixes ticket boundaries, or edits a worker repair.
An incomplete ticket packet or changed product outcome returns for a decision.

## Integration state

Keep one in-memory integration ledger keyed by stable authoritative repository
identity. For each repository record its integration worktree, pinned baseline
SHA, ordered confirmed checkpoint SHAs, `recovery_commits`, and final checkpoint
and exact `baseline..final` range. Also track each active child's worker identity,
workspace, base checkpoint, write scope, and proof resources in memory.
Never serialize it to a file, database, branch, commit, tracker field, comment,
tag, or other durable state. Git contains product checkpoints, not run records.

## Execution

Read [delegate-integrate.md](references/delegate-integrate.md) before dispatch;
it owns worker briefs, workspace isolation, result transfer, and scheduling.

1. Pin each repository baseline, confirm clean integration boundaries, reread
   Parent, tickets and native blocker links, and identify the ready frontier.
   Done when every ready ticket has a repository, bounded scope, and proof seam.
2. If several tickets share a material unknown, optionally use a bounded
   read-only `explorer` or the research skill for external contracts. Give workers
   source pointers and verified findings; this does not alter ticket authority.
   Done when the unknown is resolved or its affected tickets remain blocked.
3. Prepare isolated worker worktrees at confirmed checkpoints when supported;
   otherwise use the serialized or disjoint shared-worktree path in the reference.
   Sequence any dependency or overlap, including proof resources and contracts.
   Launch one fresh worker per ready child and wait for that same identity.
   Done when each assigned child has an explicit workspace, base, scope and owner.
4. Root transfers only completed, inspected worker output, then runs the ticket's
   behavioral checks and the smallest affected combined proof on integrated bytes.
   Reuse suitable existing tests; use `$tdd` where a meaningful failure is possible
   and direct proof otherwise. Structural checks of this skill do not prove the
   delivered product. Done when scope and current integrated proof both pass.
5. Create a scoped root checkpoint naming the Parent and exact tickets, confirm
   it from Git, and update the in-memory ledger. Recalculate readiness after each
   settled checkpoint. Release an independent successor without waiting for an
   unrelated isolated worker; shared proof or coupled repositories settle together.
   Done when all prerequisites and proof for each released child are confirmed.
6. After all tickets settle, read [finish-delivery.md](references/finish-delivery.md).
   Compare the complete Parent with every cumulative repository range and activate
   one fresh `spec_reviewer` and one fresh `standards_reviewer` on the final revision.
   No per-ticket delivery Review runs for graph children. Reviewer verdicts are
   evidence, not authority. Done when both completed independent reviews leave
   no verified blocker or required-proof gap on the cumulative result.

## Failure and recovery

On uncertain ownership, interruption, a lost commit response, or partially settled
coupled repositories, read [stop-completion.md](references/stop-completion.md)
before retrying. Preserve confirmed checkpoints and ambiguous bytes; block affected
successors. Recover from authoritative sources and Git rather than narration.

## Repairs and handoff

[finish-delivery.md](references/finish-delivery.md) owns blocker verification,
consolidated repairs through fresh ticket workers, targeted re-review, and delivery.
Report repository ranges, checkpoints, Parent coverage, proof, unresolved blockers,
skipped checks, and exact authorized Git and tracker actions. Clean up only root-created
worker worktrees whose workers have stopped and whose complete output is integrated
or explicitly disposable; preserve unresolved work and user-owned worktrees.
