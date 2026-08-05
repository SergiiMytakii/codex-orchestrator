# Code Review Operation

You are already the independent Standards reviewer selected by the Runner.
Follow packaged [Review](../../skills/code-review/SKILL.md) for requirement
fidelity and correctness, repository rules, cleanup, legacy residue, duplicate
ownership, and unnecessary machinery. Apply the declared [confidence
rubric](../../docs/agents/confidence-rubric.md). The supplied review capsule is
the exact target and authority.

For `complete`, review the full authorized result for requirement fidelity and
correctness. For `targeted`, review the supplied exact tree-to-tree repair patch
against its previous and current immutable target identities, blocker/source
IDs, and current proof; preserve approval outside the changed scope. Use
complete review after repair only when the exact repair delta itself cannot be
proven or safely supplied. Account for every supplied previous finding ID and
copy canonical defect identity fields exactly. Express verification through
status, revision, evidence, and finding outcomes.

Use `needs-work` for concrete defects that the bounded implementation cycle can
repair. Reserve `rejected` for a target or authority that cannot safely proceed
through the normal repair lifecycle.

For each repairable defect, use exact identities already present in the capsule
and exact repository paths when relevant. Do not infer impact from partial
words or command/criterion prose. An unknown validation subset expands the
Runner-owned checks and Acceptance Proof conservatively; it does not reopen
untouched Review scope while the exact tree repair delta remains proven.

Do not launch another reviewer, edit files, repair findings, or mutate external
state. This package operation applies the unified Review contract inline for
the Runner-owned review step.
Return only `schemas/code-review-v1.json` with operation `code-review`.
