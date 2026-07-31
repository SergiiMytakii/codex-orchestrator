# Issue #1253 completion proof

Baseline: #1252 checkpoint `7a8ffa751d95374cf6e952026f4ea89a25515d3e`.

## Result

- `pending-effect-settlement.ts` owns the finite settlement protocol used by
  commit, push, draft PR, issue/PR comments, labels, and candidate-pin cleanup:
  exact typed identity, observation, at most one authorized invocation, and an
  exact observed postcondition.
- Initial and post-PR publication use the same commit, push, comment, labels,
  and cleanup primitives. There is no step array, generic transition table,
  plan interpreter, queue, retry coordinator, or hidden retry.
- An invocation with an unknown result leaves the exact `PendingEffect`
  durable. Replay observes first; a confirmed effect is never invoked again.
- Candidate cleanup now has the explicit `candidate-pin-release` identity.
  The prior commit-to-push transition that cleared `candidateBinding` before
  pin release was deleted. Push intent and candidate-owner removal are now one
  CAS after the cleanup postcondition is observed.
- Candidate commit adapters use `observeOnly` before invocation, so the same
  finite commit handler covers ordinary and immutable-candidate publication.
- Residual mutable bytes are still checked before cleanup or push. Existing
  authority rereads, same-PR/head/source validation, denied paths, and
  force-push prohibition are unchanged.

## Owner and deletion map

Before:

- Initial and post-PR paths each implemented their own
  observe/invoke/re-observe branches for commit, push, comments, and labels.
- Candidate publication replaced the commit intent with push and removed the
  binding before fallible pin cleanup, relying on later orphan reconciliation.

After:

- Run owns the current single `PendingEffect` and publication context.
- `pending-effect-settlement.ts` owns only the finite effect protocol and has
  no Run lifecycle, phase, semantic budget, retry schedule, store, or queue.
- `RunIssue` remains the CAS/authorization/terminal adapter and supplies the
  package-owned Git/GitHub observations and invocations.
- Candidate pin remains a finite resource primitive; its release is now an
  explicit PendingEffect rather than an unowned fallible tail operation.

Deleted mechanisms: duplicate inline effect retry decisions, push-before-pin-
cleanup ownership removal, and occurrence-number fault tests that could hit an
unrelated state write instead of a named effect transition.

## Metrics

Using the issue-prescribed production paths and including the new source file:

- V2 production LOC: 21,493 -> 21,790 (`+297`).
- `src/v2/run-issue.ts`: 3,921 -> 4,112 (`+191`).

This extraction intentionally records its honest local movement. #1254 is the
dependent structural-deletion slice that must remove the remaining RunIssue
publication/spec/recovery wrappers and produce the required final net deletion
against B0; these numbers are not represented as simplification by themselves.

## Verification

- RED: build failed while the settlement module was absent.
- Finite handler protocol and identity tests: 5/5 passed.
- Exact run-state/config contract regression: 19/19 passed.
- Direct and spec-first initial publication: passed.
- Direct and spec-first trusted same-PR continuation: passed.
- Invocation rejection matrix for commit, push, draft PR, comments, and labels:
  passed with the exact intent retained and no later effect.
- Named crash transitions after commit, cleanup, push, draft PR, handoff comment,
  and final labels: passed; replay produced no duplicate external effect.
- Candidate unknown-result observation and fallible cleanup replay: passed.
- Residual/denied mutation, candidate proof failure, and post-proof drift guards:
  passed without push.
- Typecheck, build, and `git diff --check`: passed.

The full package suite and controlled scratch live smoke remain final-HEAD
gates in #1255.
