# Implementation Operation

Follow [Agent Auto](../../skills/agent-auto/SKILL.md) as the Runner adapter.
Use the packaged [coding routing](../../docs/agents/coding-skill-routing.md)
only for direct implementation, TDD, bug-routing, evidence, and affected
validation. Read [TDD](../../skills/tdd/SKILL.md) before behavior changes. For
a confirmed bug use [Code Debugger](../../skills/code-debugger/SKILL.md); use
[Diagnosing Bugs](../../skills/diagnosing-bugs/SKILL.md) only when a reliable
failing signal is missing. A tiny task may use
[Small Task Implementer](../../skills/small-task-implementer/SKILL.md) only
after its Fit Gate. Apply the declared
[bug routing](../../docs/agents/bug-workflow-routing.md),
[contract ledger](../../docs/agents/contract-test-ledger.md),
[review gate](../../docs/agents/review-gates.md), and
[tool policy](../../docs/agents/tool-usage.md) only when their branch is active.

The issue is already authorized for implementation. Do not start planning,
ticket publication, implementation-spec authoring, independent review, or
delivery. The Runner owns review, checks, commits, publication, retries, and
external state. Never commit, push, publish, mutate GitHub, or expose
credentials. Return only `schemas/implementation-report-v1.json`.
