---
name: plan-review
description: Deep adversarial read-only review of a settled delivery plan, including a compact local plan or complete publish-ready ticket packet. Use when the user asks to review, challenge, stress-test, or find breakage in a plan, or when Plan invokes an explicitly requested or repository-required plan review. Return findings only; never rewrite the plan or implement it.
---

# Plan Review

Review one settled local plan or complete publish-ready Parent and ticket packet.
Plan remains the sole composition owner. Review returns findings; it never edits,
rewrites, saves, approves on the user's behalf, or implements the plan.

## Inputs and Reviewer

Require product authority, the complete settled plan, applicable repository
policy, explicit exclusions, and the strongest relevant code, data, test, or
runtime evidence available. Provide authority, plan, evidence, and exclusions
separately to exactly one fresh `plan_reviewer` without conversation history;
begin the assignment with `Assigned role: plan_reviewer`. The reviewer writes nothing.

For material technical claims, verify cited sources and inspect the relevant
owner/caller path where needed to challenge feasibility. The plan and tests
derived from its assumptions are not independent evidence. Distinguish verified
facts, proposals, and unresolved assumptions. Review validates Plan's discovery;
it does not complete missing discovery or design the solution.

The first review covers the complete applicable impact surface. For local plans,
use a fresh reviewer for repaired findings, changed text, direct impact, and
affected evidence. Reopen unchanged scope only for a concrete causal risk or
changed outcome/owner; use complete review when impact cannot be isolated.
Ticket packets follow To Tickets' whole-packet re-review requirements.

Capture the non-empty reviewer identity and wait for that reviewer to return
a terminal verdict. Missing identity, interruption, failure, or an incomplete
final wait blocks review. Plan must not substitute self-review or save an
artifact as reviewed without completed independent review.

## Minimum Solution and Breakage

Reconstruct the smallest complete path through existing owners and seams.
Challenge additions introducing ownership, state, contracts, compatibility,
workflows, proof-only machinery, prerequisite refactors, or tickets. Require
evidence that the direct path cannot satisfy an authorized obligation, existing
invariant, or proven failure path. Unnecessary additions are scope blockers;
prefer deletion or narrowing. Identify the added surface as Trigger, its
unnecessary ownership or operational cost as Impact, and the smallest correction.
Preserve complexity required by concrete evidence, not hypothetical consumers,
races, or exhaustive edge-case matrices.

Inspect every applicable lens:

- requirements and product behavior, including missing and extra outcomes;
- existing callers and neighboring flows, ownership, and public contracts;
- persistence and existing data, including in-flight or historical state;
- concurrency and asynchronous boundaries around shared state;
- failure, retry, cancellation, idempotency, and recovery behavior;
- security and privacy for identities, permissions, secrets, or personal data;
- migration, rollout, rollback, and compatibility where versions can coexist;
- whether proof can pass while the claim is false.

Try to falsify critical claims with relevant questions:

- What source evidence contradicts the proposed owner, behavior, or feasibility?
- Which unconfirmed assumption would force a different implementation?
- What realistic input, existing state, or partial failure breaks the outcome?
- Can acceptance pass while the promised behavior is still wrong?
- Can the current owner solve this without the proposed new mechanism?
- What decision is being silently delegated to the implementer?

Investigate answers available in repository evidence. Ask the user only for
material choices or facts the reviewer cannot establish. Use questions to expose
gaps, not prescribe more architecture. Do not invent findings or require a fixed
number of questions.

For ticket packets, also trace source fidelity, ticket executability, real
dependency edges, and whether each acceptance proof observes its Parent claim.
Review the final packet, not the intermediate PRD.

Complete every applicable lens and return all material findings. Clean lenses
need no output. Do not emit N/A entries, duplicate findings, or stop after
representative defects.

## Finding Threshold

Classify each distinct finding as exactly one of:

- `BLOCKER`: evidence establishes **Authority**, **Trigger**, **Impact**, and
  **Minimal correction** within the authorized outcome. Name the smallest
  necessary correction, not a broader design.
- `QUESTION`: an unresolved material choice, premise, or fact. State what answer
  changes the plan and whether it needs a user decision, repository evidence,
  or external discovery. Do not ask the user to resolve facts available in code.
- `OBSERVATION`: optional hardening, cleanup, architecture preference, or a
  plausible risk without a concrete trigger and impact. It cannot change the
  plan automatically. Do not turn speculative concerns into required scope or
  blocking questions without showing their material effect on the plan.

## Output

Return, in order:

1. non-empty `BLOCKER`, `QUESTION`, and `OBSERVATION` findings, most important first;
2. a compact `Minimum solution` assessment of required, removable, and unresolved parts;
3. `APPROVE` only after completed independent review with no verified blocker or
   unresolved question/evidence gap changing feasibility, behavior, ownership,
   or acceptance; otherwise `NEEDS_WORK` with the exact reason.

Findings only. Do not return a rewritten plan, expanded implementation steps,
or a second planning artifact. Do not repeat unchanged plan content or present
questions/observations as required scope. For a review-only request, report and
stop. Return findings to the invoking Plan or To Tickets owner for authorized
reconciliation; Plan retains composition ownership. Do not start implementation.
