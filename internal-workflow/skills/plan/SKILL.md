---
name: plan
description: Resolve a real product or ownership decision gap, save a compact local plan after deep review, or compose the smallest durable PRD and executable ticket packet. Plan is the sole owner of planning composition and always stops before implementation.
---

# Plan

Plan is the sole owner of planning composition. Use it only for a real product
or ownership decision gap, a request to save or review a plan, or multi-ticket
or multi-session work that needs durable authority. A clear feature, fix, or
local edit routes to `$implement` without a planning artifact.

## Choose the Smallest Planning Outcome

- Resolve decision gaps in the current conversation; invoke `$grilling` only
  when needed for write-free, dependency-aware dialogue and explicit shared
  understanding. Create no artifact unless requested or required for a durable
  handoff. Saving a conversation does not require a PRD or tickets.
- For a compact local Markdown plan, use the settled conversation draft as the
  fixed base, review and reconcile it as below, then save it.
- Create a durable PRD only when requested or when product authority must
  survive the current context or be consumed in a later fresh context.
- Decide whether durable executable tickets are needed. Once they are,
  `$to-tickets` owns their count and slicing from approved product authority;
  file count, technical layers, and generic risk do not pre-size the packet.

The Parent PRD is the sole product and final-acceptance authority. Tickets are
local executable slices; they do not duplicate that authority.

## Ground the Technical Plan

Before settling a technical plan, inspect applicable repository policy and
trace the relevant existing owner and caller path in code. Check affected data
or state and existing tests or commands that can prove the intended outcome.
Read only enough to verify material feasibility assumptions; reuse current
source evidence already available rather than restarting discovery.

Before settling the technical approach, apply the [Design Decisions rule](../../docs/agents/coding-skill-routing.md#design-decisions)
in the normative coding route.

Ground technical claims in concrete source references, recorded once in the
plan or review inputs as appropriate to the artifact format. Distinguish
observed behavior, proposed changes, and unresolved assumptions. Do not present
invented paths, APIs, ownership, or migration behavior as implementation facts.
When code or evidence is unavailable, expose the gap or a blocking discovery
outcome instead of declaring dependent work executable. Review checks a settled
plan; it does not replace this discovery. This inspection authorizes no code
changes, production mutations, or implementation experiments.

## Minimum Solution

State the direct solution through existing owners and seams. Keep a new
mechanism only when user authority, a repository invariant, or a proven failure
path requires it and the direct solution cannot satisfy that obligation.
Remove additions whose deletion preserves required behavior and credible proof.

Agent recommendations remain proposals until confirmed. Saving or publishing
a draft is neither approval nor implementation authority.

## Local Plan Review and Saving

Before saving a settled local plan, or when explicitly requested or required
by repository policy, invoke `$plan-review`. The reviewer returns findings;
Plan retains composition ownership.

Keep the settled draft as the base. Apply verified `BLOCKER`s in one minimal
batch, requiring Authority, Trigger, Impact, and Minimal correction within
the authorized outcome. Preserve structure, order, and information density.
Do not add sections or repeat obligations merely for completeness.

Return plan-changing `QUESTION`s to the user without guessing answers or
copying findings into the draft as requirements. `OBSERVATION`s do not become
scope unless explicitly adopted. Corrections changing product behavior,
ownership, public boundaries, or the authorized outcome require a decision
before revision; unresolved choices prevent settling the affected plan.

For local plans, re-review repaired blockers, changed text, and direct impact;
unchanged scope remains settled. Repeat complete review only when the outcome
or owner changes, or impact cannot be isolated. A user answer alone does not
require complete review. Ticket packets follow `$to-tickets` review and
approval rules.

## Durable Composition

For a requested spec-and-tickets outcome, invoke `$to-spec` in combined mode
and pass its contextual draft directly to `$to-tickets`. Do not independently
review or publish the intermediate PRD.

`$to-spec` owns PRD synthesis. `$to-tickets` owns slicing, packet review,
exact-packet approval, serialized publication, reconciliation, and authoritative
tracker read-back. Plan owns composition and stops before implementation.
Requests for “spec to tickets” enter this composition directly.

## Boundaries

- Planning output, issue relationships, and labels never authorize delivery.
- Do not create a second planning artifact after executable tickets exist.
- Do not invoke `$code-review` or delivery Review while planning.
- If behavior, scope, ownership, ticket boundaries, blockers, or proof
  obligations remain unresolved, keep them visible as a user decision or a
  blocking discovery/HITL ticket; never guess.
