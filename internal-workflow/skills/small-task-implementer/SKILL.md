---
name: small-task-implementer
description: Implement small low-risk coding tasks quickly with a compact contract, narrow edits, targeted validation, and explicit escalation when scope, risk, or verification no longer fits. Use for tiny bug fixes, UI/copy tweaks, config/build corrections, simple tests, one-module behavior changes, and other changes that should not require plans, specs, issue orchestration, or heavy review gates.
---

# Small Task Implementer

Use this skill for fast, bounded implementation when creating a PRD and approved ticket-delivery flow would be disproportionate.

## Fit Gate

Proceed only when all are true:

- The requested behavior is clear or can be inferred from local code/tests without a product decision.
- The change is expected to touch one small area or a few tightly related files.
- There is a narrow validation path: targeted test, lint/typecheck, build check, UI proof, or direct command.
- The task does not require a new plan, PRD, issue breakdown, implementation spec, migration, rollout, or multi-agent orchestration.

Escalate instead of implementing when the task touches:

- state transitions, queues, retries, idempotency, background jobs, persistence, migrations, schemas, DTO/API contracts, auth, permissions, payments, caching, or shared cross-module behavior;
- multi-service, multi-repo, multi-agent, production/live-data, or external-contract work;
- unclear product intent, ambiguous scope, no credible validation path, or likely broad refactoring.

Escalation rule:

- Escalate into the single canonical delivery flow: optional `$grilling` for unresolved product decisions, then `$spec-to-tickets` for the reviewed Approval Packet, then `$tickets-orchestrator` for approved ticket delivery.
- For one risky behavior or technical contract, prefer one approved ticket and mark `compact spec` or `standard spec` only when the ticket plus repository evidence cannot remove execution ambiguity.
- For several tickets sharing one unresolved contract or validation path, make the contract-defining ticket block its consumers; merge tickets that cannot be specified or verified independently instead of creating a wave-level implementation spec.
- Escalate if the bug requires Bugfix Quality Gate analysis across multiple paths, states, async events, persistence, auth, cache, retries, workers, or contracts.

## Workflow

1. Inspect local context just enough to confirm fit.
   - Read repo instructions and the smallest relevant code/test files.
   - Check `git status --short` before editing.
   - Preserve unrelated dirty work.

2. Write a compact contract in the working update or internal task notes:

```text
Behavior:
Scope boundary:
Validation:
```

3. Implement the smallest complete change.
   - Prefer existing patterns and owner modules.
   - Avoid unrelated refactors, abstractions, cleanup, and compatibility paths.
   - Before adding a helper, module, layer, or seam, apply the deletion test; keep it only if it improves current locality or leverage.
   - Do not add pass-through modules, one-adapter seams, or tests coupled to Implementation details; escalate if no natural public test seam exists.
   - Add or update a focused test only when behavior risk justifies it and the repo has a natural seam.
   - For pure copy/docs/config changes, do not invent tests; run the cheapest relevant syntax/lint/check instead.

4. Run targeted validation.
   - Use the narrowest meaningful command first.
   - If validation is unavailable or too expensive, state the concrete reason and residual risk.
   - Do not run full CI unless local policy or the changed surface makes it necessary.

5. Stop and escalate if implementation reveals hidden risk.
   - Examples: shared contract drift, duplicate source of truth, missing test seam, broad file spread, concurrency, persistence, or product ambiguity.
   - Leave a short explanation of what was discovered and which heavier flow should take over.

## Output

Final response must stay compact:

```text
Small Task Result

Changed:
- ...

Proof:
- ...

Skipped:
- none / ...

Risk:
- low / reason
```

If escalated, use:

```text
Escalated

Reason:
- ...

Recommended flow:
- Canonical ticket delivery / direct small task

Evidence:
- ...
```
