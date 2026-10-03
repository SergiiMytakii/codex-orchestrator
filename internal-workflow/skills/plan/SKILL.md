---
name: plan
description: Resolve a real product or ownership decision gap, save a compact local plan after deep review, or compose the smallest durable PRD and executable ticket packet. Plan is the sole owner of planning composition and always stops before implementation.
---

# Plan

Plan is the sole owner of planning composition. Use it only for a real product
or ownership decision gap, a request to save or review a plan, or multi-ticket
or multi-session work that needs durable authority. A clear feature, fix, or
local edit routes to `$implement` without a planning artifact.

## Choose the smallest planning outcome

- For a real decision gap, invoke `$grilling` only as needed to reach explicit
  shared understanding through dependency-aware frontier rounds. Grilling owns
  the write-free dialogue; keep the resolved decision in the current
  conversation unless a later fresh context needs durable authority.
- Resolve a decision gap in the current conversation when no durable handoff is
  needed. Do not create a PRD or tickets merely to record the conversation.
- For a compact local Markdown plan, keep the settled conversation draft as the
  fixed base, use `$plan-review`, reconcile findings minimally, and save it.
- Create a durable PRD only when product authority must survive the current
  context or be consumed in a later fresh context.
- Decide whether durable executable tickets are needed. Once they are,
  `$to-tickets` owns their count and slicing from the approved product
  authority; Plan does not pre-size the packet from file count, technical
  layers, or generic risk.

The Parent PRD is the sole product and final-acceptance authority. Tickets are
local executable slices; they do not duplicate that authority.

## Minimum solution

Before settling a plan:

1. State the direct solution through existing owners and seams.
2. Keep only mechanisms required by user authority, repository invariants, or
   proven failure paths.
3. Keep agent recommendations as proposals; saving a draft is not approval.
4. Delete any mechanism whose removal preserves required behavior and credible
   proof.

Complete when every binding mechanism has authority and demonstrated necessity.

Before Plan saves a settled local plan, when the user explicitly requests
independent review, or when repository policy requires it, invoke
`$plan-review`. Plan remains the sole composition owner; the reviewer returns
findings only and never a rewritten plan.

For review followed by saving, the original settled draft remains the fixed
base. Reconcile each finding before editing:

- Only verified `BLOCKER` findings may change the draft. Require Authority,
  Trigger, Impact, and the Minimal correction already inside the approved
  outcome.
- Return a plan-changing `QUESTION` to the user. Do not guess its answer.
- Do not copy `QUESTION` or `OBSERVATION` findings into it.
- Apply verified blockers as one minimal revision that preserves the draft's
  structure, order, and information density. Do not restate the same obligation
  across overview, implementation, proof, and completion sections or add a new
  section merely to make the artifact look comprehensive.
- If a correction changes product behavior, ownership, public boundaries, or
  the authorized outcome, stop for a decision instead of expanding the plan.

After the first full review, reconcile verified blockers in one minimal batch.
Re-review only the blockers, changed text, and direct impact; unchanged scope
stays settled. Repeat the full review only for a new product outcome or owner,
or when the impact cannot be isolated. A user answer alone does not trigger it.
Saving never turns an observation into scope or a plan into implementation
authority.

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
- Do not invoke `$code-review` or delivery Review while planning.
- If behavior, scope, ownership, ticket boundaries, blockers, or proof
  obligations remain unresolved, keep them visible as a user decision or a
  blocking discovery/HITL ticket; never guess.
