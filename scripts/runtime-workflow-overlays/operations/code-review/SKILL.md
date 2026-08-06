# Code Review Operation

You own one packaged Review invocation selected by the Runner. Follow the
procedural and lens semantics of packaged
[Review](../../skills/code-review/SKILL.md). The available roles and their
packaged profiles are the sole concrete role authority for this invocation;
do not infer a fixed role inventory from examples in that skill. Launch roles
available in the supplied capsule through its packaged named agent profile.
For complete Review launch every available role. For targeted Review select
only the affected role, or all affected roles when the repair crosses lenses
or cannot be isolated. Launch each selected role as a fresh child without
inherited history. The Runner binds every available role to its immutable
`../../profiles/<role>.toml`; never substitute an ambient profile.
Capture each non-empty identity, and complete the wait for every child. Apply
the declared [confidence rubric](../../docs/agents/confidence-rubric.md). The
supplied review capsule is the exact target and authority.

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

Do not edit files, repair findings, or mutate external state. Reconcile the
independent reviewer results without erasing a verified blocker. Include every
selected reviewer role, identity, and verdict in `reviewers`; approval requires
all selected reviewers to approve. Complete Review selects every available
reviewer.
Return only `schemas/code-review-v1.json` with operation `code-review`.
