# Implementation Review Loop

Use this policy for every approved implementation-spec execution. This
target-specific Module owns implementation authority, durable Review State,
checkpoint/final topology, validation reuse, gate ordering, audit epochs, and
implementation outcome mapping. It applies
[`review-protocol.md`](review-protocol.md) for context transfer, Full/Closure
mechanics, defect lifecycle, no-progress, and the common result envelope.
`spec-implementer`, `cleanup-review`, and `code-review` are callers or Adapters;
they must not reproduce either Module. Deterministic tickets-orchestrator work
using its issue as authority remains outside this Module and uses direct TDD
plus repo review gates.

This policy does not replace tests, architecture checks, smoke tests, or Git
checkpoints. Those proofs remain independent evidence.

## Interface

Conceptually, the executor uses:

```text
review_implementation(
  authority_artifact_kind,
  authority_artifact_path,
  review_profile,
  current_revision,
  checkpoint,
  review_focus,
  defect_ledger
) -> review_outcome
```

The outcome records:

- `outcome`: `Approved | Blocked | Waived`
- `authority_artifact_kind`: `approved-spec`
- `authority_artifact_path`: the sole artifact that stores review state
- `review_profile`: `simple | medium | high`
- completed review passes and pending launches
- review mode, reviewer/session identity, target revision, and assigned lenses
- stable defect IDs and their current status
- logical skill activations and their open/closed state
- mandatory final coverage still required

## Authority

An approved implementation spec stores the sole `## Implementation Review
State`. Architecture RFCs, product PRDs, tickets, `ready-for-approval`
artifacts, inferred approval, and ordinary direct-ticket waves are ineligible.
Persist `authority_artifact_kind` and `authority_artifact_path` and never create
a second ledger in an upstream artifact, caller, ticket, or Adapter.

Lifecycle and proof updates to the selected artifact do not change its approved
status or substantive design. A substantive authority change requires the
normal artifact revision/review path before implementation continues.

## Profile And Review Shape

Prefer the selected authority artifact's `review_profile`. If it is absent, use the same
evidence-based classification and hard escalators as
[`artifact-review-loop.md`](artifact-review-loop.md). Actual implementation
evidence may raise the profile but must not lower it.

Review profile selects mandatory lenses and independence. Protocol pass-count
semantics apply; parallel reviewer results remain separate passes even when they
reduce wall-clock time.

Select the reviewer role from the profile: `simple` uses `reviewer_fast`,
`medium` uses `reviewer_standard`, and `high` uses `reviewer_deep`. Root always
launches reviewer children; it never performs an implementation review inline.
An Adapter runs inline only inside its already assigned reviewer child.

A reviewer that fails before returning a usable result is recorded as failed
and closed, not as completed coverage. Escalation preserves completed coverage
and the stable Defect Ledger. A user pause, context compaction, slice commit,
worker replacement, or new turn also preserves them; none restarts the review
topology automatically.

Stop early when mandatory coverage and protocol clear-state requirements hold.

## Review Planning

Before the first implementation reviewer, root creates a short Review Plan:

- current profile and required independent lenses
- only stable intermediate checkpoints and their required lenses; move an unstable checkpoint to final coverage when later slices touch the same files, owners, or contracts
- any separate cleanup requirement, which must name a concrete evidenced reason that cannot fit the final spec/standards lens
- final code-review lenses and minimum independent coverage
- reviewer lineages that own affected-lens Closure

Create one durable activation record for each logical skill invocation. Record
`activation_id`, skill, owner, opened/closed state, and resume rule. Review Full
and lineage-preserving Closure passes stay inside that review skill's activation;
TDD repair cycles stay inside the active TDD activation. Cleanup, code review,
TDD, and debugger activations never share an ID, and a continuation resumes an
ID only for the same skill and authorized flow.

## Durable Review State

Do not create durable review state during implementation preflight. Immediately
before the first actual reviewer launch, persist the short Review Plan and
pending launch in the selected authority artifact under
`## Implementation Review State`. From that point onward this is the execution
ledger for review state; do not keep the authoritative history only in chat
context or a subagent summary.

Record at least:

- profile, completed pass count, and required coverage still outstanding
- current checkpoint/gate, review timing baseline, gate-local consecutive
  Closure-wave count, and latest Closure wave ID
- planned mandatory final reviews and their lenses
- authority artifact kind/path and logical skill activation records
- each lineage ID, origin Full session, active session generation, Closure count,
  rotation reason, live/timeout state, and `conclude_requested_at`
- any convergence audit epoch: trigger, triggering pass/wave/revision,
  completion, dispositions, selected sessions, resume reason, and pass/wave/time
  baselines used for its next rearm
- pending reviewer launches with launch ID, mode, lineage/session identity,
  activation ID, target revision, checkpoint/gate, Closure wave ID when
  applicable, assigned lenses, and start timestamp
- every completed review's mode, lineage/session identity, target revision,
  checkpoint/gate, Closure wave ID, assigned lenses, start/end timestamps, and
  outcome
- the stable Defect Ledger with transition history, reopen count, fixed revision,
  verifying review, and any explicit risk acceptance

Write a pending launch before starting its reviewer. After the launch returns,
replace the pending record with either its usable completed result or a failed,
closed session record; only a usable result increments `review_passes`. A context
compaction, new turn, resumed task, or different root agent must reconcile every
pending launch with its recorded session before starting a replacement.

Update this section after each launch, usable reviewer result, repair batch,
closure, waiver, acceptance, reopen, or terminal outcome. A resumed executor
reconstructs accounting and lifecycle history from this persisted state. If the
state is missing or internally inconsistent after reviews began, return
`Blocked` until it is reconciled from available thread/session evidence; never
assume zero completed passes or silently replace an in-flight reviewer.

Plan mandatory final coverage before launching an intermediate review. Launch a
checkpoint only when its target is settled and later slices will not invalidate
the reviewed files, owners, or contracts. Otherwise move its lenses to final
coverage. Do not replace a required final lens with another fresh checkpoint
reviewer or a repeat broad audit.

The default shapes are:

- `simple`: validation only when policy does not require review; otherwise one
  final Full review and affected-lens Closure only after repairs.
- `medium`: an explicit intermediate checkpoint may provide one required lens;
  the final integrator covers every remaining lens, includes bounded cleanup in
  spec/standards, and verifies its defects without a separate cleanup pass.
- `high`: use parallel independent tracks only for disjoint mandatory lenses;
  the spec/standards track includes bounded cleanup, and affected-lens Closure
  follows only after consolidated repairs. There is no separate cleanup pass by
  default.

`code-review` uses one final reviewer covering both correctness and
spec/standards for `simple` and `medium`. For `high`, it uses two disjoint final
tracks unless earlier independent coverage already covered both axes and one
fresh final integrator receives their compact handoffs.

Before launching a fresh final reviewer, reconcile coverage on the settled
revision. If the latest usable Full or Closure covered every mandatory final
lens and left no open defect, mark final review complete and stop. Count cleanup
Closure only for the lenses explicitly assigned in the Review Plan; a
`cleanup-only` pass does not satisfy correctness or spec/standards coverage.

## Review Capsule

Use the protocol capsule with these implementation fields:

- the unanswered implementation question and any prior coverage it invalidates
- authority artifact kind/path, profile, current revision, checkpoint, and exact diff command
- changed paths and assigned `Review Focus` lenses
- source-of-truth docs and relevant Contract Test Ledger rows
- compact validation results and known verification gaps

For Closure, map changed paths and tests into the protocol Revision Map.

## Review Modes

Use protocol Full and Closure without redefining them. Implementation Closure
maps `affected_targets` to paths, tests, runtime contracts, and Review Focus
lenses. An already planned Full reviewer may verify a repair when its assigned
lenses cover it.

## Defect Lifecycle

Use the canonical protocol ledger and lifecycle without local aliases.

Implementation proof-only gaps may use `planned-final-verification` only when an
already scheduled code-review lens owns the proof; they remain open until
independently verified and never re-enter cleanup. Artifact proof-contract gaps
reopen artifact review. A pre-existing adjacent issue is non-blocking only as an
`improvement` with `follow-up-improvement`.

## Validation Evidence Reuse

Persist command/config identity, failure signature, target revision and changed
path/contract impact basis, secret-safe environment fingerprint, transitive
ownership/contract impact, and result. Reuse a known unrelated suite failure
only when every field matches; unknown environment or transitive impact fails
closed. Focused tests and every required check for a repair always rerun.

## Gate Ordering

1. Implement the slice and pass its tests/exit gate.
2. At an explicit intermediate checkpoint, run the required targeted
   `code-review` directly under the Review Plan.
3. Repair one consolidated finding batch and use protocol Closure for the
   affected lineages. An already planned Full reviewer may verify the repair when
   its assigned lenses cover it.
   At one gate, collect the usable results from all already-launched reviewers
   before repairing, unless an immediate blocker invalidates the remaining
   work. Do not turn individual findings into serial repair, validation, and
   Closure micro-cycles. Repair compatible findings once, rerun each affected
   validation once on the resulting revision, then launch one affected-lens
   Closure wave.
4. Continue implementation only when checkpoint blockers are verified or the
   Review Plan explicitly assigns their verification to an already planned reviewer
   without violating the checkpoint's safety purpose.
5. After all implementation slices and validations settle, run one final code
   review wave. `simple` and `medium` use one reviewer; `high` launches two
   disjoint reviewer tracks in parallel. The spec/standards lens owns bounded
   cleanup.

Intermediate code-review checkpoints do not run cleanup-review. A separate
cleanup pass is exceptional: run it only when the user, approved source, or repo
policy names a concrete evidenced simplification risk that cannot fit the final
spec/standards lens. `large` or `high` alone is not a reason. If an approved spec
names an intermediate cleanup checkpoint, return `Blocked` for spec revision.

Cleanup review runs at most once as a Full review for the whole spec. After its
findings are repaired, either use protocol Closure or give the final code
reviewer those stable defect IDs for verification. Never launch another Full
cleanup review over the repaired whole diff.

## Convergence And Stop Rules

Apply protocol repair, no-progress, stop, and waiver semantics. The following
audit is implementation-specific.

Before launching more reviewers, run one non-terminal convergence audit after
two consecutive Closure waves in one gate, ten total implementation review
passes, or 90 minutes when timing is available. One coordinated launch over all
affected lineages is one wave regardless of parallel pass count.

Persist one audit epoch with trigger, triggering pass/wave/revision,
completion, dispositions, selected sessions, and resume reason. It survives
resume. After a material repair/evidence change proves progress, rearm by
recording the current total pass count, current gate-local Closure-wave count,
and current timestamp as new baselines. The next audit opens only after a
post-rearm delta reaches two Closure waves in that gate, ten implementation
review passes, or 90 minutes; already-consumed counts or time cannot reopen it
immediately. Without progress do not rearm and use the existing stop rules.
Thresholds never approve, waive, downgrade, or block by themselves, and
distinct failure mechanics remain distinct even when they protect one
invariant.

Return `Approved` for the final settled revision only when protocol state is
`clear` and:

- every mandatory lens has independent coverage
- final validation and required cleanup/code-review gates ran

Map protocol `stopped` to `Blocked`. Implementation-specific blockers also
include:

- a defect reopens repeatedly and exposes a source-of-truth or repair-design
  contradiction that root cannot resolve from current evidence
- an execution risk remains open without an explicit user decision to accept it

Do not mark implementation `Blocked` merely because review has run several
times. Resolve the repair, evidence, or decision problem first.

Map protocol `waived` to `Waived` and preserve skipped coverage and open risks.
It remains non-approval; target authority or downstream policy may still block
delivery.

## Required Handoff

Use the protocol result envelope and add:

```text
Implementation Review Profile: <simple | medium | high>
Review Outcome: <Approved | Blocked | Waived>
Authority Artifact: <approved spec path>
Implementation Checkpoint: <checkpoint or final>
```

## Contract Test Ledger

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| Review pass counts are audit metrics, while one durable Review Plan and Defect Ledger span the entire spec. | Each slice silently recreates a new loop or a repairable spec blocks on an arbitrary count. | Manual eval scenario 15 | planned |
| Intermediate checkpoints never trigger cleanup; final review is one settled profile-selected wave, and separate cleanup is exceptional. | Per-slice hygiene or size-driven cleanup adds latency and restarts review over unstable work. | Manual eval scenario 17 | planned |
| Audit epochs persist across resume and rearm only after material progress. | Thresholds repeatedly trigger audits or become terminal limits. | Manual eval scenario 12 | planned |

Keep these rows `planned` until the corresponding operator eval is run and its
result is saved.
