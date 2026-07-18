# Artifact Review Loop

Use this policy whenever `plans-maker` or `implementation-spec-maker` reviews an
artifact. This target-specific Module owns artifact preflight, review-risk
classification, scope conservation, reviewer topology, and artifact outcome
mapping. It applies [`review-protocol.md`](review-protocol.md) for context
transfer, Full/Closure mechanics, defect lifecycle, no-progress, and the common
result envelope.

The Module sits at the Seam between artifact-authoring skills and the existing
`plan-review` and `implementation-spec-review` Adapters. Callers provide an
artifact and source authority; they do not reproduce either Module.

## Interface

Conceptually, callers use one operation:

```text
review_artifact(
  artifact_kind,
  artifact_path,
  source_references,
  approved_decisions,
  risk_profile = auto
) -> review_outcome
```

`review_outcome` contains:

- `outcome`: `Approved | Blocked | Waived`
- `adapter_verdict`: `Approved | Needs Work | Rejected | Not run`
- `risk_profile`: `simple | medium | high`
- `risk_reasons`: evidence-backed classification signals
- `review_passes`, `full_reviews`, `closure_reviews`, and `fresh_sessions`
- mandatory-lens coverage
- the Defect Ledger, including every unresolved blocker or execution risk

The caller may explicitly raise the risk profile. It must not lower an
evidence-backed profile or override a hard escalator.

Reviewer Adapters themselves return only `Approved`, `Needs Work`, or
`Rejected`. `Blocked` is a Module-level terminal outcome produced by preflight
or a convergence stop rule; it is never invented by an individual reviewer.
`Waived` is also Module-level and requires an explicit user instruction to skip
remaining artifact review. Preserve the latest Adapter verdict when reviews
already ran; use `Not run` only when no reviewer ran.

## Preflight And Risk Classification

Run preflight before the first reviewer. Confirm source authority, approved
scope, user decisions, external contracts, and the current artifact revision.
Unknown product decisions or missing mandatory evidence block before review and
do not start a reviewer.

A useful preflight-blocked artifact may be saved with zero reviews. Record the
Module outcome as `Blocked`, `Review Passes: 0`, and the exact blocking
unknown; do not invent an Adapter verdict for a reviewer that never ran.

Classify risk by the consequence and uncertainty of being wrong, not by file
count or estimated implementation effort.

### Hard Escalators

`high` requires a sensitive mechanism, an evidence-backed material consequence,
and at least one uncertainty amplifier: competing or unclear ownership, a
cross-trust-boundary effect, non-local rollback/recovery, an unproven external
contract, or proof that cannot isolate the material failure. A sensitive
mechanism with one proven owner, a local pattern, bounded rollback, and direct
proof remains a standard signal rather than a hard escalator.

| Sensitive mechanism | Material consequence required for `high` |
| --- | --- |
| Durable data, transaction, migration, schema | Corruption/loss, irreversible reinterpretation, or non-trivial rollback/backfill |
| Concurrency, ordering, queue, retry, idempotency, shared state | Duplicate external effect, cross-worker invariant violation, corrupt/false durable state |
| Auth, secrets, permissions, payments, destructive writes | Access/secret leak, incorrect money movement, or user/production data destruction |
| Background processing or multiple writers | Ambiguous recovery ownership or competing source-of-truth ownership |
| Unknown external contract, multi-agent integration, rollout | Safety-critical/irreversible failure or any material consequence above |

### Standard Signals

Without a hard escalator, count: user-visible behavior; multiple Modules/runtime
surfaces; shared Interface/DTO/event/serialization changes; non-trivial
error/fallback/timeout/recovery; a known external contract; or a narrow sensitive
mechanism retained inside one proven owner and local pattern.

Use this deterministic mapping:

| Profile | Classification |
| --- | --- |
| `simple` | No hard escalator and 0-2 standard signals |
| `medium` | No hard escalator and 3-5 standard signals |
| `high` | Any hard escalator or 6+ standard signals |

File count is never decisive: one trust-boundary line can be `high`, while a
broad mechanical rename can remain `simple` or `medium`.

Record the decision in the artifact:

```yaml
review_profile: simple | medium | high
review_reasons:
  - "<signal>: <source or repo evidence>"
```

## Scope Conservation

Review profile controls review depth, not artifact size or solution breadth.
Risk may require stronger proof or more independent review, but it does not
authorize extra product behavior, runtime layers, or operational machinery.

Each review repair must preserve the approved scope. When it resolves the
failure, delete or narrow the proposal before adding a mechanism. Do not add
feature flags, telemetry systems, dashboards, rollout machinery, compatibility
paths, generic fallbacks, or other operational features unless the source
explicitly requires them or a concrete evidenced failure path makes them
necessary. Optional improvements remain optional and outside the artifact
unless the source authority or user explicitly approves them.

If review discovers a higher-risk signal, escalate immediately. Keep completed
review passes in the audit trail; do not discard valid coverage or automatically
restart the loop. A user decision within approved scope also does not reset the
defect history. A genuinely new product scope starts a new artifact revision
only when the root explicitly says so and reports the previous outcome.

When escalation to `high` occurs after reviews have started, do not pretend the
initial full reviews were parallel. Preserve completed coverage, assign it to
the matching high-risk lens set, and run only the missing full lens review. Then
use affected-lens Closure for repaired defects.

## Review Capsule

Use the protocol capsule with these artifact fields:

- the unanswered artifact question and any prior coverage it invalidates
- current saved artifact content and artifact kind
- approved scope, out of scope, and Decision Snapshot
- source-authority paths or URLs
- Evidence Index entries of `claim -> file:symbol`, artifact section, or trusted
  URL

For Closure, map artifact sections into the protocol Revision Map.

## Review Modes

Use protocol Full and Closure without redefining them. Artifact Closure maps
`affected_targets` to changed sections and source contracts. A substantive
artifact rewrite requires a new Full pass only when existing mandatory-lens
coverage is no longer valid.

## Risk-Aware Topology

`simple` uses one `reviewer_fast` session, `medium` uses one
`reviewer_standard` session, and `high` uses two independent `reviewer_deep`
sessions with disjoint primary lenses. Root always launches these children and
never executes the Adapter as self-review. The Adapter runs inline only inside
the already assigned reviewer child because children cannot spawn grandchildren.
Both high-profile full reviews are required for approval. Review counts are
audit and performance metrics, never terminal limits.

### Simple And Medium

Use one profile-selected reviewer lineage and one Full pass. After each
consolidated repair batch, use protocol Closure until its lenses are clear or
protocol no-progress/stop rules apply.

Default initial sessions: 1. Default full reviews: 1.

### High

When `high` is known at preflight, split primary lenses exactly as follows:

- **Architecture/Execution:** source authority, scope, determinism, evidence,
  preconditions, architecture and ownership, sequencing/slices, reuse and
  simplicity, validation, and handoff.
- **Failure/Contracts:** state transitions, concurrency and ordering,
  persistence, retry/idempotency, external/runtime contracts, auth/security,
  destructive behavior, partial failure/recovery, and Contract Test Ledger.

Each reviewer owns its assigned primary lenses. It may report a concrete
cross-lens defect, but it does not repeat the other reviewer's broad discovery.
Root aggregates both results and verifies that their combined coverage includes
all mandatory lenses and cross-lens defects before approval.

1. Reviewer A performs a full Architecture/Execution review.
2. Reviewer B performs a full Failure/Contracts review in parallel with review
   1. The two briefs have disjoint primary lenses and both reviewers remain
   independent.
3. After one consolidated repair batch, apply protocol Closure only to affected
   A/B lineages, in parallel when both are affected.
4. Stop when both lens sets are clear on the same settled revision or protocol
   stop/no-progress rules apply.

Default initial sessions: 2. Default full reviews: 2. Closure sessions rotate by
protocol; another Full requires invalidated mandatory-lens coverage.

Root owns launches, aggregation, repairs, and final decisions. Parallel launch
must preserve and close every fulfilled handle even after partial failure.

## Defect Ledger

Use the canonical protocol ledger. Artifact locations are stored in
`affected_targets` as sections or source contracts. Artifact proof-contract gaps
always use `repair-now` and reopen artifact review; they cannot use
`planned-final-verification`.

## Convergence And Stop Rules

Apply protocol repair, no-progress, stop, and waiver semantics first. Return
`Approved` only when all of these artifact conditions also hold:

- the verdict applies to the current saved artifact content
- source authority and approved scope still match the artifact

Persist mandatory-lens coverage with the outcome. Any substantive edit after
approval invalidates `Approved` until the saved artifact passes the applicable
Module path again. Updating only lifecycle and review-result metadata does not
invalidate approval.

Map protocol `stopped` to `Blocked`. Artifact-specific blockers also include:

- a defect repeatedly reopens and exposes a source-of-truth or repair-design
  conflict that root cannot resolve from current evidence
- the next repair needs a product, scope, ownership, or risky trade-off decision
- the artifact did not change after `Needs Work` or `Rejected`

Map protocol `waived` to `Waived` only when preflight is complete and no known
blocker or unaccepted execution risk is open, blocked, or fixed-but-unverified.
Otherwise record the waiver and return `Blocked`. Preserve `Adapter Verdict: Not
run` or the last real Adapter verdict.

Map terminal outcomes to artifact status without guesswork:

- `Approved`: plan may be `ready-for-approval` or user-approved; spec may be
  `ready`.
- `Blocked`: plan/spec status is `blocked`.
- `Waived`: plan/spec may be ready under the eligible mapped waiver; keep it
  visible in metadata and the final response.

`Needs Work` and `Rejected` remain Adapter verdicts, never durable Module
outcomes.

Skipping further artifact review never implicitly skips implementation
checkpoints, cleanup review, final code review, tests, or runtime validation.
Those are separate contracts and require their own explicit waiver when policy
allows one.

## Required Outcome Summary

Use the protocol result envelope and add:

```text
Review Profile: <simple | medium | high>
Review Outcome: <Approved | Blocked | Waived>
Adapter Verdict: <Approved | Needs Work | Rejected | Not run>
```

For performance evaluation, also retain per-review mode, start/end timestamps,
and tool-call count when the runtime exposes them. Compare wall-clock time and
token/tool usage separately.

## Contract Test Ledger

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| Risk classification requires a material consequence for hard escalation; narrow use of a sensitive mechanism remains a standard signal. | Simple stateful work is over-reviewed or genuinely dangerous work is under-reviewed. | Manual eval scenario 10 | planned |
| High-risk work uses two parallel Full lineages while protocol owns affected-lens Closure and session rotation. | Follow-up restarts Full review, retains stale context, or loses mandatory-lens coverage. | Manual eval scenarios 10-11 | green |
| Substantive edits invalidate approval while lifecycle-only edits do not. | A changed plan/spec is executed under stale approval. | Review-state inspection | green |
