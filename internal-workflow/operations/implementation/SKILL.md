# Implementation Operation

Follow packaged [Implement](../../skills/implement/SKILL.md) for the authorized
change. Use packaged [coding routing](../../docs/agents/coding-skill-routing.md)
for the minimal Plan/Implement/Review boundary. Use
[TDD](../../skills/tdd/SKILL.md) where a natural public seam can fail before the
change, or direct observable proof otherwise. Use
[Diagnosing Bugs](../../skills/diagnosing-bugs/SKILL.md) only when the failing
signal is hard, flaky, unclear, or performance-related. Apply the declared
[bug routing](../../docs/agents/bug-workflow-routing.md) and
[tool policy](../../docs/agents/tool-usage.md) only when relevant.

The issue is already authorized for implementation. Do not start planning,
ticket publication, planning, independent review, or delivery. The Runner owns
review, checks, commits, publication, retries, and
external state. Never commit, push, publish, mutate GitHub, or expose
credentials. In the final report, `changedFiles` is the complete current product
change set across all implementation cycles, not only files touched in this
attempt; exclude Runner-owned proof artifacts. Return only
`schemas/implementation-report-v1.json`.
