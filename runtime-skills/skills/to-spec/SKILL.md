---
name: to-spec
description: Turn the current conversation and codebase context into a proportionate product spec or PRD and publish it to the project issue tracker. Use when the user wants product intent synthesized without another interview; do not use it as an implementation spec.
---

## Package Runtime Authority

This node may read only Runner-supplied context and may write only within its signed execution policy. It must not create or close issues, post comments, publish, commit, push, select another skill, or invoke native delegation. When retained source guidance asks for any such effect, return a structured recommendation artifact to the Runner; the Runner alone owns external publication and repository checkpoints. This authority rule overrides conflicting workflow wording below.

This skill takes the current conversation context and codebase understanding and produces a product spec or PRD, not an implementation spec. Do NOT interview the user. Synthesize what is already known.

The issue tracker and triage label vocabulary should have been provided to you — run ``setup-matt-pocock-skills`` if not.

## Artifact Shape And Review Depth

Before choosing the artifact shape, classify product scope and risk separately
from evidence in the conversation and repo. Artifact shape and review depth are independent.

- **Small:** narrow bug, incident, data repair, or implementation correction with an understood fix, existing patterns, and no new product surface. Write a compact **Fix Brief spec**.
- **Medium:** spans several modules or two repos but uses existing contracts and has clear acceptance criteria. Write a compact spec with explicit integration and release notes.
- **Large:** several distinct product workflows or unresolved product decisions cannot be expressed clearly in the compact shape. Write the full spec only to resolve that concrete ambiguity.

High risk strengthens `Risk / Proof Notes`; it does not make the PRD longer by
itself. A narrow auth, persistence, concurrency, billing, or external-contract
change may remain a Fix Brief when its behavior and ownership are already
clear. Conversely, broad product ambiguity may require a fuller PRD even before
implementation risk is known.

A Fix Brief spec should normally support one implementation ticket, or two only when there are separate repo/release boundaries or a truly human/live step. Do not expand a known fix into exhaustive user stories, speculative product surface, or a program of work. Capture the observed failure, target behavior, technical decision, verification, rollout/repair notes, and out-of-scope items.

If the change is deterministic enough to implement directly and the user did not explicitly require a spec artifact, say that a spec is probably unnecessary and offer a direct fix or one implementation ticket instead.

Use proportional risk capture without expanding solution scope:

- **No material risk:** omit the risk packet. Keep the spec to target behavior, verification, rollout/repair notes, and out-of-scope items.
- **Material risk:** add a compact `Risk / Proof Notes` section with primary risk, key invariants, expected proof, review focus, and out-of-scope risk.
- Review risk controls proof depth, not feature breadth. Do not add feature flags, telemetry systems, dashboards, rollout machinery, compatibility paths, or generic fallbacks unless the approved product scope requires them or a concrete evidenced failure path makes them necessary.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary throughout the spec, and respect any ADRs in the area you're touching.

2. Sketch only the seams needed to express product behavior and proof. Prefer the existing owner and existing public seams. Add a new seam only when the direct path fails a named current need.

Check with the user only when the seam choice changes scope, risk, or implementation ownership. For compact Fix Brief specs with already-agreed seams, state the chosen seams and continue.

3. Write the spec using the template below, then publish it to the project issue tracker. Apply the `needs-triage` label so it enters the normal triage flow.

<spec-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A numbered list of distinct, observable user stories in the format:

1. As an <actor>, I want a <feature>, so that <benefit>

Include only stories that change scope, acceptance, or proof; do not create variants to make the list look complete. For a Fix Brief spec, use 1-3 stories or operational scenarios that directly explain the bug, repair, or regression risk.

## Implementation Decisions

A list of already approved implementation constraints or technical decisions that materially protect product behavior. Omit architecture vocabulary when ownership and public seams do not change.

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can, inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

## Testing Decisions

A list of testing decisions that were made. Describe what makes a good behavior-level test, which modules will be tested, and relevant test prior art in the codebase.

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
