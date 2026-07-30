# Issue #1245 proof — one validation loop

## Scope

Initial delivery and trusted post-PR feedback now share the same bounded sequence:

`implementation -> complete independent review -> configured checks -> Acceptance Proof`

The post-PR observer only freezes and revalidates trusted feedback. The frozen
batch, semantic round, consumed source IDs, and monotonic update epoch are Run
data. Publication remains a sequence of single durable `PendingEffect` intents.

## Deleted mechanisms

- pre-implementation qualification checks and the `qualification-repair` worker,
  budget, candidate boundary, state receipt, generated operation, and recovery;
- Full/Closure modes, closure hashes, affected-only review transitions, and
  legacy malformed-Closure recovery for implementation and spec review;
- post-PR phase/terminal state machine and its no-op repairing/publishing transitions.

Every semantic repair now captures a new candidate, allocates a new independent
reviewer session, performs a complete review, and accounts for prior finding IDs.
A configured-check failure is passed directly as a bounded finding to the next
implementation cycle. Proof `external-block` remains a typed external blocker.

## Budgets and effects

- Initial delivery: 5 semantic implementation cycles, 1 implementation-report
  repair, and 4 review-report repairs per target revision.
- Frozen post-PR batch: 3 separate semantic rounds, 1 implementation-report
  repair for the batch, and 4 review-report repairs per target revision.
- Transport, replay, and CAS recovery do not reserve semantic rounds.
- Publication order remains activation labels, commit, fast-forward push,
  marker-bound summary, and final labels; each effect has one durable identity
  and observed postcondition. There is no force-push, merge, or thread resolution.

## Deletion evidence

Baseline is #1244 commit `0babe28de1879f479c304d66e8505b3bb8e0d4a5`.

- V2 production LOC: 21,294 -> 20,775 (`-519`).
- `src/v2/run-issue.ts`: 4,080 -> 3,827 (`-253`).
- V2 production diff: `+154 / -673`, net `-519`.
- Whole slice before proof: `+458 / -1,150`, net `-692`.
- Production/generated grep has no `qualification-repair`, `review-full`,
  `review-closure`, closure hash, or Full/Closure contract.

## Verification

- Build: passed.
- Review/report/spec/feedback contracts: 19/19 passed.
- Focused Run integration: 6/6 passed, covering same-Run spec delivery, happy
  path launch counts, four review format repairs, malformed report repair,
  check/proof rework with a complete re-review, and trusted post-PR replay/effects.
- Workflow/package contracts: 22/22 passed.
- Generated workflow verification: passed.
- `git diff --check`: passed.

No full repository suite or live smoke was run for this slice. Live packed
scratch proof remains reserved for #1246.

## Complexity review

No workflow engine, queue, cache, retry coordinator, classifier, generic plan
interpreter, compatibility reader, or replacement lifecycle was added. The only
post-PR service is the existing read-only `ReviewFeedbackObserver`; all
progression and effect recovery remain owned by the Run, `ActiveAttempt`, and
`PendingEffect`.
