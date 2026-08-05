---
name: to-spec
description: Turn the current conversation and codebase context into a proportionate, human-readable product spec or PRD in the user's language without another interview. In Plan combined mode, return the draft in context without intermediate publication; in standalone use, publish durable planning context only when requested. Planning output never authorizes implementation.
---

Synthesize what is already known; do not interview the user. Produce a product
spec or PRD in the user's conversation language and preserve exact domain or
technical identifiers. The result is planning authority, never executable
delivery authority by itself.

## Modes

- **Combined flow:** Combined mode is invoked by Plan. Return the draft to Plan
  in the current context so it can pass the draft directly to `$to-tickets`.
  Do not review or publish an intermediate PRD. `$to-tickets` owns every
  remaining packet step. The approved ticket packet is the last planning
  artifact before separately authorized delivery.
- **Standalone:** publish one durable planning-context issue only when
  requested. Mark it `Artifact: planning-context`. Do not apply a triage state
  or imply implementation authority.

If synthesis exposes a new product decision, keep the PRD unapproved and return
the decision to the user. Publication alone is never approval.

Before standalone publication, read the repository's issue-tracker policy. If
no authoritative tracker or publication procedure exists, stop and ask where
to publish; do not invent one. Combined mode does not need a tracker until
`$to-tickets` prepares publication.

## Artifact Shape

Choose the smallest content that preserves product intent and proof. A narrow
bug, incident, data repair, or understood implementation correction may use a
**Fix Brief** with one to three observable stories. Otherwise use the same
template and include only sections that carry a real decision, consequence,
scope boundary, or proof obligation.

`$to-spec` does not determine implementation-ticket count. PRD length, section
count, file count, and risk do not size a later ticket packet; Plan and
`$to-tickets` retain composition and slicing ownership. Material risk
strengthens `Risk / Proof Notes`; it does not make the PRD or solution broader.
Omit that section when no material risk exists.

## Process

1. Explore the repo if needed. Use project domain language, respect relevant
   ADRs, and reuse cited `$research` artifacts. Keep unsupported external facts
   open instead of converting them into product scope.

2. Sketch the seams at which the outcome will be proved. Existing seams should
   be preferred to new ones. Use the highest seam possible. If new seams are
   needed, propose them at the highest point you can. The fewer seams across the
   codebase, the better; the ideal number is one. Record only seams that
   materially define behavior, proof, or ownership, and ask the user only when
   a seam choice changes scope, risk, or ownership.

3. Write the template below, then follow the requested mode. A standalone
   planning-context issue is marked `Artifact: planning-context`; it is not an
   implementation ticket and receives no triage state.

<spec-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## Decisions For Approval

The product, behavior, scope, ownership, rollout, and risky trade-off decisions
the user is being asked to approve. Separate confirmed decisions from open
decisions. If implementation discovery later changes one of these decisions,
the delivery workflow must return a decision delta instead of guessing.

## Non-Obvious Consequences

Important hidden state, background behavior, failure behavior, limitations, or
trade-offs that the user would not infer from the happy-path solution. Write
`None` only when there genuinely are no material consequences.

## User Stories

A numbered list of distinct, observable user stories in the format:

1. As an <actor>, I want a <feature>, so that <benefit>

Include only stories that change scope, acceptance, or proof; do not create
variants to make the list look complete. For a Fix Brief spec, use 1-3 stories
or operational scenarios that directly explain the bug, repair, or regression
risk.

## Implementation Decisions

A list of already approved implementation constraints or technical decisions
that materially protect product behavior. Omit architecture vocabulary when
ownership and public seams do not change.

Do NOT include specific file paths or code snippets. They may end up being
outdated very quickly.

Exception: if a prototype produced a snippet that encodes a decision more
precisely than prose can, inline it within the relevant decision and note
briefly that it came from a prototype. Trim to the decision-rich parts — not a
working demo, just the important bits.

## Testing Decisions

A list of testing decisions that were made. Describe what makes a good
behavior-level test, which modules will be tested, and relevant test prior art
in the codebase.

## Out of Scope

A description of the things that are out of scope for this spec.

## Risk / Proof Notes

Required only when material risk exists:

- Primary risk:
- Key invariants:
- Expected proof:
- Review focus:
- Out-of-scope risk:

## Further Notes

Any further notes about the feature.

</spec-template>
