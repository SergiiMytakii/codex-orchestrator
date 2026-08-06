# ADR 0003: Plan, Implement, Review lifecycle

Status: accepted and implemented by issue #1262.

## Decision

The package executes one open Issue explicitly authorized by the configured auto label. Plan, specification composition, ticket slicing, and multi-ticket coordination remain external. A Run owns one progression:

`implementation → affected checks → Acceptance Proof → Review → publication`

The first Review is complete and covers requirement fidelity plus correctness and repository standards. A Review finding opens one consolidated Implement-owned repair batch. When impact is isolatable, the next fresh affected reviewer receives the previous target identity, candidate repair delta, repaired blocker IDs, direct impact cone, and affected proof: Spec for requirement coverage or behavior, Standards for correctness or mandatory rules, and both when the repair crosses lenses or cannot be isolated. Approval outside that cone is preserved. Semantic cycle, reviewer, and post-PR round counts are correlation data, not stop conditions.

Transport, timeout, launch, observation, report-format, and tooling failures return resumable issue-local outcomes. Each invocation remains bounded. Existing ActiveAttempt, PendingEffect, candidate binding, Checked Change, ProofReceipt, containment, and fast-forward publication mechanisms remain the only durable owners.

## Structural deletion proof

| Responsibility | Before | After |
| --- | --- | --- |
| Planning route | `route-coordinator`, `route-decision`, `route-continuations`, `triage-route` | External Plan; no package runtime owner |
| Specification lifecycle | `spec-coordinator`, `spec-delivery`, `spec-answer` | External planning artifacts; no package runtime owner |
| Validation order | implementation, full Review, checks, proof | implementation, affected checks, proof, complete or targeted Review |
| Semantic stop policy | implementation, reviewer-report, transport, and PR-feedback counters | no numeric semantic stop condition; bounded resumable invocation |
| Repair Review | full rereview | targeted delta and impact cone; complete only when isolation is unavailable |

The cutover deletes seven production route/spec modules, four dedicated route/spec test modules, three packaged operations, and their three output schemas. The generated workflow operation inventory shrinks from six owners to three: implementation, acceptance-proof, and code-review. No replacement coordinator, queue, scheduler, ledger, compatibility alias, or state-machine framework is introduced.

## Consequences

- Planning context or a Parent relationship alone cannot authorize delivery.
- Decision Delta, out-of-scope work, ownership conflict, containment failure, and unprovable required behavior stop at an issue-local boundary.
- Proof receipts and Review refer to the same immutable candidate; candidate drift invalidates affected proof before Review.
- Trusted same-repository PR feedback uses the same targeted repair progression and fast-forward-only publication.
- Legacy run-state bytes containing removed route or specification fields fail the exact schema instead of entering a compatibility path.
