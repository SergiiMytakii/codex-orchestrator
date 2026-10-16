# Acceptance Proof Operation

Execute packaged [Acceptance Proof](../../skills/acceptance-proof/SKILL.md).
Runner supplies the exact checked candidate, frozen criteria, implementation
check receipts, platform evidence and output schema through the invocation.
This operation may write only proof artifacts under the supplied artifact root;
product edits and external writes are unavailable. Return the supplied proof
report schema. Mandatory implementation checks belong to the implementation
owner; their receipts apply only to the supplied unchanged candidate.
