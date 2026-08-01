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
3. Implement the smallest complete change in the existing owner. Delete
   superseded paths in scope; do not add aliases, wrappers, adapters, fallback
   routes, or speculative layers.
4. Run targeted proof and the smallest affected integration check.
5. Classify the settled result by content:
   - substantial: behavior or contract beyond an obvious local edit, including
     public API, persistence, auth/payment, concurrency/shared state, or
     cross-module interaction;
   - obvious local: docs, copy, formatting, mechanical config, or an obvious
     local correction with direct proof.
   A public returned-record shape change remains a substantial contract change
   even when its implementation is one line or arrives through one ticket.
6. For substantial work, invoke `$code-review`. It must launch fresh Spec and
   Standards reviewers in parallel and wait for both approvals. Obvious local
   work may skip Review.
7. After proof and every applicable review approve, create one scoped local
   commit for direct and single-ticket Implement when the scope is isolatable.
   Stage only owned paths and recheck that unrelated dirty paths remain
   unchanged. If user or repository policy explicitly forbids or reserves Git
   to another actor, return the proven uncommitted diff.

Missing proof, failed or timed-out review, dirty overlap, or unisolatable scope
produces no affected staging or commit. Never push or open a PR without separate
authority.

## Handoff

Return:

- changed and deleted files;
- observable scenarios proved;
- exact commands and results;
- skipped checks and why;
- residual risks, decision deltas, overlap, and blockers;
- Git actions performed, or explicit confirmation that none occurred.
