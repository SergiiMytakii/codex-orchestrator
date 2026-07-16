---
name: to-tickets
description: Break a plan, spec, PRD, or current conversation into proportionate tracer-bullet tickets with explicit blocking edges, review gates, and tracker-ready acceptance criteria.
---

## Package Runtime Authority

This node may read only Runner-supplied context and may write only within its signed execution policy. It must not create or close issues, post comments, publish, commit, push, select another skill, or invoke native delegation. When retained source guidance asks for any such effect, return a structured recommendation artifact to the Runner; the Runner alone owns external publication and repository checkpoints. This authority rule overrides conflicting workflow wording below.

# To Tickets

Break the work into independently grabbable tickets using vertical slices. Each ticket declares the tickets that block it.

Prefer the smallest number of complete tickets that preserves independent ownership, verification, and release sequencing. Do not turn a one-ticket change into breakdown ceremony.

The issue tracker and triage label vocabulary should have been provided to you — run ``setup-matt-pocock-skills`` if not.

## Progressive references

Read [references/publishing-details.md](./references/publishing-details.md) only when one of these is true:

- the breakdown needs `Spec required` or external-contract decisions
- the work includes live/manual prerequisites or UI-proof-heavy slices
- you are preparing the final user quiz output
- you are publishing ticket bodies to the tracker
- you need the review gate details for ``tickets-breakdown-review``

## Ticket Shape And Review Depth

Before drafting tickets, classify delivery shape and review risk separately.
Ticket count and review depth are independent.

- **Small:** narrow deterministic bugfix, incident fix, data repair, or backend/client correction. Prefer one implementation ticket; add a second only for a separate repo/release boundary, human/live repair step, or genuinely independent follow-up.
- **Medium:** multiple modules, one or two repos, clear contracts, moderate regression risk. Use a few complete vertical slices, usually 2-4, with an integration/regression ticket only if individual slices cannot prove the full path.
- **Large:** several independently owned or independently verifiable product workflows, release boundaries, blockers, or human/live gates require separate delivery. Include discovery, implementation, integration, or HITL slices only where each has its own observable outcome.

High risk adds stronger proof, review focus, and handoff requirements to the
smallest valid ticket or wave; it does not create another ticket by itself.
Split only for independent ownership, release sequencing, real blockers,
separate observable behavior, or human/live work.

Do not split by technical layer when one agent and one PR can deliver the complete behavior with tests and verification. If the plan already fits in one ticket, publish or draft that ticket directly.

Use proportional risk fields:

- **No material risk:** one ticket with clear acceptance criteria and verification is enough when delivery is otherwise coherent.
- **Material risk:** the affected ticket or wave names the primary risk, main invariant, review focus, and final handoff expectation. Prefer one wave-level risk field when several tickets share a source-of-truth contract.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes a spec path, ticket number, URL, or other tracker reference, fetch it and read its full body and comments.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Ticket titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

Record prefactoring only when current structure blocks the vertical behavior now. Do not create a cleanup or module-only ticket for speculative convenience.

### 3. Draft vertical slices

Break the work into tracer-bullet tickets. Each ticket must have explicit blocking edges.

- Each slice cuts a narrow but complete path through every relevant layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized to fit in a single fresh context window
- Split for independent ownership, release sequencing, real blockers, product workflows, or human/live work
- For complex work, create discovery/contract tickets instead of hiding unresolved decisions inside implementation tickets
- Do not create tickets whose only outcome is creating a module unless they also prove observable behavior
- Do not add feature flags, telemetry systems, dashboards, rollout machinery, compatibility paths, or generic fallbacks unless the source requires them or a concrete evidenced failure path makes them necessary
- For user-facing work, include a UI walkthrough criterion and use ``ui-evidence-proof`` as the proof standard

Default to `Spec required: none`. If the work has unresolved contracts, external dependencies, shared cross-ticket source-of-truth, or live/manual prerequisites, load [references/publishing-details.md](./references/publishing-details.md) and classify it as `none`, `issue-level`, or `wave-level`.

Wide refactors are the exception to vertical slicing. When one mechanical change has a codebase-wide blast radius, sequence it as expand-contract: add the new form beside the old, migrate callers in independently green batches, then remove the old form after every migration ticket is complete. If batches cannot stay green independently, use an integration branch and a final integrate-and-verify ticket.

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each ticket, show:

- **Title**
- **Type**: HITL / AFK
- **Blocked by**
- **Spec required**: none / issue-level / wave-level when relevant
- **What it delivers**: the observable end-to-end behavior
- **Risk / Review**: only when material risk exists

Ask whether the granularity, blocking edges, and HITL/AFK assignments are right, and whether any tickets should be merged or split. Iterate until the user approves the breakdown.

### 5. Review the breakdown before publishing

Run the approved draft through ``tickets-breakdown-review``. For one or two straightforward tickets with no unresolved cross-repo contract or live/HITL mutation, use its mandatory lenses as a compact inline checklist. For larger breakdowns or breakdowns with unresolved coordination risk, load [references/publishing-details.md](./references/publishing-details.md) and use the full review gate. High review risk alone does not force a larger breakdown or a dedicated reviewer.

### 6. Publish the tickets to the configured tracker

Publish blockers first so later tickets can reference real identifiers.

- **Local files**: write one file per ticket under `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01` in dependency order. Each file lists its blockers.
- **A real issue tracker**: publish one tracker issue per ticket in dependency order. Use native blocking links when available; otherwise write `Blocked by` references in the body.

Apply the `needs-triage` label so every ticket enters the configured triage flow. Load [references/publishing-details.md](./references/publishing-details.md) for the publish-ready body templates and proof wording.

Work the frontier: any ticket whose blockers are all complete can start.

Do NOT close or modify any parent issue.
