# Review Protocol

This Module owns review mechanics shared by artifact and implementation review:
capsules, Full/Closure, reviewer lineage, the canonical Defect Ledger, no-progress,
stop/waiver semantics, and the result envelope. Target Modules own authority,
risk/profile selection, topology, durable orchestration, gate order, and final
outcome mapping. Callers select a target Module and never copy this protocol.

## Interface

```text
apply_review_protocol(
  review_capsule,
  reviewer_lineages
) -> protocol_result
```

`review_capsule` is the normalized Full/Closure capsule defined below. The result
contains `state: clear | repair-required | stopped | waived`, pass
mode/revision/lineage/session/lenses, mandatory coverage, ledger transitions, and any
stop or waiver record. The capsule's canonical Defect Ledger is the only ledger
input. `clear` requires assigned-scope coverage and every non-superseded blocker
or execution risk to be `verified`, except an explicitly `accepted-risk`
execution risk. A superseded record counts as resolved only when `superseded_by`
resolves through an acyclic chain of distinct same-ledger IDs to one
non-superseded canonical replacement; that terminal replacement controls
clearance. A missing, self-referential, or cyclic replacement chain prevents
`clear`. The target Module decides whether `clear` is enough for `Approved`. A
reviewer lineage binds one activation, profile/lenses, Full coverage, and defect
IDs; physical sessions may rotate without creating a new activation or Full.

## Review Capsule

Every fresh reviewer receives a bounded self-contained capsule:

- target kind/path, pinned revision, profile, mode, and assigned lenses
- one review question and why existing valid coverage does not answer it
- goal, authority, approved scope, and relevant source references
- required Evidence Index entries, compact validation, and verification gaps
- canonical Defect Ledger
- for Closure: repair diff, affected contracts, and Revision Map
  `changed target -> defect IDs -> affected invariants/contracts`

Exclude raw parent history, old targets, prior reviewer prose, repeated logs,
unrelated output, and broad inventories. Reviewers may inspect extra evidence
needed for a finding. Reuse unchanged evidence; invalidate only entries affected
by changed targets/contracts or stale external sources. External evidence keeps
its direct source and retrieval date.

Before launch, reuse clear coverage for the same target revision, question, and
lenses. Do not launch a reviewer whose question is already answered; a changed
target or a distinct artifact-versus-implementation question is new coverage.

## Review Modes

**Full:** read the complete pinned target required by assigned lenses and return
all visible evidence-backed blockers/execution risks as one batch.

**Closure:** use only affected reviewer lineages to verify repaired IDs, the
repair diff, and contract fan-out. Do not re-audit unchanged areas. The first
Closure normally reuses the Full session. If it reopens a defect and another
repair follows, run the next Closure in a fresh session of the same lineage.
Before a Closure launch, rotate earlier after compaction/interruption or when
observable context usage reaches 40%. The fresh session receives the bounded
capsule, remains Closure, and preserves Full coverage and defect authority. One
coordinated launch over affected lineages is one Closure wave.

Closure admits a new defect only when it names the repair target/contract that
introduced or materially widened the trigger, or a high-confidence
`blocker`/`execution-risk` violates a source-required invariant in the assigned
lens. Each newly admitted blocker or execution risk starts as `status: open`
and `disposition: repair-now`, then moves `open -> fixed -> verified` only
through repair and independent affected-lens verification. Pre-existing
adjacent issues are improvements. Verification stays with an affected session
or an already planned covering Full reviewer. Start a new Full only when the
repair invalidated mandatory-lens coverage.

## Canonical Defect Ledger

Root assigns stable IDs and deduplicates only when invariant and failure
mechanics both match. Wording changes do not create defects.

```yaml
id: REVIEW-CONC-003
class: blocker | execution-risk | improvement
disposition: repair-now | planned-final-verification | follow-up-improvement | accepted-risk
status: open | fixed | verified | blocked | reopened | accepted-risk | superseded
severity: critical | high | medium | low
confidence: high | medium | low
invariant: "<observable rule>"
failure: "<concrete failure mechanics>"
evidence: ["<target/repo/source reference>"]
repair: "<smallest sufficient change>"
affected_targets: ["<path, section, contract, or lens>"]
introduced_in_review: 2
transition_history: []
reopen_count: 0
acceptance: null | { authority, reason, scope, target_revision }
superseded_by: null | "<canonical replacement defect ID>"
fixed_in_revision: null
verified_in_review: null
```

Reviewers reuse supplied IDs; new candidates use `NEW-<LENS>-NN` until root
deduplicates them. Root may mark a duplicate `superseded` only after recording
its canonical replacement in `superseded_by`. The chain must be acyclic and end
at a distinct non-superseded record; a superseded record never hides the
terminal replacement's lifecycle. Disposition and lifecycle are separate.
`fixed` requires a later affected-lens Closure or planned Full to become
`verified`; tests alone do not independently verify review findings.

Improvements use `follow-up-improvement` and do not block. Only an execution
risk may become `accepted-risk`, after explicit authority, reason, scope, and
target revision are recorded. A blocker cannot be accepted or downgraded.
Target Modules decide where `planned-final-verification` is legal; it remains
open until the scheduled lens verifies it.

## Repair, Stop, And Waiver

Root repairs compatible findings in one batch. Before another Closure, target
revision/strategy, relevant evidence, defect state, or source decision must
change materially. Otherwise root must change the repair, prove the finding
invalid, or surface the decision preventing convergence.

Pass counts and elapsed time are audit signals, never approval, waiver,
downgrade, or blocking conditions. Target Modules may define audit epochs while
preserving this rule.

A bounded poll timeout while the reviewer session remains live is non-terminal:
report that the reviewer has not completed within the polling window, not that
it is stuck, failed, or unavailable. Root may send at most one conclude request
for that reviewer turn. Further empty polls neither authorize another conclude
request nor replacement/cancellation. Replace or cancel only after the reviewer
session or transport explicitly reports `failed`, `lost`, or unavailable; a
late usable result from the original live session remains authoritative. Persist
session `live|timed-out` state and `conclude_requested_at` so resume preserves
the limit.

Return `stopped` without another review when repair needs a product/scope/owner
decision, mandatory evidence or reviewer is unavailable, no substantive repair
exists, or the same defect repeats without progress.

Return `waived` only after explicit user instruction. Record skipped coverage
and open defects. Waiver never means approval, verifies/accepts no defect, and
skips no separate downstream gate. The target Module maps it to `Waived` or
`Blocked` using its authority rules.

## Result Envelope

```text
Review Passes: <total; Full; Closure; fresh sessions when tracked>
Mandatory Coverage: <covered lenses or gaps>
Verified Defects: <IDs or None>
Accepted Risks: <IDs, authority, and reason or None>
Open Defects: <IDs or None>
```

Target Modules add profile, mapped outcome, authority, Adapter verdict,
checkpoint, status, or performance fields without redefining common fields.

## Contract Test Ledger

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| Full/Closure stay causal and affected-lens-only within reviewer lineage | Broad review restarts, stale context, or lost defect authority | Evals 11, 16 | green |
| Every launch answers an uncovered question on its pinned target | Duplicate reviewers repeat valid coverage without new evidence | Eval 23 | green |
| Both consumers use one defect schema and lifecycle | Artifact and implementation defects drift | Eval 12 | green |
| No-progress requires material change | Unchanged Closure repeats or numeric limits become terminal | Eval 12 | green |
| A live reviewer poll timeout stays non-terminal and permits at most one conclude request | Root falsely reports a hang, cancels useful work, or launches a duplicate reviewer | Eval 12 | green |
| Waiver skips coverage without accepting defects | Skipped review is reported as approval or risk acceptance | Eval 12 | green |
