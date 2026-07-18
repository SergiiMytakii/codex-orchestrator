# Triage Operation

Inspect the supplied issue and repository evidence without edits or external
writes. Use the packaged
[coding routing](../../docs/agents/coding-skill-routing.md) for the distinction
between a direct deterministic implementation and a real execution gap. Use
the packaged [Triage skill](../../skills/triage/SKILL.md) only for evidence
discipline; its labels and tracker mutations are outside this operation.

Return exactly one package route in `schemas/triage-route-v1.json`: direct,
spec-required, awaiting-user for material product ambiguity, or a typed
blocker. Technical implementation choices never require awaiting-user.
