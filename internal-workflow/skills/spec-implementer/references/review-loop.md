# Approved Spec Implementation Review Loop

This reference owns review orchestration for `$spec-implementer`. Read it only
when executing an approved implementation spec. Shared Full/Closure and defect
mechanics live in `../../../docs/agents/review-protocol.md`.

Direct work and deterministic issue delivery use normal TDD and review gates;
they must not create Implementation Review State.

## Authority

Only an approved implementation spec may own `## Implementation Review State`.
PRDs, tickets, architecture notes, and chat summaries are not review-state
owners. A substantive spec change returns through artifact review before
implementation continues.

Use the spec's `review_profile`; if absent, infer it from current evidence:

- `simple`: narrow change with direct proof;
- `medium`: default for ordinary implementation;
- `high`: material failure consequence plus an uncertainty amplifier.

Implementation evidence may raise but never lower the approved profile.

## Default Review Shape

Implement continuously through vertical slices. Validate each affected behavior
and run one final review on the settled diff when the gate applies.

- `simple`: one `reviewer_fast` when review is required.
- `medium`: one `reviewer_standard`, one bounded final Full, no intermediate
  checkpoint by default.
- `high`: two parallel `reviewer_deep` Full reviews with disjoint correctness
  and spec/standards lenses.

Add an intermediate checkpoint only when the approved spec explicitly names a
stable high-risk slice whose review will remain valid after later work. Do not
review unstable intermediate diffs or create per-slice review cycles.

Cleanup stays inside the spec/standards lens. A concrete simplification risk may
amplify that lens; size and profile labels alone do not create another gate.

## Minimal Durable State

Do not create review state during preflight or implementation. Immediately
before the first actual reviewer launch, persist:

- profile, authority path, settled target revision, and assigned lenses;
- launch ID, reviewer/session handle, lineage, and `pending | completed | failed`;
- returned findings, repair revision, affected validation, and Closure need.

Write `pending` before launch and reconcile that session before replacing it
after interruption or resume. A usable result becomes `completed`; an explicit
failure becomes `failed`. A poll timeout while the session remains live is not
a failure and does not authorize duplicate review.

Record extended lineage/session history only for `high`, a real intermediate
checkpoint, actual Closure, accepted risk, or interrupted recovery. Normal
medium execution does not keep epochs, pass thresholds, activation counters, or
per-slice handoff bookkeeping.

## Findings And Closure

Root aggregates findings, repairs compatible defects once, and reruns only
affected validation. Coordinator verification closes ordinary medium/low
behavior-preserving findings after confirming the repair matches the failure.

Use shared-protocol Closure only for critical/high defects, protected
trust/data/concurrency/shared API impact, or invalidated mandatory coverage.
Closure stays with the affected reviewer lineage and repaired targets. Start a
new Full only when the repair invalidated mandatory-lens coverage.

Do not repeat review without a material change in target, evidence, repair, or
source decision. Stop and surface the actual decision or evidence blocker when
no progress is possible.

## Completion

Run gates in this order:

1. affected behavior and integration validation;
2. applicable final code review;
3. Closure only when triggered;
4. repository architecture/build/smoke gates required by policy or the spec;
5. delivery actions explicitly authorized by the user or workflow.

Return `Approved` only for the final settled revision when mandatory lenses and
validation are complete and shared protocol state is clear. `Waived` records
skipped coverage but is not approval. `Blocked` requires a concrete authority,
evidence, reviewer, or convergence blocker—not elapsed time or review count.

For normal medium work report only profile, review result, repaired/open
findings, affected validation, skipped checks, and residual risk. Add extended
session/defect accounting only when the exceptional state above exists.
