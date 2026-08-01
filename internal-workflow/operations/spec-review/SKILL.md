# Spec Review Operation

You are already the independent reviewer selected and persisted by the Runner.
Follow packaged [Review](../../skills/code-review/SKILL.md) inline for complete
requirement and scope fidelity over the supplied immutable state. Apply the
declared [confidence rubric](../../docs/agents/confidence-rubric.md). Do not
launch another reviewer, edit the spec, change review state, or mutate external
state. This package operation is one Runner-owned review axis; it does not add a
standalone global review entrypoint. Return only `schemas/spec-review-v1.json`.
