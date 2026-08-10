## Parent

#1242

## Source authority

- Source: #1242 and the approved remediation Fix Brief in the planning conversation
- Inherited acceptance IDs: A-001, A-002, A-003, A-015, A-017
- Linked Contract IDs: C-PROOF-001, C-PROOF-002, C-CLEANUP-001, C-CHECKED-001, C-PUBLICATION-001
- Implementation preparation: direct — execute this issue body and inherited parent authority; do not create an implementation spec.

## Observable outcome

A passed `ProofReceipt` remains durable through cleanup failure, proof report/transport recovery is bounded and exact-result-owned, and candidate binding/pin ownership is removed only after a finite `candidate-pin-release` effect observes its exact postcondition.

## Acceptance criteria

- [ ] Every passed or cleanup-pending proof projection remains bound to the exact `CheckedChange` SHA, candidate binding/tree, `DeliveryAuthority` SHA, configured-check policy SHA, proof request/proof ID, candidate revision, and HEAD.
- [ ] A stale, out-of-order, or prior-candidate receipt is rejected before publication and cannot suppress proof for a replacement candidate.
- [ ] Exactly one report-only repair is allowed for malformed proof output and exactly one infrastructure transport replacement is allowed per unchanged proof request.
- [ ] Replacement is allowed only after exact result adoption or confirmed process/result absence; neither recovery spends an implementation semantic cycle.
- [ ] A second malformed result terminates as typed `internal-error` without publication; a second transport failure terminates as the existing typed resumable `transport-failed` projection with exact recovery evidence retained.
- [ ] A new candidate clears old `proofExecution`, proof identity, receipt, and counters.
- [ ] Passed proof is never rerun solely because cleanup remains pending.
- [ ] Candidate binding and pin ownership remain durable until `candidate-pin-release` observes the exact postcondition; restart never loses or duplicates cleanup.
- [ ] `external-block` remains external and is never mapped to `needs-work`.
- [ ] No proof store, cleanup coordinator, retry coordinator, generic plan interpreter, or second lifecycle owner is introduced.

## Owner and proof seam

- Owner / public seam: `AcceptanceProof` result union and `ProofReceipt`; Run proof projection; `ActiveAttempt` adoption/cleanup; candidate binding and finite `PendingEffect` settlement.
- Material consumers: initial and post-PR validation loops, publication, mobile proof leases, candidate pin reconciliation.
- First proof: pass then cleanup throw; stale receipt after a new candidate; malformed/transport numeric bounds; pin-release failure and restart.
- Proof compatibility: tests must cross the same production seams used by Run; helper-only state tests cannot satisfy the contracts.

## Invalidation

- Invalidates: current proof/cleanup evidence and all linked Contract IDs.
- Invalidated by: every subsequent graph ticket that changes `RunIssue`, `RunRecord`, `ActiveAttempt`, validation progression, or `PendingEffect`.
- Final review contribution: monotonic exact-candidate proof and intent-owned cleanup.

## Verification

- Automated: first-RED violating sequences plus the smallest affected proof/Run/candidate settlement suite.
- Architecture: prove no new durable owner and no parallel proof/cleanup progression.
- Manual/live: none.

## Risk / Review

- Primary risk: preserving passed proof while accepting it for a different candidate.
- Main invariant: proof identity and cleanup ownership remain exact and monotonic.
- Review focus: stale receipt reuse, exact-result adoption, cleanup crash windows, structural deletion.

## Blocked by

None — can start immediately.

## Out of scope / rejected approaches

- New workflow engine, queue, cache, retry coordinator, proof store, cleanup coordinator, dual-write, compatibility path, or migration.
- Weakening authority, candidate/tree trust, `CheckedChange`, Acceptance Proof, containment, or publication policy.
- Prefer structural deletion. The ticket is incomplete if it adds a lifecycle owner, coordinator, parallel state path, wrapper over the superseded mechanism, or fails to reduce the corresponding production surface.

## Final state

AFK: `ready-for-agent`. State does not authorize implementation.
