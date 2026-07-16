# Artifact Review Loop

Use this policy whenever `plans-maker` or `implementation-spec-maker` reviews an
artifact. It is the single Module that owns review-risk classification,
reviewer topology, review budgets, context transfer, defect convergence, and
terminal states.

The Module sits at the Seam between artifact-authoring skills and the existing
`plan-review` and `implementation-spec-review` Adapters. Callers provide an
artifact and its source authority; they do not implement their own review loop.

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
- `reviews_used`, `full_reviews`, `closure_reviews`, and `fresh_sessions`
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
do not consume the review budget.

A useful preflight-blocked artifact may be saved with zero reviews. Record the
Module outcome as `Blocked`, `Reviews Used: 0/<budget>`, and the exact blocking
unknown; do not invent an Adapter verdict for a reviewer that never ran.

Classify risk by the consequence and uncertainty of being wrong, not by file
count or estimated implementation effort.

### Hard Escalators

Any one of these makes the profile `high`:

- persistence, transaction, migration, or schema changes
- concurrency, ordering, queues, shared state, retry, or idempotency
- auth, permissions, secrets, payments, or destructive operations
- background processing with partial-failure or recovery ownership
- an unknown, unstable, or safety-critical external contract
- multiple owners of one source of truth
- multi-node execution that coordinates a shared contract or integration order
- a production rollout where failure can corrupt data, leak access, duplicate a
  side effect, or present a false durable state

### Standard Signals

When no hard escalator exists, count these evidence-backed signals:

- user-visible runtime behavior changes
- more than one Module or runtime surface changes
- a shared Interface, endpoint, DTO, event, or serialization contract changes
- non-trivial error handling, fallback, timeout, or recovery is required
- a known external package or API contract participates in the behavior

Use this deterministic mapping:

| Profile | Classification | Review budget |
| --- | --- | ---: |
| `simple` | No hard escalator and 0-1 standard signals | 3 |
| `medium` | No hard escalator and 2-3 standard signals | 4 |
| `high` | Any hard escalator or 4+ standard signals | 6 |

File count is never sufficient by itself to make a task safe. A one-line auth
change can be `high`; a broad mechanical rename can remain `simple` or
`medium`.

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

If review discovers a higher-risk signal, escalate immediately. Reviews already
used count against the new budget; escalation never resets the counter. A user
decision within approved scope also does not reset it. A genuinely new product
scope starts a new artifact revision only when the root explicitly says so and
reports the previous outcome.

When escalation to `high` occurs after reviews have started, do not pretend the
initial full reviews were parallel. Preserve completed coverage, assign it to
the matching high-risk lens set, and run each missing full lens review. Run
repair closures only when budget remains. If the remaining budget cannot cover
the missing mandatory lenses, return `Blocked`; never reset or exceed six.

## Review Capsule

Every fresh reviewer starts without inherited conversation history. Give it a
self-contained Review Capsule containing only:

- artifact path and current saved content
- short goal, approved scope, out of scope, and Decision Snapshot
- source-authority paths or URLs
- risk profile, assigned lenses, and required output mode
- an Evidence Index of `claim -> file:symbol`, section, or trusted URL
- the current compact Defect Ledger
- for closure, the revision diff, affected contracts, and a Revision Map of
  `changed section -> defect IDs -> affected invariants/contracts`

Do not send raw parent-chat history, old artifact versions, full prior reviewer
prose, unrelated tool output, or a broad repository inventory. A reviewer may
open any additional source required to substantiate a new high-confidence
finding. Reduce repeated discovery, not evidence quality.

External evidence includes its direct source and retrieval date. Unchanged
evidence remains reusable. Changed files, changed contracts, or stale external
sources invalidate only the affected Evidence Index entries.

## Review Modes

### Full

Read the complete current artifact and cover every assigned mandatory lens.
Inspect repository or external evidence progressively from the Review Capsule.
Return all visible evidence-backed blockers and execution risks in the assigned
lenses as one batch; do not intentionally drip findings across passes.

### Closure

Use the same reviewer session through a follow-up. Read the new artifact
revision, Revision Map, changed sections, affected contracts, and ledger rows.
Verify each assigned defect and the regression fan-out of its repair. Do not
repeat broad repository discovery for unchanged claims.

Closure may report a genuinely new defect when the repair introduced it, made
it observable, or affected a connected invariant. It must not suppress the
finding merely because the pass is focused.

### Closure Re-entry

When closure finds a new or reopened defect, root repairs it as part of the next
batch. Reserve every mandatory fresh full review required by the profile first.
If budget remains after that reservation, use the next slot as another
same-session closure; otherwise the next mandatory full reviewer must verify the
repair. If neither a closure slot nor a mandatory full review remains, return
`Blocked`. Unused conditional slots are not lost, but the total profile budget
never resets or expands.

## Risk-Aware Topology

All budgets are maxima, not quotas. Skipped conditional closure slots do not
consume the budget. `simple` and `medium` use one reviewer session and may stop
after the first valid approval. `high` uses two independent reviewer sessions
with disjoint primary lenses; both full reviews are required for approval.

### Simple: Maximum 3 Reviews

1. Reviewer A performs a full review.
2. If defects were repaired, Reviewer A performs closure.
3. If review 2 found a new or reopened defect, repair it and use review 3 as
   final closure with A. Otherwise stop after review 2.

Maximum fresh sessions: 1. Maximum full reviews: 1.

### Medium: Maximum 4 Reviews

1. Reviewer A performs a full review.
2. Reviewer A performs closure after the batch repair when review 1 found
   defects.
3. If closure finds a new or reopened defect, repair it and continue with
   Reviewer A in the same session while budget remains.
4. Use the fourth slot only as a final same-session closure when review 3 found
   another new or reopened defect. Otherwise stop as soon as A approves.

Maximum fresh sessions: 1. Maximum full reviews: 1.

### High: Maximum 6 Reviews

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
3. Reviewer A performs focused closure after one consolidated batch repair when
   A owns repaired defects or that repair changed a contract in A's lenses.
4. Reviewer B performs focused closure in parallel with review 3 under the same
   condition for B's defects or lenses. Skip an unaffected closure slot without
   consuming budget.
5. If either closure finds a new or reopened defect, repair it in one
   consolidated batch and use the remaining slots as same-session closures for
   the affected reviewer or reviewers.
6. Stop as soon as both assigned lens sets approve the same settled revision;
   if unresolved defects remain when the sixth slot is exhausted, return
   `Blocked`.

Maximum fresh sessions: 2. Maximum full reviews: 2. The critical path has at
most three review waves: `1+2`, `3+4`, and conditional same-session closures in
`5+6`.

Root owns launches, aggregation, repairs, and final decisions. Parallel launch
must preserve and close every fulfilled handle even after partial failure.

## Defect Ledger

Every blocker and execution risk receives a stable ID. The root deduplicates
new candidates by protected invariant and failure mechanics; wording changes do
not create a new defect.

```yaml
id: SPEC-CONC-003
class: blocker | execution-risk | improvement
confidence: high | medium | low
invariant: "<observable rule>"
failure: "<concrete failure mechanics>"
evidence:
  - "<artifact/repo/source reference>"
repair: "<smallest sufficient artifact change>"
affected_sections:
  - "<section or contract>"
introduced_in_review: 2
status: open | fixed | verified | blocked | accepted-risk | superseded
fixed_in_revision: null
verified_in_review: null
```

Reviewers reuse IDs supplied in the capsule. New findings use a temporary
`NEW-<LENS>-NN` label; root assigns the canonical stable ID after deduplication.
`fixed` is not terminal until a later Full or Closure reviewer with coverage of
the affected lenses records `verified`.

An `improvement` never blocks approval. An `execution-risk` may become
`accepted-risk` only through an explicit user decision recorded in the artifact.
A `blocker` cannot be accepted or silently downgraded.

## Convergence And Stop Rules

Return `Approved` only when all of these hold:

- the verdict applies to the current saved artifact content
- every mandatory lens required by the selected Adapter has coverage
- no blocker or unaccepted execution risk remains open
- every repaired blocker and execution risk is verified
- source authority and approved scope still match the artifact

Persist mandatory-lens coverage with the outcome. Any substantive edit after
approval invalidates `Approved` until the saved artifact passes the applicable
Module path again. Updating only lifecycle and review-result metadata does not
invalidate approval.

Return `Blocked` without another review when any of these hold:

- the profile budget is exhausted without approval
- a defect reopens twice, indicating a source-of-truth or repair-design conflict
- the next repair needs a product, scope, ownership, or risky trade-off decision
- mandatory external evidence is unavailable
- the artifact did not change after `Needs Work` or `Rejected`
- a required named reviewer is unavailable
- a repair remains unverified and neither a closure slot nor a mandatory fresh
  full review remains

Return `Waived` only after an explicit user instruction to skip remaining
artifact review. Record reviews used, open defects, and `Adapter Verdict: Not
run` or the last real Adapter verdict.
Never represent a waiver as approval. `Waived` may be ready only when preflight
is complete and no known blocker or unaccepted execution risk is open, blocked,
or fixed-but-unverified. If the user stops review while any such defect remains,
record the waiver in closure notes but return `Blocked`.

Map terminal outcomes to artifact status without guesswork:

- `Approved`: plan may be `ready-for-approval` or user-approved; spec may be
  `ready`.
- `Blocked`: plan/spec status is `blocked`.
- `Waived`: plan/spec may be ready only under the explicit waiver when preflight
  is complete and no known blocker or unaccepted execution risk is open,
  blocked, or fixed-but-unverified; the waiver remains visible in metadata and
  the final response.

`Needs Work` and `Rejected` are Adapter verdicts, never durable Module outcomes.

Skipping further artifact review never implicitly skips implementation
checkpoints, cleanup review, final code review, tests, or runtime validation.
Those are separate contracts and require their own explicit waiver when policy
allows one.

## Required Outcome Summary

The author reports:

```text
Review Profile: <simple | medium | high>
Reviews Used: <n>/<budget> (<full> full, <closure> closure, <fresh> fresh sessions)
Review Outcome: <Approved | Blocked | Waived>
Adapter Verdict: <Approved | Needs Work | Rejected | Not run>
Review Coverage: <mandatory lenses covered | Not reviewed>
Open Defects: <stable IDs or None>
```

For performance evaluation, also retain per-review mode, start/end timestamps,
and tool-call count when the runtime exposes them. Compare wall-clock time and
token/tool usage separately.

## Contract Test Ledger

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| Risk classification maps simple/medium/high to budgets 3/4/6 and hard escalators always select high. | Cheap work is over-reviewed or dangerous work is under-reviewed. | Manual eval scenario 10 | green |
| Full and closure modes preserve new-defect discovery while avoiding repeated broad evidence collection. | Faster review silently misses regressions introduced by repairs. | Manual eval scenario 11 | green |
| High-risk work uses two parallel full reviews and conditional same-session closures within six reviews. | Review remains serial, adds a third reviewer, or loses mandatory-lens coverage. | Manual eval scenario 10 | green |
| Exhausting the budget fails closed with stable unresolved defect IDs. | A seventh hidden pass or false approval recreates the unbounded loop. | Manual eval scenario 12 | green |
| Substantive edits invalidate approval while lifecycle-only edits do not. | A changed plan/spec is executed under stale approval. | Review-state inspection | green |
