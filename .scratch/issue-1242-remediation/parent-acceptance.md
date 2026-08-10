## Approved remediation graph

Source authority remains the complete body of #1242. This comment records the approved executable remediation packet; it does not change, close, or relabel the planning-context parent and does not itself authorize implementation.

Ordered graph with native blockers:

1. #1256 — monotonic proof and candidate cleanup ownership
2. #1257 — operation-neutral `ActiveAttempt` recovery and launch authorization
3. #1258 — remove nested review progression ownership
4. #1259 — restore finite `spec-frozen` waiting-human settlement
5. #1260 — final exact-HEAD cumulative acceptance and evidence

All children are AFK `ready-for-agent`, execute directly from their issue bodies without another implementation spec, and require structural deletion rather than new lifecycle owners, coordinators, or parallel state paths.

## Parent Acceptance Map

| ID | Approved obligation | Primary | Consumers | Evidence / contracts | Status |
| --- | --- | --- | --- | --- | --- |
| A-001 | Passed `ProofReceipt` is monotonic across cleanup failure | #1256 | #1260 | C-PROOF-001 | planned |
| A-002 | Proof recovery is bounded, exact-result-first, and starts fresh for a new candidate | #1256 | #1257, #1260 | C-PROOF-002 | planned |
| A-003 | Candidate cleanup owner remains until observed postcondition | #1256 | #1257–#1260 | C-CLEANUP-001 | planned |
| A-004 | Recovery kernel is operation-neutral and phase-free | #1257 | #1258, #1260 | C-ATTEMPT-001 | planned |
| A-005 | Trusted answer and authorization are revalidated inside the launch gate | #1257 | #1259, #1260 | C-AUTH-001 | planned |
| A-006 | One bounded unresolved-attempt observation per daemon tick, no semantic spend | #1257 | #1260 | C-ATTEMPT-001 | planned |
| A-007 | One validation loop, review data not lifecycle, full independent rereview, no Closure | #1258 | #1259, #1260 | C-REVIEW-001 | planned |
| A-008 | `spec-frozen` settles exact question plus `agent:waiting-human`; accepted answer resumes without retriage; no `awaiting-user` route | #1259 | #1260 | C-WAIT-001 | planned |
| A-009 | Documentation and generated contracts match production | #1260 | maintainers | final code-first review | planned |
| A-010 | Final owner map and production/`RunIssue` LOC remain below B0 | #1258 | #1260 | structural proof and frozen metrics | planned |
| A-011 | No workflow engine, retry coordinator, queue, cache, dual-write, compatibility, plan interpreter, or new lifecycle owner | #1260 | all children | cumulative inventory | planned |
| A-012 | Exact-HEAD checks, fault matrix, pack, authorized scratch smoke, cleanup, and cumulative review | #1260 | parent acceptance | frozen-materialization evidence | planned |
| A-013 | Claim, `DeliveryAuthority`, and prelaunch authorization remain exact | #1257 | all children, #1260 | C-AUTH-001, C-AUTHORITY-002 | planned |
| A-014 | Containment, denied paths, and credential isolation remain exact | #1260 | all children | C-CONTAINMENT-001 | planned |
| A-015 | Candidate/tree trust plus `CheckedChange` and Acceptance Proof binding remain exact | #1256 | #1260 | C-CHECKED-001, C-PROOF-* | planned |
| A-016 | Reviewer independence is preserved | #1258 | #1260 | C-REVIEW-001 | planned |
| A-017 | Initial and post-PR publication remain finite, intent-based, and idempotent | #1256 | #1260 | C-PUBLICATION-001 | planned |
| A-018 | No release, remote code push, consumer update, daemon restart, production smoke, or automatic merge | #1260 | all children | scope review | planned |

## Contract Test Ledger

| Contract ID | Approved claim | Primary | Consumers | First proof | Valid at SHA | Status |
| --- | --- | --- | --- | --- | --- | --- |
| C-PROOF-001 | Passed receipt survives cleanup and applies only to its exact candidate/request | #1256 | validation, publication, mobile leases, #1260 | pass → cleanup failure plus stale-receipt reuse attempt | none | planned |
| C-PROOF-002 | Proof report/transport recovery is numerically bounded, exact-result-first, and fresh per candidate | #1256 | #1257, #1260 | malformed/transport/replacement/new-candidate matrix | none | planned |
| C-CLEANUP-001 | Candidate owner is removed only after observed pin-release postcondition | #1256 | #1257–#1260 | release failure → restart → observation | none | planned |
| C-ATTEMPT-001 | Recovery is operation-neutral, one-tick bounded, and adopts exact result before replacement | #1257 | every operation family, #1258, #1260 | structural inventory plus live/unknown/PID-reuse matrix | none | planned |
| C-AUTH-001 | Answer, permission, and issue authorization are revalidated inside the launch gate | #1257 | spec/implementation, #1259, #1260 | revocation barrier between prepare and launch | none | planned |
| C-REVIEW-001 | Every changed candidate receives full independent review with prior findings and no nested lifecycle | #1258 | initial/post-PR/check/proof repair, #1260 | conflicting-state and repaired-candidate sequence | none | planned |
| C-WAIT-001 | Question and waiting label settle once; accepted answer resumes without retriage | #1259 | setup/spec/daemon, #1260 | every comment/label crash and lost-response boundary | none | planned |
| C-AUTHORITY-002 | Exact direct/spec `DeliveryAuthority` survives every downstream consumer | #1260 | all children | source-to-consumer trace plus mismatch fixture | none | planned |
| C-CONTAINMENT-001 | Worker credentials, network, deny paths, generation, and host mutation authority are not widened | #1260 | all children | package containment contracts plus production inventory | none | planned |
| C-CHECKED-001 | One candidate/tree/authority/check policy binds `CheckedChange` and proof | #1256 | #1260 | mixed candidate/receipt sequence | none | planned |
| C-PUBLICATION-001 | Only the exact passed candidate settles each initial/post-PR effect once; unknown remains observation-only | #1256 | #1260 | effect-before-ack/restart matrix | none | planned |

Shared-owner changes make prior green rows stale. #1260 must reprove every row from one clean detached materialization of the final frozen HEAD. A source-authorized defect is repaired and re-reviewed; a new product decision returns an exact Decision Delta.

Controlled live smoke is authorized only in the configured scratch GitHub repository after authenticated/exclusive preflight with strict cleanup. Production-repository smoke remains forbidden.
