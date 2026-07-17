# Review Protocol

This Module owns review mechanics shared by artifact and implementation review:
capsules, Full/Closure, session reuse, the canonical Defect Ledger, no-progress,
stop/waiver semantics, and the result envelope. Target Modules own authority,
risk/profile selection, topology, durable orchestration, gate order, and final
outcome mapping. Callers select a target Module and never copy this protocol.

## Interface

```text
apply_review_protocol(
  review_capsule,
  reviewer_sessions
) -> protocol_result
```

`review_capsule` is the normalized Full/Closure capsule defined below. The result
contains `state: clear | repair-required | stopped | waived`, pass
mode/revision/session/lenses, mandatory coverage, ledger transitions, and any
stop or waiver record. The capsule's canonical Defect Ledger is the only ledger
input. `clear` requires assigned-scope coverage and every non-superseded blocker
or execution risk to be `verified`, except an explicitly `accepted-risk`
execution risk. A superseded record counts as resolved only when `superseded_by`
resolves through an acyclic chain of distinct same-ledger IDs to one
non-superseded canonical replacement; that terminal replacement controls
clearance. A missing, self-referential, or cyclic replacement chain prevents
`clear`. The target Module decides whether `clear` is enough for `Approved`.

## Review Capsule

Every fresh reviewer receives a bounded self-contained capsule:

- target kind/path, pinned revision, profile, mode, and assigned lenses
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

## Review Modes

**Full:** read the complete pinned target required by assigned lenses and return
all visible evidence-backed blockers/execution risks as one batch.

**Closure:** reuse only affected reviewer sessions to verify repaired IDs, the
repair diff, and contract fan-out. Do not re-audit unchanged areas. A coordinated
launch over affected existing sessions is one Closure wave.

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
| Full/Closure stay causal, affected-lens-only, and same-session | Broad review restarts or repair-caused defects are hidden | Evals 11, 16 | green |
| Both consumers use one defect schema and lifecycle | Artifact and implementation defects drift | Eval 12 | green |
| No-progress requires material change | Unchanged Closure repeats or numeric limits become terminal | Eval 12 | green |
| Waiver skips coverage without accepting defects | Skipped review is reported as approval or risk acceptance | Eval 12 | green |
