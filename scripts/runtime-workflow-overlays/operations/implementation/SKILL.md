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

Within this operation, Diagnosing Bugs is a side procedure of the enclosing
Implement procedure, not a terminal response. Return its reproduction and
root-cause evidence to that same Implement procedure, then continue the
authorized fix through TDD or other regression proof and post-fix verification.
Continue applicable Review and commit steps only when this operation has not
reserved them to the Runner. Do not emit the Diagnosing Bugs output contract;
finish by emitting the non-empty implementation report required below.

The issue is already authorized for implementation. Do not start planning,
ticket publication, independent review, or delivery. Preserve the same logical
Implement ownership for supplied repair findings. The Runner owns affected
checks, proof, review, commits, publication, and
external state. Never commit, push, publish, mutate GitHub, or expose
credentials. In the final report, `changedFiles` is the complete current product
change set across the Run, not only files touched in this
attempt; exclude Runner-owned proof artifacts. For a trusted issue-comment
follow-up, return `answer-only` when no code change is required, or `boundary`
when the request is ambiguous, changes a settled decision, or exceeds the
original issue authority. Those outcomes must keep `changedFiles` empty and
must not invent checks, proof, review, commit, push, or a replacement PR.
Return only
`schemas/implementation-report-v1.json`.
