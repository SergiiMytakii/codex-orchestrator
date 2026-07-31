# Issue #1250 completion proof

Baseline: #1249 checkpoint `164c941`.

## Result

- Triage, spec author/review, implementation, implementation report repair,
  code review, configured checks, and Acceptance Proof now persist the same
  launched `ActiveAttempt`, enter `safe-halt`, return a typed resumable
  projection, and release the repository lock without invoking an operation-
  specific wait callback.
- Each later tick performs one fresh process-identity observation. Live,
  unknown, or permission-inaccessible observation preserves exact attempt,
  result fence, cleanup state, candidate materialization, and semantic budgets.
- Proven process-group absence or PID reuse permits one exact result inspection,
  followed by one cleanup observation. Replacement remains forbidden until
  absence/reuse and cleanup are confirmed; an exact result is adopted through
  the original attempt identity.
- The runtime cleanup capability is operation-neutral and derives the owned
  read-view from a narrow run/attempt/result identity. It verifies the exact
  package-derived result path and canonical contained attempt root before
  deletion; forged or symlink-redirected roots remain pending. It receives no
  phase, source, findings, semantic budget, or publication policy.
- The daemon continues later candidates after an unresolved result and performs
  fresh candidate discovery on the next tick.

## Verification

- Complete operation-family safe-halt matrix: 8/8 passed.
- Live, absent, PID-reuse, permission-inaccessible, cleanup-pending, exact
  result-adoption, lock-release, no-replacement, no-budget-spend, fresh
  discovery, and issue-isolation scenarios passed.
- Affected safe-halt/quiescence/runtime selection after cleanup-identity
  consolidation: 9/9 passed.
- Active-attempt, route/spec coordinator, proof, report-operation, reviewer,
  daemon, and run-store suites: 58/58 passed.
- Production runtime cleanup adapter: 3/3 passed, including exact contained
  cleanup plus forged and symlink-redirected path rejection.
- Typecheck and `git diff --check`: passed.

No retry coordinator, queue, workflow engine, compatibility path, or new
lifecycle owner was introduced. Legacy operation-specific infinite wait
callbacks and the runtime infinite process-group wait helper were deleted.

Independent Full review's high cleanup-path finding was repaired with the
narrow identity and canonical containment check described above.
