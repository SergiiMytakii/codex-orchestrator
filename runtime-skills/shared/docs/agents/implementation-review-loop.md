# Implementation Review Loop

Use this policy for reviews performed while executing an approved implementation
spec. It is the single Module that owns whole-spec review budgets, review modes,
gate ordering, defect closure, and convergence. `spec-implementer`,
`cleanup-review`, and `code-review` are callers or Adapters; they must not create
their own retry loops.

This policy does not replace tests, architecture checks, smoke tests, or Git
checkpoints. Those proofs do not consume review budget.

## Interface

Conceptually, the executor uses:

```text
review_implementation(
  spec_path,
  review_profile,
  current_revision,
  checkpoint,
  review_focus,
  defect_ledger
) -> review_outcome
```

The outcome records:

- `outcome`: `Approved | Blocked | Waived`
- `review_profile`: `simple | medium | high`
- `reviews_used` and `reviews_remaining`
- review mode, reviewer/session identity, target revision, and assigned lenses
- stable defect IDs and their current status
- mandatory final reviews still reserved

## Profile And Whole-Spec Budget

Prefer the approved spec's `review_profile`. If it is absent, use the same
evidence-based classification and hard escalators as
[`artifact-review-loop.md`](artifact-review-loop.md). Actual implementation
evidence may raise the profile but must not lower it.

The budget applies to the whole spec execution, including intermediate
checkpoints, cleanup review, final code-review tracks, and closure passes. It is
not a per-slice or per-phase allowance.

| Profile | Maximum completed reviews |
| --- | ---: |
| `simple` | 2 |
| `medium` | 3 |
| `high` | 6 |

Every independent reviewer result counts as one completed review. Parallel reviewer results count separately; parallelism reduces wall-clock latency, not
budget usage. A reviewer that fails before returning a usable result does not
consume budget, but root must close the failed session.

Escalation preserves reviews already used and never resets the counter. A user
pause, context compaction, slice commit, worker replacement, or new turn also
never resets it. A genuinely new approved spec starts a new budget; editing the
current spec to evade exhaustion does not.

Budgets are maxima, not quotas. Stop early when mandatory coverage is complete
and no blocking defect remains.

## Budget Planning

Before the first implementation reviewer, root creates a short Review Plan:

- current profile and maximum budget
- explicit intermediate checkpoints and their required lenses
- final cleanup requirement
- final code-review lenses and minimum independent coverage
- slots conditionally available for closure

## Durable Review State

Persist the Review Plan in the approved spec under
`## Implementation Review State` before the first reviewer launch. This is the
execution ledger for review state; do not keep the authoritative counter only
in chat context or a Runner-owned nodes summary.

Record at least:

- profile, maximum budget, reviews used, and reviews remaining
- reserved mandatory final slots and their lenses
- pending reviewer launches with launch ID, mode, reviewer/session identity,
  target revision, and assigned lenses
- every completed review's mode, reviewer/session identity, target revision,
  assigned lenses, and outcome
- the stable Defect Ledger with transition history, reopen count, fixed revision,
  verifying review, and any explicit risk acceptance

Write a pending launch before starting its reviewer. After the launch returns,
replace the pending record with either its usable completed result or a failed,
closed session record; only a usable result increments `reviews_used`. A context
compaction, new turn, resumed task, or different root agent must reconcile every
pending launch with its recorded session before starting a replacement.

Update this section after each launch, usable reviewer result, repair batch,
closure, waiver, acceptance, reopen, or terminal outcome. A resumed executor
reconstructs accounting and lifecycle history from this persisted state. If the
state is missing or internally inconsistent after reviews began, return
`Blocked` until it is reconciled from available thread/session evidence; never
assume zero reviews used or silently replace an in-flight reviewer.

Reserve mandatory final review slots before launching an intermediate review.
Do not spend a reserved final slot on another fresh checkpoint reviewer or a
repeat broad audit. If the spec requires more independent checkpoints than the
profile can support while preserving final coverage, return `Blocked` for spec
revision before consuming the impossible slot.

The default shapes are:

- `simple`: validation only when policy does not require review; otherwise one
  final Full review and one conditional Closure.
- `medium`: preserve final hygiene and correctness/spec coverage within three
  results. An explicit intermediate checkpoint may provide one required lens;
  the final integrator must cover every remaining lens and verify its defects.
- `high`: use parallel independent tracks only for disjoint mandatory lenses;
  preserve at least one final cleanup/integrator path and use remaining slots
  for checkpoint coverage or conditional Closure. No path exceeds six.

`code-review` may use its normal two final tracks when budget permits. It may use
one fresh final integrator only when earlier independent coverage already
covered both correctness and spec/standards axes and the integrator receives
their compact handoffs.

## Review Capsule

Every Full reviewer receives a bounded capsule:

- spec path, profile, current revision, checkpoint, and exact diff command
- changed paths and assigned `Review Focus` lenses
- source-of-truth docs and relevant Contract Test Ledger rows
- compact validation results and known verification gaps
- compact Defect Ledger with stable defect IDs

Do not pass raw parent history, repeated test logs, old diff versions, or full
prior reviewer prose. A reviewer may inspect additional code needed to prove a
finding.

For Closure, add only the repair diff, changed tests, affected contracts, and a
Revision Map of `changed path/section -> defect IDs -> affected invariants`.

## Review Modes

### Full

A Full review reads the complete pinned target required by its assigned lenses.
It returns all visible evidence-backed blockers and execution risks as one
batch. It must not intentionally drip findings across future passes.

Each finding receives a stable defect ID. Root deduplicates by protected
invariant and failure mechanics; rewording the same issue does not create a new
defect.

### Closure

A Closure review uses the same reviewer session through a follow-up. It verifies
the repaired stable defect IDs, the repair diff, and regression fan-out across
affected contracts. It must not re-audit unchanged areas or restart broad code
discovery.

Closure may report a genuinely new defect only when the repair introduced it,
made it observable, or changed a connected invariant. Root adds that defect to
the ledger and repairs it in the next available closure or reserved mandatory
Full review. A new reviewer is not launched merely because Closure found a new
defect.

## Defect Lifecycle

Use these statuses:

```text
open -> fixed -> verified
  |       |         |
  |       v         v
  |    blocked   reopened
  v
accepted (execution risk only)
```

Record at least: ID, severity, confidence, protected invariant, failure
mechanics, evidence, repair, affected paths/contracts, introduced review,
transition history, reopen count, fixed revision, and verifying review.

`fixed` is not terminal. A later Closure or reserved Full reviewer with the
affected lenses must mark every repaired blocker and execution risk `verified`.
Tests prove behavior but do not turn a review defect into an independently
verified result by themselves.

Only an execution risk may become `accepted`, and only after an explicit user
decision. Record who accepted it, the reason, scope, and target revision in the
durable ledger. Root may not infer acceptance from silence, schedule pressure,
or remaining budget. A blocker cannot be accepted as ordinary residual risk;
skipping its gate follows the explicit `Waived` outcome instead.

## Gate Ordering

1. Implement the slice and pass its tests/exit gate.
2. At an explicit intermediate checkpoint, run the required targeted
   `code-review` directly under the Review Plan.
3. Repair one consolidated finding batch and use Closure only when an available
   slot is not reserved for a later Full review. Otherwise the next reserved
   Full reviewer verifies the repair.
4. Continue implementation only when checkpoint blockers are verified or the
   Review Plan explicitly assigns their verification to a reserved reviewer
   without violating the checkpoint's safety purpose.
5. After all implementation slices and validations settle, run final cleanup
   review when required, then final code review on the settled diff.

Intermediate code-review checkpoints do not run cleanup-review. Cleanup is the
final hygiene gate over the settled implementation. If an approved spec names
an intermediate cleanup checkpoint, return `Blocked` for spec revision instead
of consuming the sole Full cleanup pass early.

Cleanup review runs at most once as a Full review for the whole spec. After its
findings are repaired, either use same-session Closure when budget permits or
give the final code reviewer those stable defect IDs for verification. Never
launch another Full cleanup review over the repaired whole diff.

## Convergence And Stop Rules

Return `Approved` for the final settled revision only when:

- every mandatory lens has independent coverage
- no blocker or execution risk remains open
- every repaired blocker and execution risk is verified
- every accepted execution risk has an explicit durable user decision
- final validation and required cleanup/code-review gates ran
- reviews used do not exceed the profile budget

Return `Blocked` without another review when:

- the budget is exhausted and required coverage or verification remains
- a mandatory final slot was consumed accidentally and cannot be restored
- a defect reopens twice
- the repair needs a product, ownership, scope, or risky trade-off decision
- a required reviewer is unavailable
- a finding receives no substantive repair
- an execution risk remains open without an explicit user decision to accept it
- a fixed blocker or execution risk remains unverified with no covering
  reserved review

The next step after exhaustion is a user decision or a new approved spec, never
an unrecorded extra reviewer. Do not silently downgrade a blocker to fit the
budget.

Return `Waived` only after an explicit user instruction to skip a remaining
implementation review gate. Record skipped coverage and open risks. A waiver is
not approval and must not override an unresolved critical safety defect.

## Required Handoff

The executor reports:

```text
Implementation Review Profile: <simple | medium | high>
Reviews Used: <n>/<budget> (<full> Full, <closure> Closure)
Review Outcome: <Approved | Blocked | Waived>
Mandatory Coverage: <covered lenses or gaps>
Verified Defects: <IDs or None>
Accepted Risks: <IDs, authority, and reason or None>
Open Defects: <IDs or None>
```

## Contract Test Ledger

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| Review budgets `2 / 3 / 6` apply to the entire spec and count every independent result. | Each slice or parallel track silently recreates an unbounded loop. | Manual eval scenario 15 | planned |
| Repair verification uses same-session Closure with stable IDs and no broad rediscovery. | Real findings improve quality but repeatedly restart an expensive full audit. | Manual eval scenario 16 | planned |
| Intermediate code checkpoints run directly; cleanup is one final Full gate. | A final hygiene pass recursively runs before every checkpoint and delays later slices. | Manual eval scenario 17 | planned |

Keep these rows `planned` until the corresponding operator eval is run and its
result is saved.
