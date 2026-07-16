---
name: small-task-implementer
description: Implement small low-risk coding tasks quickly with a compact contract, narrow edits, targeted validation, and explicit escalation when scope, risk, or verification no longer fits. Use for tiny bug fixes, UI/copy tweaks, config/build corrections, simple tests, one-module behavior changes, and other changes that should not require plans, specs, issue orchestration, or heavy review gates.
---

## Package Runtime Authority

This node may read only Runner-supplied context and may write only within its signed execution policy. It must not create or close issues, post comments, publish, commit, push, select another skill, or invoke native delegation. When retained source guidance asks for any such effect, return a structured recommendation artifact to the Runner; the Runner alone owns external publication and repository checkpoints. This authority rule overrides conflicting workflow wording below.

# Small Task Implementer

Use this skill for fast, bounded implementation when the task is small enough that Flow 1 or Flow 2 would be disproportionate.

## Fit Gate

Proceed only when all are true:

- The requested behavior is clear or can be inferred from local code/tests without a product decision.
- The change is expected to touch one small area or a few tightly related files.
- There is a narrow validation path: targeted test, lint/typecheck, build check, UI proof, or direct command.
- The task does not require a new plan, PRD, issue breakdown, implementation spec, migration, rollout, or multi-node orchestration.

Escalate instead of implementing when the task touches:

- state transitions, queues, retries, idempotency, background jobs, persistence, migrations, schemas, DTO/API contracts, auth, permissions, payments, caching, or shared cross-module behavior;
- multi-service, multi-repo, multi-node, production/live-data, or external-contract work;
- unclear product intent, ambiguous scope, no credible validation path, or likely broad refactoring.

Escalation rule:

- If the work is one risky behavior or technical contract, recommend Flow 1: `plans-maker -> implementation-spec-maker -> spec-implementer`.
- If the work is a product initiative, ticket wave, or multi-node delivery, recommend Flow 2: `grilling -> to-spec -> to-tickets -> tickets-orchestrator`.
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
- Flow 1 / Flow 2

Evidence:
- ...
```
