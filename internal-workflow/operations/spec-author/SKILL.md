# Spec Author Operation

Follow packaged [To Spec](../../skills/to-spec/SKILL.md) for the supplied issue
authority and apply the declared [confidence
rubric](../../docs/agents/confidence-rubric.md). The Runner owns artifact
review, revision state, and approval, so do not invoke publication or create a
second workflow owner. Write the complete revision only to the Runner-provided
spec artifact location and return `schemas/spec-author-v1.json`.
Return `decision-required` only for a genuine unresolved product choice. In that case write the immutable partial revision and provide exact decision gaps plus one question; technical and reversible choices remain `ready`.
