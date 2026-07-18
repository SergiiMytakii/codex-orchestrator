---
name: "implementation-spec-maker"
description: "Turn an approved plan, implementation issue, contract-discovery task, or existing spec into the smallest deterministic implementation spec. Use when downstream coding needs an executable checklist with confirmed scope, targets, commands, contracts, validation, and review evidence; do not use for product discovery or implementation."
---

# Implementation Spec Maker

Create or revise an execution-ready specification for a downstream coding agent. Do not implement code or reopen approved product scope.

## Core Contract

- Treat the supplied plan, issue, discovery task, or existing spec as source authority.
- Preserve approved scope, exclusions, guardrails, rejected approaches, blockers, validation, and required docs.
- Confirm execution-critical facts from repository evidence or trusted external contracts. Never invent paths, symbols, commands, fixtures, env vars, schemas, ownership, or API behavior.
- Produce the smallest spec another agent can execute without guessing. Save a useful `blocked` spec when a material unknown cannot be resolved.
- Reference approved source content instead of repeating it; write only the missing execution delta.

## Preflight

1. Read the source authority, applicable repository instructions, and only the evidence needed to confirm targets, commands, contracts, consumers, fixtures, and validation.
2. Reuse valid Evidence Maps and `$research` artifacts. Refresh only claims invalidated by changed files, versions, dates, contracts, or conflicts.
3. Read the relevant section of [source modes](references/source-modes.md). Stop or mark the spec blocked when its source-specific requirements are not satisfied.
4. Classify and record these independent facts:
   - `spec_mode`: `compact | full` — document and coordination density.
   - `implementation_size`: `small | medium | large` — expected delivery shape.
   - `review_profile`: `simple | medium | high` — consequence and uncertainty,
     resolved through the review loop owned by `$implementation-spec-review`.
   - `expected_repositories`: exact positive integer from approved scope.

Do not infer one classification from another. For ticket work, `direct` returns
to `$tdd`, `compact spec` requests compact mode, and `standard spec` asks the
maker to choose the smallest deterministic shape. Start a standard ticket in
compact mode and expand to full only when repository evidence proves a concrete
ambiguity that compact form cannot remove safely.

## Choose The Smallest Shape

Default to `compact`, including coherent high-risk or cross-repository work, when ownership, sequencing, stop conditions, and proof fit clearly.

Use `full` only when compact form would leave a concrete ambiguity in safety, contract, ownership, sequencing, validation, revision history, or multi-agent integration. Add only the conditional controls that resolve that ambiguity. Risk alone does not require a long document.

Keep `execution_model: "single-agent"` unless write scopes are perfectly disjoint and one integrator contract is necessary. Never assign overlapping ownership of files, schemas, generated artifacts, migrations, source-of-truth rules, or shared contracts.

## Minimum Solution Gate

Before drafting slices:

1. Reduce the approved outcome to required behavior, material invariants, and proof.
2. State the direct `Minimum Solution` through existing owners, public seams, and repository patterns.
3. Set `Added Complexity: None` unless the minimum solution cannot satisfy a named requirement or evidenced failure path.
4. For every added mechanism, including a new service, helper, adapter, layer, schema object, transaction, retry policy, job, cache, flag, compatibility path, or coordination boundary, record the exact invariant or failure that requires it and what breaks without it.
5. Run the deletion challenge: if removing a proposed mechanism still satisfies all approved behavior, invariants, and proof, remove it from the spec.

Judge simplicity by the fewest necessary concepts, owners, states, and integration points, not by line or file count. Do not require complexity scores or alternative-solution essays.

## Draft The Execution Contract

Read [the spec template](references/spec-template.md) before drafting, then remove every unused placeholder and optional block.

- Name exact source material, approved scope, exclusions, preconditions, confirmed targets, commands, and observable done criteria.
- Organize behavior-changing work as narrow vertical slices. Start each slice with the first failing behavior test or exact observable proof, then implementation targets and a slice exit gate.
- For contract-heavy behavior, use `../../docs/agents/contract-test-ledger.md` and include only material invariants with their first RED test or proof.
- For UI/app-facing behavior, invoke `$ui-evidence-proof` and embed its task-specific workflow, expected screen state, viewport coverage, fresh artifacts, and criterion-to-artifact mapping in the relevant slice.
- State exact manual/live proof when automation is not applicable.
- Name one source of truth when behavior or data can drift. Reuse existing owners and public seams; invoke `$codebase-design` only when ownership or a public seam changes.
- Add task-specific review checkpoints only when a risky slice becomes stable before later work. Otherwise assign its mandatory lenses, applicable targeted recipes, and concrete bug classes to final review coverage.
- For medium-risk specs, rely on the normal concise `$spec-implementer` completion summary unless a task-specific deviation is needed. For high-risk specs, point `Final Handoff Requirements` to the extended `$spec-implementer` Final Risk Handoff and add only task-specific deviations; do not copy its field list.
- Keep optional cleanup, compatibility logic, feature flags, telemetry, rollout machinery, generic fallbacks, and speculative abstractions out of the spec unless source authority or a proven failure path requires them.

## Review And Save

1. Save the draft at `docs/implementation-specs/YYYY-MM-DD/HHMM-<slug>.md` with temporary `status: "draft"` and `review_outcome: "Pending"` so review applies to a stable artifact path without presenting it as approved.
2. Read `../implementation-spec-review/references/review-loop.md` and invoke
   `$implementation-spec-review` as its Adapter. Supply the saved spec, source
   authority, approved decisions, and evidence; do not restate its topology or
   defect lifecycle.
3. Apply one consolidated, scope-preserving repair batch, then follow the owner
   loop until it returns `Approved`, `Blocked`, or an eligible user-authorized
   `Waived` outcome.
4. A preflight-blocked spec may be saved with zero reviews and `review_verdict: "Not run"`. Never fabricate approval or use `Not required`.
5. Replace temporary lifecycle metadata with outcome, last Adapter verdict,
   mandatory coverage, accepted risks, and open stable IDs. Keep pass/session
   counts only for high, Closure, or interrupted review. Any substantive
   post-approval edit invalidates approval until reviewed again.

## Final Response

Return only:

```text
Spec Status: Ready | Blocked
Saved Path: <path>
Execution: <single-agent | multi-agent>; <compact | full>; <small | medium | large>; <n> repository/repositories
Review: <Approved | Blocked | Waived>; <simple | medium | high>; <coverage or gaps>
Adapter Verdict: <Approved | Needs Work | Rejected | Not run>
Verified Defects: <stable IDs or None>
Accepted Risks: <stable IDs, authority, and reason or None>
Open Defects: <stable IDs or None>
Blockers: <unresolved blockers or None>
```

Do not repeat the specification or downstream implementation/signoff procedure in chat.
