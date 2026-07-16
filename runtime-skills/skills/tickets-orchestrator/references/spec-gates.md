### 2.1. Run required spec gates

Before Runner-route implementation workers, inspect every issue in the active wave.

Run a spec gate when any active issue says `Spec required: issue-level` or `Spec required: wave-level`, or when implementation would otherwise require guessing about contracts, state, ownership, external dependencies, validation, or rejected approaches.

When no explicit gate is set, deterministic issue and repo evidence may be
recorded inline as `Spec required: none`. Do not silently bypass an explicit
gate. Reclassify an existing `issue-level` or `wave-level` marker to `none` only
when current evidence proves that marker stale, and record the correction plus
the evidence in the wave ledger before implementation.

Use an `issue-level` spec for one complex but isolated child issue. Use a `wave-level` spec when several child issues share contracts, write targets, runtime flow, fixtures, or validation. If multiple active issues are marked `issue-level` but clearly share the same source-of-truth files or execution flow, coalesce them into one wave spec instead of generating one spec per issue.

Default to a compact execution checklist. Expand to a full spec only when compact mode would leave safety, contract, ownership, or validation ambiguity. A final smoke/regression child normally belongs inside the wave spec as the last exit gate, not as its own large spec.

Spec gate sequence:

1. The root orchestrator invokes ``implementation-spec-maker`` directly; a child must never own this gate because root owns the artifact and worker topology.
2. Root supplies the parent issue, active child issue references, repo instructions, source-of-truth docs, accepted/rejected approaches, external contracts, live prerequisites, protected paths, expected ownership boundaries, and required verification.
3. Root lets ``implementation-spec-maker`` choose compact/full shape independently from review profile and add only the risk controls, checkpoints, and handoff fields required by its current contract.
4. Let ``implementation-spec-maker`` run its shared Artifact Review Loop. That Module exclusively owns review profile, topology, budget, Review Capsule, Defect Ledger, Closure, and terminal outcome; the orchestrator must not route an extra reviewer or create another retry loop.
5. Apply maker-authorized consolidated repairs only through that Module. If feedback changes product scope, reveals an unconfirmed contract, or creates ambiguity, stop and ask the user a targeted question.
6. Record the accepted spec path, mode, review profile, review outcome, reviews used, reviewed revision, coverage, and open defect IDs in the wave ledger.
7. Invoke ``spec-implementer`` inline at root for the accepted spec. Persist its Review Plan and counters under `## Implementation Review State` before the first implementation reviewer launch.
8. Only after the artifact review outcome permits execution and ``spec-implementer`` preflight passes, start implementation workers.

A spec gate is not optional once genuinely triggered, but its size is optional and must stay proportional. Do not downgrade a real gate to no spec because the user asked for autonomous execution; autonomy means the orchestrator creates the smallest sufficient spec without further prompting unless a stop condition is reached.
