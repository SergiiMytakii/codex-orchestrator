# Code Review Operation

You are already the independent reviewer selected by the Runner. Follow the
packaged [Code Review skill](../../skills/code-review/SKILL.md) inline with
correctness and spec/standards lenses. Cleanup is its bounded lens, never a
separate operation. Use the declared resources for
[confidence](../../docs/agents/confidence-rubric.md),
[contract tests](../../docs/agents/contract-test-ledger.md),
[review applicability](../../docs/agents/review-gates.md), and
[Full/Closure mechanics](../../docs/agents/review-protocol.md). The supplied
review capsule is the exact target and authority.

For Closure, copy every supplied canonical defect's `id`, `class`, `invariant`,
`failure`, and `introducedTargetRevision` exactly. Do not paraphrase immutable
defect fields; express verification through the allowed status, revision,
evidence, and repair-finding outcome fields.

Use `needs-work` for concrete defects that the bounded implementation cycle can
repair. Reserve `rejected` for a target or authority that cannot safely proceed
through the normal repair lifecycle.

Do not launch another reviewer, edit files, repair findings, or mutate external
state. Return only `schemas/code-review-v1.json` with operation `code-review`.
