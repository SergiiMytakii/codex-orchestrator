# Stop And Completion

## Fail-closed conditions

Create no affected checkpoint and release no successor when any of these is
true:

- Parent authority, a ticket body, native blocker state, repository policy,
  owner, write scope, exclusion, or deterministic proof is missing or
  contradictory;
- a child needs a new product decision, changed ownership, changed scope, or a
  changed ticket boundary;
- worker identity is missing or reused, its wait is incomplete, it times out or
  fails, its output overlaps another owner, or it attempts a Git action;
- supposedly parallel children share an owner, write scope, public seam, proof
  resource, migration, generated artifact, or source-of-truth contract;
- the root diff contains unexplained or dirty overlapping bytes;
- target-state or combined deterministic proof is missing, failed, or stale;
- checkpoint ownership, message, scope, or commit result is ambiguous;
- either final reviewer is missing, reused, incomplete, failed, timed out, tied
  to another revision, or does not approve its axis; or
- work is interrupted while index or worktree ownership is uncertain.

## Recovery

Trust only the pinned baseline, Parent PRD, tracker, tickets, Git, and a unique
root checkpoint. Worker narration and uncommitted state are not completion
evidence. Recovery creates no additional durable workflow record.

After a lost checkpoint response, reread Git before any retry. Recover only one
commit reachable from the pinned baseline with the expected Parent-and-ticket
message and exact authorized scope. No match or more than one match blocks the
ticket. Leave ambiguous staged or unstaged bytes untouched; do not guess,
discard, stage, commit, or release a successor.

## Completion standard

The graph is complete only when every child has one confirmed root checkpoint,
all blockers are settled, the final worktree boundary is clean, deterministic
proof is current, the complete Parent PRD is proved directly against the full
cumulative diff, and two distinct fresh parallel reviewers completed on one
identical revision with axis-specific `APPROVE` verdicts. A child checkpoint,
local test result, tracker status, worker report, generic verdict, or review of
only the final child cannot establish Parent completion.

Report any skipped check, Decision Delta, unresolved overlap, remote Git action,
or tracker action honestly. Never infer push or PR authority from local graph
completion.
