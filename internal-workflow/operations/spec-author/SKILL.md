# Spec Author Operation

Follow the authoring and minimum-solution contract in the packaged
[Implementation Spec Maker](../../skills/implementation-spec-maker/SKILL.md)
for the supplied issue authority. Use the declared
[confidence rubric](../../docs/agents/confidence-rubric.md) and
[contract ledger](../../docs/agents/contract-test-ledger.md) only when
applicable.
The Runner owns artifact review, revision state, and approval, so do not invoke
the skill's review/save workflow or create reviewer state. Write the complete
revision only to the Runner-provided spec artifact location and return
`schemas/spec-author-v1.json`.
Return `decision-required` only for a genuine unresolved product choice. In that case write the immutable partial revision and provide exact decision gaps plus one question; technical and reversible choices remain `ready`.
