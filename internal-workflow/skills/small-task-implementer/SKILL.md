---
name: small-task-implementer
description: Implement small low-risk coding tasks with narrow edits and targeted validation. Use for tiny fixes, UI/copy changes, config/build corrections, simple tests, or one-module changes that do not need plans, specs, orchestration, or heavy review.
---

# Small Task Implementer

Use this skill for fast, bounded implementation when creating a PRD and approved ticket-delivery flow would be disproportionate.

## Fit Gate

Proceed only when all are true:

- The requested behavior is clear or can be inferred from local code/tests without a product decision.
- The change is expected to touch one small area or a few tightly related files.
- There is a narrow validation path: targeted test, lint/typecheck, build check, UI proof, or direct command.
- The task does not require a new plan, PRD, issue breakdown, implementation spec, migration, rollout, or multi-agent orchestration.

Escalate out of the tiny-task route when the work has more than one coherent
behavior, a broad ownership boundary, material rollback/recovery risk, unclear
product intent, no credible affected validation, or genuine multi-agent/live
coordination. Statefulness alone does not require escalation into planning or
orchestration; a clear API, persistence, cache, queue, or DTO change normally
becomes direct medium implementation.

Escalation rule:

- For clear authority and one coherent outcome, escalate to direct medium root
  implementation under `$tdd`, affected validation, and one final review when
  `review-gates.md` applies.
- Use optional `$grilling`, then `$spec-to-tickets` and `$tickets-orchestrator`,
  only for unresolved product decisions or a real approved ticket graph,
  delivery dependency, or explicit orchestration request.
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
   - Examples: shared contract drift, duplicate source of truth, missing test
     seam, material concurrency/recovery uncertainty, or product ambiguity.
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
- Direct medium implementation / canonical ticket delivery

Evidence:
- ...
```
