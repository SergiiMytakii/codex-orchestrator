---
name: plan-review
description: Deep adversarial read-only review of a settled delivery plan, including a compact local plan or complete publish-ready ticket packet. Use when the user asks to review, challenge, stress-test, or find breakage in a plan, or when Plan invokes an explicitly requested or repository-required plan review. Return findings only; never rewrite the plan or implement it.
---

# Plan Review

Perform an adversarial read-only review of one settled delivery plan: either a
compact local plan or a complete publish-ready Parent and ticket packet.
`Plan` remains the sole composition owner. Review may discover defects and ask
uncomfortable questions, but it never edits, rewrites, saves, approves on the
user's behalf, or implements the plan.

## Inputs and reviewer

Require the user request or other product authority, the complete settled plan,
applicable repository policy, explicit exclusions, and the strongest relevant
code, data, test, or runtime evidence already available. Inspect additional
repository evidence only where it can confirm or reject a material premise.

Launch exactly one fresh `plan_reviewer` without prior conversation history.
Begin the assignment with `Assigned role: plan_reviewer` and provide authority,
plan, evidence, and exclusions separately. The reviewer performs no writes.

The first review covers the complete impact surface. After reconciliation, a
fresh reviewer checks only the repaired findings, changed text, direct impact,
and affected evidence. Reopen unchanged scope only when the repair creates a
concrete causal risk.

Completion: the reviewer returns a terminal verdict for its assigned scope.

Missing identity, interruption, failure, or an incomplete final wait blocks
review. Plan must not substitute self-review or save an artifact as reviewed.

## Minimum-first review

First reconstruct the smallest complete path through existing owners and seams.
Challenge each proposed new owner, state, abstraction, workflow, compatibility
path, prerequisite refactor, or ticket. Keep it only when authority, an existing
invariant, or a proven failure path requires it and the direct path cannot work.
If removing it preserves authorized behavior, invariants, and credible proof,
require removal.

Treat unsupported runtime ownership, persisted state, public contracts,
compatibility paths, operational workflows, and proof-only machinery as scope
blockers. Name the added surface as the Trigger, its unnecessary ownership or
operational cost as the Impact, and deletion or narrowing as the Minimal
correction.

After the deletion challenge, inspect every applicable breakage lens:

- requirements and product behavior, including missing and extra outcomes;
- existing callers and neighboring flows, ownership, and public contracts;
- persistence and existing data, including in-flight or historical state;
- concurrency and asynchronous boundaries around shared state;
- failure, retry, cancellation, idempotency, and recovery behavior;
- security and privacy for identities, permissions, secrets, or personal data;
- migration, rollout, rollback, and compatibility where versions can coexist;
- whether proof can pass while the claim is false.

Ask what assumption would make the plan unsafe, what existing behavior it could
silently change, what evidence is missing, and which user decision the reviewer
cannot make. Use uncomfortable questions to expose gaps, never to propose more
architecture.

Completion: every applicable lens was inspected. Return a finding only for a
defect, unresolved decision, or useful evidence-backed observation; a clean
lens needs no output. Do not emit `N/A` or invent findings to prove coverage.

For a ticket packet, also trace source fidelity, ticket executability, real
dependency edges, and whether each acceptance proof observes its Parent claim.
This is one review of the final packet, not a second review of the intermediate
PRD.

## Finding threshold

Classify each distinct finding as exactly one of:

- `BLOCKER`: evidence establishes **Authority**, **Trigger**, **Impact**, and
  **Minimal correction**. The correction names the smallest necessary change;
  it does not prescribe a broader design.
- `QUESTION`: a product choice, ownership choice, unsupported material premise,
  or missing external fact that the reviewer cannot decide. State what answer
  changes the plan.
- `OBSERVATION`: optional hardening, cleanup, architecture preference, or a
  plausible risk without a concrete trigger and impact. It cannot change the
  plan automatically.

A hypothetical race, future consumer, or exhaustive edge-case matrix does not
justify added machinery. Preserve complexity only when evidence establishes its
necessity; otherwise prefer deletion or narrowing.

Completion: every blocker contains all four facts, and no question or
observation is presented as required scope.

## Output

Return, in this order:

1. non-empty `BLOCKER`, `QUESTION`, and `OBSERVATION` findings, most important
   first;
2. a compact `Minimum solution` assessment naming required, removable, and
   unresolved parts;
3. `APPROVE` when no blocker or unanswered plan-changing question remains,
   otherwise `NEEDS_WORK` with the exact reason.

Findings only. Do not return a rewritten plan, expanded implementation steps,
or a second planning artifact. Do not repeat unchanged plan content. For a
review-only request, report and stop. When called by `Plan`, return control to
that same Plan owner for any authorized minimal revision and saving.
