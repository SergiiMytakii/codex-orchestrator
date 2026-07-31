# Issue #1252 completion proof

Baseline: #1251 checkpoint `e3c1f18fa55dff37996c6596e079f35ba168836c`.

## Result

- `validation-progression.ts` is the single fixed seam for initial direct,
  spec-first, and trusted post-PR validation. It accepts the immutable Run plus
  exact `DeliveryAuthority` and returns typed dispatch and CAS transitions for
  review start, review approval/needs-work/report repair/transport retry,
  semantic check/proof repair, proof start/pass, and terminal review recovery.
- Trusted post-PR activation and a passed proof are each accepted in the same
  CAS that records their semantic outcome; neither can leave a partially
  accepted feedback/proof state after a crash.
- The seam has no store, CAS, repository, Git, GitHub, process, cleanup, retry,
  or publication dependency. `RunIssue` remains the CAS/effect adapter and
  executes the phase selected by the exact transition.
- The fixed progression is implementation, complete independent review,
  configured checks, Acceptance Proof, then publication. A feedback batch adds
  only batch/round context; it does not select a different mode or lifecycle.
- `RunIssue` consumes every CAS transition through one adapter that verifies
  exact Run ID, lifecycle, cycle, authority hash, ActiveAttempt identity, and
  PendingEffect identity before the state writer is called. A stale transition
  cannot dispatch or write.
- Semantic repair is one CAS transition back to implementation. The redundant
  intermediate `reworking` lifecycle and its crash-recovery branch are deleted.
- The unreachable route-mode fallback after authority, stale `route-ready`
  public result/CLI validator, and route-specific `runDirectReviewFull` symbol
  are deleted. Both authority variants require the same candidate/review seam.
- At most one existing `ActiveAttempt` identity is carried in the transition;
  any `PendingEffect` blocks validation dispatch. No workflow engine, generic
  coordinator, queue, mode switch, or second progression owner was added.

## Owner and deletion map

Before:

- `RunIssue` selected validation phases, contained the route-mode fallback,
  performed a two-CAS `reworking -> implementing` repair transition, and used
  a route-named review wrapper that already handled both routes.

After:

- Run owns lifecycle, authority, budgets, findings, checks, and proof receipts.
- `validation-progression.ts` owns only fixed phase selection and typed repair
  projection from immutable Run authority.
- `RunIssue` owns repository lock, fresh authorization, Run CAS, operation
  dispatch, terminal projection, and the existing finite effects.
- `ActiveAttempt` and `PendingEffect` cardinality and ownership are unchanged.

Deleted production symbols/transitions: `route-ready`, `reworking`,
`runDirectReviewFull`, and the post-authority direct/spec fallback branch.

## Metrics

Using the issue-prescribed commands and including the new untracked production
file before commit:

- V2 production LOC: 21,183 -> 21,493 (`+310`).
- `src/v2/run-issue.ts`: 3,976 -> 3,921 (`-55`).

The graph remains well below B0 (22,704 V2 LOC / 4,142 RunIssue LOC). Final net
deletion is remeasured after #1254/#1255; this slice records its honest local
delta rather than treating code movement as deletion.

## Verification

- RED: build failed because the validation seam did not exist.
- Validation transition, outcome projection, repair projection, and a stale
  Run ID/lifecycle/cycle/authority/attempt/effect matrix at the production
  `RunRecordWriter` boundary: 6/6 passed.
- Direct/spec/post-PR happy paths, complete re-review, check/proof repair,
  malformed review recovery, replay, and candidate drift: 9/9 passed.
- DeliveryAuthority, direct-review, CheckedChange/CLI contract, and validation
  contract selection: 13/13 passed.
- Typecheck/build and `git diff --check`: passed.
- Production searches find no `route-ready`, `reworking`, or
  `runDirectReviewFull` symbol.

The full package suite and controlled live smoke remain final-HEAD gates in
#1255.

The independent Full review rejected the first draft because it decoded phases
but discarded CAS expectations while `RunIssue` still assembled accepted
outcomes. Closure review then found partial proof acceptance, manual post-PR
activation, and a test-only stale-CAS callback. All three were repaired: the
seam owns both semantic outcomes, and production and tests consume transitions
through the same exact expected-binding adapter.
