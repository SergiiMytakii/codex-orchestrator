---
name: "cleanup-review"
description: "Run one exceptional independent post-implementation simplification review when the user, approved source, or repo policy names a concrete cleanup risk that cannot fit final code review. Detect removable duplication, obsolete paths, speculative compatibility, workaround branches, and unjustified production abstractions without re-reviewing correctness or test coverage."
---

# Cleanup Review

Use this skill after implementation has settled and before final `$code-review`.
It is a cleanup-only Adapter: its job is to reduce maintenance surface without
changing required observable behavior.

Do not invoke it separately from implementation size or risk classification.
The final `$code-review` spec/standards lens owns bounded hygiene for every
profile, with a dedicated parallel reviewer track for `high`. Use this Adapter
only when the user, approved source, or repo policy names a concrete evidenced
cleanup risk that cannot be covered proportionately by that lens.

When an Implementation Review Module schedules this Adapter, follow
`../../docs/agents/implementation-review-loop.md` for topology, state, defect
lifecycle, and Closure. Otherwise follow
`../../docs/agents/review-gates.md`. This skill does not create its own loop.

## Invocation Contract

- Use one profile-selected independent reviewer. Root never reviews or certifies cleanup inline.
- One logical activation spans the Full pass and every same-session Closure; each Closure is a review pass, not a new skill activation.
- Run one Full cleanup review only after the complete implementation diff and required validation have settled. Never run it per slice or re-enter cleanup after final code review starts.
- The implementation owner integrates accepted fixes. The reviewer remains read-only and returns evidence and bounded changes.
- If independent review is unavailable, report the gate as unavailable; do not substitute root self-review.

## In Scope

- duplicated logic, sources of truth, registrations, or old/new paths kept in parallel
- dead helpers, flags, adapters, branches, comments, tests, or documentation left by the change
- workaround-shaped conditionals, magic ordering, symptom patches, and unnecessary state
- compatibility or fallback behavior without current repository, source-authority, or production evidence
- new services, events/listeners, adapters, or indirection with one current consumer and only speculative reuse
- ownership placement only when moving or deleting code restores an existing owner without redesigning the system
- stale or duplicated tests/docs only when their cleanup debt is itself the finding

## Out Of Scope

- functional correctness, acceptance completeness, security, privacy, performance, or product decisions
- missing regression coverage or weak behavior proof by itself; route it to the scheduled code-review/test-quality lens
- broad architecture redesign, future extensibility, or a request for a new abstraction unrelated to removing current duplication
- discovery of new sibling edge cases in unchanged behavior
- style, naming, or formatting preferences without concrete maintenance cost

## Review Method

1. Pin the target revision/diff and source authority supplied by the Review Plan or root.
2. Inventory material additions, replacements, compatibility paths, and new runtime owners.
3. Classify each material complexity decision:
   - `KEEP`: required by a current invariant and supported by evidence or a boundary proof.
   - `SIMPLIFY`: required behavior can use a smaller existing seam or fewer states/branches.
   - `REMOVE`: no current behavior, authority, consumer, or compatibility evidence requires it.
4. Report a finding only when it names exact evidence, concrete maintenance cost, and a behavior-preserving simplification. Uncertain removal becomes follow-up, not a guessed blocker.

A one-producer/one-consumer abstraction defaults to `SIMPLIFY` unless a concrete
lifecycle, transaction, dependency-direction, or fanout invariant requires the
boundary. Do not request a new abstraction unless it reduces current duplication
or restores an existing owner now.

For Module-scheduled Closure, inspect only accepted cleanup repairs and their
causal fan-out. Do not restart broad discovery or convert proof-only gaps into
cleanup defects.

In Module mode, reuse supplied stable cleanup IDs and return each as `verified`
or `reopened`. Hand settled decisions/IDs to final code review; that reviewer
rechecks hygiene only for a concrete regression caused by its own repair.

## Output

Return exactly:

1. `Verdict: Clean | Cleanup Needed | Cleanup Blocked`
2. `Final Coverage: cleanup-only`
3. `Decisions`: concise `KEEP | SIMPLIFY | REMOVE` records for material complexity, each with evidence and protected invariant or maintenance cost
4. `Findings`: actionable cleanup defects with supplied ID/lifecycle update, exact path/line evidence, and a behavior-preserving fix; otherwise `None`
5. `Follow-up Needed`: only risky removals or missing authority/evidence; otherwise `None`

`Cleanup Blocked` means the cleanup decision requires unavailable evidence or an
explicit product/ownership choice. It never means that correctness or test-quality
review should be performed inside this skill. Keep the result short and auditable.
