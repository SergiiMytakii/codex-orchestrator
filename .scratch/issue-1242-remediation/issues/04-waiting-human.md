## Parent

#1242

## Source authority

- Source: #1242 and the approved remediation Fix Brief
- Inherited acceptance IDs: A-008
- Linked Contract IDs: C-WAIT-001
- Implementation preparation: direct; no implementation spec.

## Observable outcome

An unresolved product question settles the exact marker-bound question and `agent:waiting-human` label as sequential finite effects, while trusted answer acceptance resumes the same Run without an `awaiting-user` route or retriage.

## Acceptance criteria

- [ ] Exact question comment settles first, then exact waiting-human label set settles, with at most one `PendingEffect` at any time.
- [ ] Stable payload-derived effect identities and observed postconditions cover failure before comment, remote comment success with lost response, after comment confirmation before label intent, remote label success with lost response, after label confirmation before Run projection, and replay.
- [ ] Replay never duplicates the question or omits the label.
- [ ] Invalid, edited, deleted, wrong-marker, revoked, or permission-unverifiable answer remains `spec-frozen` and launches no worker.
- [ ] Accepted answer uses a finite label transition to remove waiting state, creates the next immutable spec revision and independent review, and never reruns triage.
- [ ] Config, setup, and generated/public label contracts include `agent:waiting-human` exactly.
- [ ] No `awaiting-user` result/route, waiting lifecycle/store, question-specific budget, retry workflow, or compatibility alias is introduced.

## Owner and proof seam

- Owner / public seam: config/setup label contract, spec question Run data, finite comment/label `PendingEffect`, trusted-answer observation.
- Material consumers: setup, spec-first Run, daemon projections.
- First proof: exact product-question flow plus every crash/lost-response boundary and trusted-answer matrix.
- Proof compatibility: the proof must observe both GitHub effects and durable replay behavior.

## Invalidation

- Invalidates: T1-T3 evidence touching `PendingEffect`, Run progression, authorization, or generated contracts.
- Invalidated by: any final repair; final ticket reproofs all rows.
- Final review contribution: visible, fail-closed human checkpoint without a second lifecycle.

## Verification

- Automated: crash/replay/trust matrix through production settlement handlers.
- Architecture: one Run and one-at-a-time finite effect; no waiting state machine.
- Manual/live: none for local completion.

## Blocked by

#1258

## Out of scope / rejected approaches

- Separate waiting workflow, queue, retry coordinator, store, semantic budget, migration, or compatibility path.
- Prefer structural deletion and existing finite settlement seams.

## Final state

AFK: `ready-for-agent`. State does not authorize implementation.
