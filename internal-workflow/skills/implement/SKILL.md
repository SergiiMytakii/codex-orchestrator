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
  scope. Stop and ask the user before making any behavior, ownership, or
  boundary decision not explicitly settled by the approved request;
  implementation approval does not authorize decisions discovered during
  implementation.
- **Proof:** prove the final observable outcome through the real caller seam.
  Authority-defined proof cannot be replaced by weaker tests or a completion
  claim.

## Context Ownership

Direct non-ticket work remains in the current root context.

For one executable ticket, root launches exactly one fresh `implementer` child.
The assignment must include:

- the complete ticket;
- bounded Parent acceptance context and a read-only complete-PRD reference;
- applicable repository policy;
- bounded write scope and exclusions;
- required proof and explicit delivery/Git boundaries.

Begin with `Assigned role: implementer`, name the ticket as the only executable
scope, and put its complete body before Parent context. Include the complete
Parent only when its relevant constraints cannot be separated safely.

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
   Treat a broad-check failure as non-blocking only when targeted proof passes
   and the failure is proven unrelated to and outside the current diff; report
   the skipped check and residual risk.
5. Classify the settled result by content:
   - substantial: behavior or contract beyond an obvious local edit, including
     public API, persistence, auth/payment, concurrency/shared state, or
     cross-module interaction;
   - obvious local: docs, copy, formatting, mechanical config, or an obvious
     local correction with direct proof.
   A public returned-record shape change remains a substantial contract change
   even when its implementation is one line or arrives through one ticket.
6. For substantial work, invoke `$code-review` on the settled proof. The first
   invocation reviews the complete authorized result with one fresh Spec
   reviewer and one fresh Standards reviewer in parallel. Obvious local work
   may skip Review.
7. Handle each reviewer result:
   - reviewer findings are evidence, not implementation authority. Before any
     repair, independently verify **Authority** (the existing authorized
     obligation being restored), **Trigger** (the concrete failing path or
     unmet requirement), **Impact** (the observable defect or proof gap in the
     authorized result), and **Minimal repair** (the least change that restores
     that obligation). State one short evidence-backed sentence connecting
     those four facts before editing;
   - classify the result without collapsing failure paths: a new obligation,
     changed authorized outcome, ownership or architecture decision, or repair
     of a neighboring problem is a Decision Delta and stops for authority. A
     missing Authority, Trigger, or Impact makes the finding unverified and it
     receives no repair; classify it as an observation unless required proof
     cannot establish the authorized result, in which case the proof gap blocks
     completion without authorizing code. Only a finding with all four facts
     established is a verified blocker eligible for repair. Apply the same gate
     to UI, backend, persistence, concurrency, infrastructure, and every other
     change type;
   - if optional machinery added by the current diff causes the problem,
     remove it instead of expanding the outcome to support it;
   - consolidate every verified blocker from the current review into one
     repair batch. The repair may widen the investigated impact cone and touch
     necessary neighboring files within explicit exclusions and preservation
     boundaries, but it must not widen the authorized outcome. The active
     owner applies it: root for direct work or the ticket's existing
     `implementer` for single-ticket work. Do not ask for confirmation or
     create a second implementer when the gate proves the repair is already
     authorized.
8. After each repair batch, rerun affected proof and invoke `$code-review` on
   the new revision. Run only the affected lens: a Spec-only repair returns to
   Spec, a Standards-only repair returns to Standards, and a mixed or
   unisolatable repair returns to both lenses. Limit targeted Review to the
   repair delta, direct impact cone, and affected proof; untouched approval
   remains valid. Repeat until approval. Reviewer count is not a stop condition;
   use a complete two-lens Review only when the repair cannot be isolated.
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
