---
name: plan
description: Resolve a real product or ownership decision gap in the current conversation, or compose the smallest durable PRD and executable ticket packet for multi-ticket or multi-session work. Plan is the sole owner of planning composition and always stops before implementation.
---

# Plan

Plan is the sole owner of planning composition. Use it only for a real product
or ownership decision gap, or for multi-ticket or multi-session work that needs
durable authority. A clear feature, fix, or local edit routes to `$implement`
without a planning artifact.

## Choose the smallest planning outcome

- For a real decision gap, invoke `$grilling` only as needed to reach explicit
  shared understanding through dependency-aware frontier rounds. Grilling owns
  the write-free dialogue; keep the resolved decision in the current
  conversation unless a later fresh context needs durable authority.
- Resolve a decision gap in the current conversation when no durable handoff is
  needed. Do not create a PRD or tickets merely to record the conversation.
- Create a durable PRD only when product authority must survive the current
  context or be consumed in a later fresh context.
- Decide whether durable executable tickets are needed. Once they are,
  `$to-tickets` owns their count and slicing from the approved product
  authority; Plan does not pre-size the packet from file count, technical
  layers, or generic risk.

The Parent PRD is the sole product and final-acceptance authority. Tickets are
local executable slices; they do not duplicate that authority.

## Durable composition

Plan owns the composition sequence. `$to-spec` owns PRD synthesis,
`$to-tickets` owns executable slicing and publication, and neither primitive
repeats the other's mechanics.

For a requested spec-and-tickets outcome:

1. invoke `$to-spec` in combined mode;
2. keep the PRD draft in the current context;
3. pass that draft directly to `$to-tickets`;
4. do not publish or independently review the intermediate PRD;
5. Let `$to-tickets` own executable slicing, one fresh semantic review per
   settled revision, one explicit user approval of the final packet, serialized
   publication, deterministic reconciliation, and authoritative tracker
   read-back.
6. Stop before implementation.

Requests phrased as “spec to tickets” route directly to Plan. Do not dispatch
through an alias, wrapper, adapter, fallback, or compatibility route.

## Boundaries

- Planning output, issue relationships, and labels never authorize delivery.
- Do not create a second planning artifact after executable tickets exist.
- Do not invoke implementation or delivery reviewers while planning.
- If behavior, scope, ownership, ticket boundaries, blockers, or proof
  obligations remain unresolved, keep them visible as a user decision or a
  blocking discovery/HITL ticket; never guess.
