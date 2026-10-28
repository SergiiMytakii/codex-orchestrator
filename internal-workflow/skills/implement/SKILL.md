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
  Preserve all pre-existing changes and user-owned runtimes. Work on top of
  existing changes, including in overlapping files, without reverting or
  altering them or asking for confirmation solely because of overlap. Stop on
  an unresolvable conflict or a decision that changes behavior, ownership, or
  boundaries.
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

Before context compaction, preserve the current diff scope, completed proof,
active process handles, applicable constraints, and next action in the
continuation summary. Resume from that state; reread sources only when missing,
changed, or needed to resolve uncertainty. Do not create a separate tracking file.

## Execution

1. Confirm authority, repository policy, current status, owner code, caller seam,
   and the smallest credible proof. Record pre-existing changes and keep unrelated
   paths untouched and unstaged. Verify material premises independently of the
   proposed implementation; resolve unsupported or contradicted premises before edits.
   Before editing, apply the [Design Decisions rule](../../docs/agents/coding-skill-routing.md#design-decisions)
   in the normative coding route. Pass settled design constraints to any
   assigned implementer.
   For UI work, load `$ui-evidence-proof` now, inspect the supplied design, and
   establish its comparison criteria before implementation.
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
4. Verify the final change:
   - **Coverage:** run the smallest checks covering changed behavior and known
     failure conditions. A narrower check replaces a broader run only when it
     preserves the relevant trigger, state, and assertions; isolated CI groups
     do not prove cross-group interactions. Run the full suite when repository
     policy or the affected contract requires it, or narrower checks cannot cover
     the known failure. After a repair, rerun affected checks; repeat the full
     suite only when that reason still applies.
   - **Reuse:** retain completed results while the checked code, fixtures,
     configuration, and relevant runtime state remain unchanged. Rerun only for
     affected changes, inconclusive evidence, repeatability requirements, or an
     explicit policy gate. A commit alone does not invalidate results. Required
     diagnosis-handoff reproduction in step 2 still applies.
   - **UI:** complete `$ui-evidence-proof` against the final rendered result.
     Fix in-scope differences and repeat capture/comparison until it passes;
     tests or an uninspected screenshot cannot replace this gate.
   - **Waiting:** retain the running check's process handle and use the tool's
     bounded wait or continuation operation. Inspect logs on failure, unexpected
     delay, or when needed for a decision. If status polling is the only option,
     space polls according to expected duration. Do not launch a duplicate check
     while the original is running.
5. Classify the actual change, not its size or subsystem:
   - substantial: behavior or contract changes beyond an obvious local edit,
     including public APIs, persistence, auth/payment, concurrency/shared state,
     or module interactions;
   - obvious local: docs, copy, formatting, mechanical config, or a straightforward
     correction with direct proof.
   A returned-record shape change is substantial even when one line.
   Test-only fixture or selector corrections may use direct proof when coverage
   and expected behavior are preserved. Changes to accepted outcomes require
   checking the underlying contract.
6. For substantial work, invoke `$code-review` on the settled proof. The first
   invocation reviews the complete authorized result with one fresh Spec
   reviewer and one fresh Standards reviewer in parallel. Obvious local work
   may skip Review.
7. For each finding, independently verify **Authority**, **Trigger**, **Impact**,
   and **Minimal repair**. Before editing, connect the authorized obligation,
   observed failure, impact, and smallest repair in one evidence-backed sentence.
   - A new obligation, changed outcome, or unresolved ownership/architecture
     decision requires authority. An independent neighboring problem is outside scope.
   - An unsupported finding is an observation and receives no repair. Missing
     required proof blocks completion but does not authorize speculative code.
   - Apply verified blockers as one repair batch through the existing owner:
     root for direct work or the ticket's existing implementer. Necessary neighboring
     files may be included within exclusions and preservation boundaries without
     expanding the authorized outcome. Already-authorized repairs need neither
     another confirmation nor a second implementer.
   - Remove optional machinery causing the defect before extending it.
8. After a repair batch, rerun affected proof and request fresh `$code-review`
   of the repair delta, repaired blockers, and direct impact: Spec, Standards,
   or both as affected; mixed or unisolatable impact requires both.
   Preserve untouched approvals. Repeat until approval; repeat complete Review
   only when repair impact cannot be isolated. Reviewer count is not a stop condition.
9. After proof and every applicable review approve, create one scoped local
   commit for direct and single-ticket Implement when the scope is isolatable.
   Stage only owned paths and recheck that unrelated dirty paths remain
   unchanged. If user or repository policy explicitly forbids or reserves Git
   to another actor, return the proven uncommitted diff.

Missing proof, terminally failed or interrupted review, or
unisolatable scope produces no affected staging or commit. Never push or open a
PR without separate authority. When drafting or updating an authorized PR
body, read and apply `$pr` using the settled diff and actual proof.

## Handoff

Return:

- changed and deleted files;
- observable scenarios proved;
- exact commands and results;
- skipped checks and why;
- residual risks, decision deltas, overlap, and blockers;
- Git actions performed, or explicit confirmation that none occurred.
