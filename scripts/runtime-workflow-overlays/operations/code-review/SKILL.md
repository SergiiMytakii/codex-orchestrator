# Code Review Operation

For semantic review execute packaged [Review](../../skills/code-review/SKILL.md).
That skill owns reviewer selection, independence, findings and repair scope.
The packaged [confidence rubric](../../docs/agents/confidence-rubric.md) is supplied as a review resource.
Runner supplies the exact target, authority, proof, previous findings and repair
delta in the review capsule. Available named reviewer profiles are immutable
files at `../../profiles/<role>.toml` from this workflow snapshot.

This invocation is read-only, without external writes. Return only the supplied
code-review report schema. Include selected reviewer identities and verdicts,
current findings and the capsule's exact coverage category IDs. Keep the existing
ID for a retained finding. Historical statuses and revisions belong to Runner.

For `repairOnly: true`, correct the supplied report format using the validation
diagnostic, preserving the completed independent reviewer results, verdict,
findings and risks. This is report correction, not semantic review.
