---
name: implement
description: Implement a clear authorized feature, fix, obvious local edit, or executable ticket through observable proof and applicable Review. This is the single coding execution owner.
---

# Implement

Implement the authorized outcome. Do not reopen settled product decisions or
create a replacement plan, spec, ticket, workflow state, or compatibility path.

## Kernel

- **Authority:** perform only the requested outcome and authorized delivery
  actions. Tracker publication is not implementation authority. Normal direct
  and single-ticket Implement authority includes one scoped local commit after
  proof and applicable Review unless user or repository policy explicitly
  forbids or reserves Git. Push and PR are separate and never implicit.
- **Preservation:** read repository policy and current status before edits.
  Preserve unrelated work and user-owned runtimes. Stop on overlapping dirty
  scope or a decision that changes behavior, ownership, or boundaries.
- **Proof:** prove the final observable outcome through the real caller seam.
  Authority-defined proof cannot be replaced by weaker tests or a completion
  claim.

## Context Ownership

Direct non-ticket work remains in the current root context.

For one executable ticket, root launches exactly one fresh `implementer` child.
The assignment must include:

- the complete ticket;
- the complete Parent PRD;
- applicable repository policy;
- bounded write scope and exclusions;
- required proof and explicit delivery/Git boundaries.

The assignment begins with `Assigned role: implementer` so the requested role,
fresh child identity, and completed wait can be verified independently.

The worker performs no Git actions and returns changed files, observable proof,
skipped checks, risks, decision deltas, overlap, and blockers. Root verifies a
non-empty fresh child identity, waits for that same child to complete, checks
the assignment inputs, and integrates only isolated output. A single ticket
never activates the graph coordinator.

## Execution

1. Confirm authority, repository policy, current status, owner code, caller
   seam, and the smallest credible proof. Record pre-existing dirty paths; an
   overlap with owned scope blocks edits, while disjoint dirty paths remain
   untouched and unstaged.
2. Use `$tdd` where possible. Otherwise establish direct pre-change evidence
   when useful and apply the narrowest observable proof after the edit.
   When a diagnosis handoff exists, rerun the unchanged reproduction command
   before editing and require the same diagnosed failure, fixture digest, and
   symptom. Then make the first durable regression test at the natural public
   seam fail for the diagnosed symptom before applying the fix. If the handoff
   is stale, incomplete, unexpectedly green, or reproduces another symptom,
   stop and return the evidence gap to Diagnosis instead of substituting a
   nearby signal.
3. Implement the smallest complete change in the existing owner. Delete
   superseded paths in scope; do not add aliases, wrappers, adapters, fallback
   routes, or speculative layers.
4. Run targeted proof and the smallest affected integration check.
   During substantial work, run the relevant typecheck or single test file as
   the seam settles. Run a full suite once at the end only when repository
   policy, risk, or the changed shared contract makes it proportionate.
5. Classify the settled result by content:
   - substantial: behavior or contract beyond an obvious local edit, including
     public API, persistence, auth/payment, concurrency/shared state, or
     cross-module interaction;
   - obvious local: docs, copy, formatting, mechanical config, or an obvious
     local correction with direct proof.
   A public returned-record shape change remains a substantial contract change
   even when its implementation is one line or arrives through one ticket.
6. For substantial work, invoke `$code-review` on the settled proof. The first
   invocation reviews the complete authorized result and launches one fresh
   Standards reviewer. Obvious local work may skip Review.
7. Handle each reviewer result:
   - non-blocking observations do not require repair or prevent approval;
   - only a concrete correctness defect, missing obligation, required-proof
     gap, or real ownership or runtime conflict blocks;
   - consolidate every blocker from the current review into one repair
     batch. Stop only on an out-of-scope item, Decision Delta, unresolved
     ambiguity, or another concrete authority or preservation boundary.
     Otherwise the original Implement authority already covers the repair and
     the active owner applies it: root for direct work or the ticket's existing
     `implementer` for single-ticket work. Do not ask the user for confirmation
     and do not create a second implementer for the same ticket.
8. After each repair batch, rerun affected proof and invoke `$code-review` on
   the new revision. Review only the repair delta and its direct impact cone:
   the repaired blockers, changed files and hunks, directly affected caller
   seams and invariants, and current affected proof. Untouched parts of the
   previously reviewed result retain their approval. Repeat this repair and
   targeted Review loop until approval; reviewer count is never a stop
   condition or an authority boundary. Escalate to a complete Review only when
   the repair cannot be isolated from previously approved scope. An empty wait
   means wait again. Never interrupt or replace a reviewer to accelerate a
   commit; interrupted review blocks and is not code approval.
9. After proof and every applicable review approve, create one scoped local
   commit for direct and single-ticket Implement when the scope is isolatable.
   Stage only owned paths and recheck that unrelated dirty paths remain
   unchanged. If user or repository policy explicitly forbids or reserves Git
   to another actor, return the proven uncommitted diff.

Missing proof, terminally failed or interrupted review, dirty overlap, or
unisolatable scope produces no affected staging or commit. Never push or open a
PR without separate authority.

## Handoff

Return:

- changed and deleted files;
- observable scenarios proved;
- exact commands and results;
- skipped checks and why;
- residual risks, decision deltas, overlap, and blockers;
- Git actions performed, or explicit confirmation that none occurred.
