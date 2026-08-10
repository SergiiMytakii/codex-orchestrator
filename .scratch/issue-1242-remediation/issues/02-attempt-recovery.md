## Parent

#1242

## Source authority

- Source: #1242 and the approved remediation Fix Brief
- Inherited acceptance IDs: A-004, A-005, A-006, A-013
- Linked Contract IDs: C-ATTEMPT-001, C-AUTH-001
- Implementation preparation: direct; no implementation spec.

## Observable outcome

`ActiveAttempt` recovery performs only process/result mechanics, while trusted answer, permission, and issue authorization are revalidated inside the actual durable `prepared → launched` gate.

## Acceptance criteria

- [ ] Recovery contains no switch, conditional, table, or callback selection based on triage/spec/implementation/review/check/proof identity.
- [ ] `operationId` and `operationSourceId` may correlate an exact result but cannot select lifecycle or semantic progression.
- [ ] Run progression outside the kernel selects phase through CAS.
- [ ] Trusted answer bytes/marker/source, WRITE/ADMIN permission, and issue authorization are revalidated after preparation immediately before process launch.
- [ ] Revocation or mutation between preparation and launch creates no process, durable semantic state, or budget effect.
- [ ] Exact attempt-owned result is adopted before replacement; replacement requires confirmed process/result absence.
- [ ] Live or unknown process releases the issue loop; one daemon tick performs at most one bounded observation and spends no semantic budget.
- [ ] Containment, claim authority, process fences, and cleanup postconditions remain fail closed.

## Owner and proof seam

- Owner / public seam: `ActiveAttempt`, launch gate callback, Run CAS progression, spec-answer revalidation.
- Material consumers: triage, spec author/reviewer, implementation, review, checks, proof, daemon safe-halt.
- First proof: revocation barrier between prepare and launch; operation-family recovery matrix; live/unknown/absent/PID-reused observations; structural inventory proving no operation-family semantic branch.
- Proof compatibility: both production control-flow proof and public behavior matrix are required.

## Invalidation

- Invalidates: prior C-ATTEMPT-001/C-AUTH-001 evidence and T1 evidence touching `ActiveAttempt` or Run recovery.
- Invalidated by: later Run progression/launch changes; final ticket reproofs every row.
- Final review contribution: operation-neutral, launch-authorized recovery.

## Verification

- Automated: first-RED authorization TOCTOU and recovery-family fault matrix.
- Architecture: recovery kernel must return only mechanical observation/adoption/cleanup facts.
- Manual/live: none.

## Blocked by

#1256

## Out of scope / rejected approaches

- Phase-aware recovery, generic workflow engine, durable retry counters, new coordinator, weakened containment or claim authorization.
- Prefer structural deletion; no lifecycle owner, parallel state path, or wrapper over old recovery.

## Final state

AFK: `ready-for-agent`. State does not authorize implementation.
