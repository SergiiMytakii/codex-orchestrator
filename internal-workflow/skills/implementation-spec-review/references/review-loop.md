# Implementation Spec Review Loop

This reference owns review orchestration for specs created by
`implementation-spec-maker`. Read it when the maker requests artifact review.
The reviewer skill remains the Adapter; the shared review mechanics live in
`../../../docs/agents/review-protocol.md`.

## Contract

Input:

- saved spec and pinned revision;
- source authority and approved decisions;
- evidence needed to verify execution claims;
- optional user-raised review profile.

Output:

- `outcome: Approved | Blocked | Waived`;
- `adapter_verdict: Approved | Needs Work | Rejected | Not run`;
- `review_profile: simple | medium | high` and evidence-backed reasons;
- mandatory-lens coverage and unresolved defects.

The Adapter returns only its verdict. The root maps preflight, convergence, and
waiver state to the artifact outcome.

## Preflight And Profile

Before launching a reviewer, confirm source authority, approved scope, current
spec revision, and mandatory external evidence. Save a useful blocked spec when
a product or contract decision is missing; do not launch review to discover a
known authority gap.

`medium` is the default. Use:

- `simple` for one narrow owner with direct proof and no material uncertainty;
- `medium` for all ordinary specs, including multi-file, API, persistence, or
  stateful work with clear ownership and bounded proof;
- `high` only when a sensitive mechanism has both a material failure
  consequence and an uncertainty amplifier such as unclear ownership,
  cross-trust effects, non-local recovery, or an unproven external contract.

File count and implementation size never select `high`. The user may raise but
not lower an evidence-backed profile.

## Scope And Capsule

Review the smallest approved solution. Risk may strengthen proof but does not
authorize flags, telemetry, compatibility paths, generic fallbacks, or rollout
machinery unless the source or a concrete failure requires them.

Give each reviewer a bounded capsule containing the current spec, authority,
approved scope, evidence, review question, assigned lenses, and current defect
records. For Closure also include the repaired sections and affected contracts.
Do not pass raw parent history or unrelated inventories.

## Topology

- `simple`: one `reviewer_fast`, one bounded Full.
- `medium`: one `reviewer_standard`, one bounded Full.
- `high`: two parallel `reviewer_deep` sessions with disjoint primary lenses:
  Architecture/Execution and Failure/Contracts.

Root launches and aggregates reviewers. A reviewer child runs the
`implementation-spec-review` Adapter inline and never spawns another reviewer.
Reuse valid coverage for the same revision and question.

After one consolidated repair, coordinator verification is enough for ordinary
medium/low findings. Use shared-protocol Closure only for critical/high defects,
protected trust/data/concurrency/shared-contract impact, or invalidated
mandatory coverage. A substantive rewrite gets a new Full only when it
invalidates existing mandatory lenses.

## Approval

Return `Approved` only when the current saved revision matches source authority,
mandatory lenses are covered, and every blocking defect is verified. Any
substantive edit invalidates approval; lifecycle metadata alone does not.

Return `Blocked` when authority/evidence is missing, repair needs a product or
ownership decision, no substantive repair exists, or shared no-progress rules
apply. Return `Waived` only after explicit user instruction and keep skipped
coverage visible; an open blocker still maps the artifact to `Blocked`.

Map outcomes to spec status:

- `Approved` -> `ready`;
- `Blocked` -> `blocked`;
- eligible `Waived` -> `ready` with visible waiver metadata.

Report profile, outcome, Adapter verdict, mandatory coverage, verified/open
defects, and skipped checks. Do not report counters or session history for a
normal one-review flow.
