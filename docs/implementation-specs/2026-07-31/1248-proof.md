# Issue #1248 completion proof

Baseline: #1247 checkpoint `222dab8`.

## Result

- Canonical source uses stable code-point ordering of trusted comment IDs.
- Receipt stores the exact immutable question correlation and outcome-evidence
  path, complete sorted source receipts, canonical minimum source, sorted unique
  equivalent duplicate IDs, normalized hashes, immutable comment metadata, and
  WRITE/ADMIN permission receipts.
- Observation and revalidation failures replay the same `spec-frozen`
  projection without state/CAS, semantic budgets, attempt/effect, evidence,
  Git/GitHub write, candidate/worktree, or worker launch.
- Every contributing answer and exact marker-first question body is revalidated
  before the successor spec author, successor spec review, and actual first
  implementation preparation/launch, including resume after the
  `spec-authoring → implementing` crash window and resume of an already
  prepared implementation attempt. A valid prepared attempt is reused without
  advancing the semantic cycle; stale authority freezes before any mutation.
  The agent's pre-launch `onPrepared` callback revalidates once more after
  durable attempt preparation, so a change in that interval cannot launch the
  implementation process.
- Conflicting trusted answers create a new immutable question revision without
  rerunning triage or launching implementation.
- Receipt and question remain Run data; no waiting state machine or additional
  lifecycle owner was introduced.

## Verification

- Selected product-answer/fault matrix: 9/9 passed (conflict continuation,
  exact marker, conflict-source revalidation, per-worker/pre-implementation
  revalidation, post-transition mutation, stale prepared-attempt resume, valid
  prepared-attempt reuse, pre-launch mutation, and edited answer).
- Spec delivery, delivery authority, implementation reviewer, and run-store:
  24/24 passed.
- Typecheck and `git diff --check`: passed.

Independent Full review found four high defects (`REVIEW-ANSWER-001` through
`REVIEW-ANSWER-004`) and one medium evidence-path regression. The consolidated
repair now revalidates conflict sources, gates the actual implementation
boundary, validates exact live question bytes and durable revision/canonical
correlation, and persists/replays the original outcome-evidence path.

Closure review verified all four immutable defects and the evidence-path repair
with no reopened production defect. The only closure finding was this proof's
stale affected-suite count, corrected above to the observed 24/24 result.

Later tickets touching spec progression or `RunIssue` must mark
`C-ANSWER-001/002` stale and reprove them on the new settled revision.
