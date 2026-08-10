## Parent

#1242

## Source authority

- Source: #1242 and the approved remediation Fix Brief
- Inherited acceptance IDs: A-007, A-010, A-016
- Linked Contract IDs: C-REVIEW-001
- Implementation preparation: direct; no implementation spec.

## Observable outcome

`Run.lifecycle` is the sole validation progression authority. Review targets, receipts, findings, and bounded report repair remain Run data without a nested review lifecycle.

## Acceptance criteria

- [ ] Remove superseded `directReview` status/stage/terminal progression, competing transitions, validators, and tests.
- [ ] A persisted nested review stage cannot conflict with `Run.lifecycle`: the state is unrepresentable or rejected by the exact schema.
- [ ] The first and every repair review inspect the complete immutable current candidate.
- [ ] A repaired candidate receives a new target and an independent reviewer; all prior finding IDs and claimed resolutions are mandatory context.
- [ ] Report-format repair remains bounded acceptance recovery and does not become a semantic review cycle.
- [ ] Full/Closure lifecycle, affected-only approval, and a second review progression owner are absent.
- [ ] No wrapper, pass-through module, or new coordinator is added over the superseded model.
- [ ] Production V2 and `RunIssue` LOC remain below B0 after structural deletion.

## Owner and proof seam

- Owner / public seam: canonical validation progression, Run review-data projection, code-review report validator/capsule.
- Material consumers: direct/spec-first initial flow, check/proof repair, post-PR continuation.
- First proof: conflicting nested state rejection/elimination; repaired candidate full rereview with prior IDs; production symbol/control-flow inventory.
- Proof compatibility: green review tests do not substitute for structural owner deletion.

## Invalidation

- Invalidates: T1/T2 validation and recovery evidence because shared Run owners change.
- Invalidated by: waiting-human progression changes and any final repair; final ticket reproofs.
- Final review contribution: one review-data model under one Run progression owner.

## Verification

- Automated: first-RED persisted conflict and complete rereview scenarios.
- Architecture: owner inventory proves no nested lifecycle, Closure, or workaround wrapper.
- Manual/live: none.

## Blocked by

#1257

## Out of scope / rejected approaches

- Changing defect semantics, weakening reviewer independence, adding a happy-path launch, or replacing one nested state machine with another.
- Prefer structural deletion; corresponding production surface must shrink.

## Final state

AFK: `ready-for-agent`. State does not authorize implementation.
