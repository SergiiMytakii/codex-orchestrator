# Issue #1254 completion proof

Baseline: #1253 checkpoint `710b612`.

## Result

- `RunIssue` remains the repository-owner adapter for lock acquisition, fresh
  issue/permission authorization, Run CAS, bounded phase dispatch, and terminal
  projection. Durable phase, authority, budgets, receipts, and terminal status
  remain fields of the one canonical Run.
- Spec answer observation and trust revalidation moved to `spec-answer.ts`.
  The seam accepts immutable spec/issue facts plus a permission reader and
  returns only frozen/accepted/valid domain projections; it has no store,
  lifecycle, worker launch, effect, retry, or publication ownership.
- The pass-through `runImplementation` wrapper was deleted. Run dispatch now
  calls the existing typed implementation operation directly with the one
  Runner-owned signal and ActiveAttempt hooks.
- Validation budget selection moved to `validation-progression.ts`, its domain
  owner. The route-independent Run budget is no longer selected by a RunIssue
  helper.
- The one-use `reviewReadyObservationBlocked` wrapper and duplicate inline spec
  question/answer normalization, ordering, permission, and marker checks were
  deleted.
- Existing bounded seams now own their domains: `DeliveryAuthority`,
  `SpecDelivery`/`spec-answer`, `ActiveAttempt`, `validation-progression`,
  `pending-effect-settlement`, candidate/CheckedChange, and Acceptance Proof.
  None owns a parallel Run lifecycle.

## Final owner map

Durable Run-lifecycle owners:

1. Run aggregate: phase, DeliveryAuthority, semantic budgets, findings,
   candidate/check/proof receipts, feedback epoch, and terminal projection.
2. Optional ActiveAttempt: one process/result/cleanup identity.
3. Optional PendingEffect: one finite local/Git/GitHub intent and observed
   postcondition.

Repository locks, atomic-store locks, candidate pins/materializations, and
device leases remain finite resource primitives only. They do not select a
phase, launch replacement work, or own a semantic budget.

Deleted cumulative mechanisms at this final structural slice: legacy state
readers/migration branches, waiting-human route owner, downstream route binding
fallbacks, report/mutable/proof invocation owners, Full/Closure progression,
`reworking`, `route-ready`, route-specific validation wrappers, duplicate
publication settlement decisions, and unowned candidate cleanup.

## Metrics

- #1253 baseline: 21,790 V2 production LOC / 4,112 RunIssue LOC.
- #1254 HEAD: 21,822 V2 production LOC / 3,996 RunIssue LOC.
- Slice delta: `+32` V2 / `-116` RunIssue.
- B0: 22,704 V2 production LOC / 4,142 RunIssue LOC.
- Net against B0: `-882` V2 / `-146` RunIssue.

The small V2 increase in this slice is the bounded spec-answer seam replacing
RunIssue-owned trust logic. The graph still has substantial net production
deletion, while the central adapter itself decreases both in this slice and
against B0.

## Verification

- Domain architecture suite (Run, route, spec, ActiveAttempt, validation,
  PendingEffect): 51/51 passed.
- Product routes: direct, spec-first, trusted product answer, direct post-PR,
  and spec-first post-PR passed.
- Recovery/repair: safe-halt one-tick recovery, check/proof rework, candidate
  drift, and unsupported-state effect-free rejection passed.
- Spec answer focused matrix (trusted, conflicting, edited, wrong-marker,
  permission-unverifiable, and launch-time revalidation): 6/6 passed.
- Publication crash/fault and residual-byte proof is inherited unchanged from
  #1253 and remains covered by its named handler tests.
- Build, typecheck, and `git diff --check`: passed.

The complete package suite, generated-contract consistency, exact final HEAD
proof, and authorized scratch live smoke remain #1255 gates.
