# Stop And Completion

## Fail-closed conditions

Create no new checkpoint in an unsettled repository and release no successor
when any of these is true. Retain any earlier repository checkpoint already
confirmed for a partially settled multi-repository wave:

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
- a ticket, checkpoint, proof result, or final range cannot be assigned to
  exactly one repository-keyed in-memory integration entry;
- checkpoint ownership, message, scope, or commit result is ambiguous;
- the final reviewer is missing, incomplete, failed, timed out, tied to another
  revision, or does not approve; or
- work is interrupted while index or worktree ownership is uncertain.

## Recovery

Rebuild the lost in-memory repository ledger only from authoritative repository
identity, each integration worktree and pinned baseline, Parent PRD, tracker,
tickets, Git, and unique root checkpoints. Worker narration and uncommitted
state are not completion evidence. Recovery creates no additional durable
workflow record.

After a lost checkpoint response, reread Git in the affected repository before
any retry. Recover only one commit reachable from that repository's pinned
baseline with the expected Parent-and-ticket message and exact authorized
scope. Append that SHA to the matching in-memory checkpoint sequence and
`recovery_commits`; never create a recovery-only commit. More than one match
blocks the ticket. If no match exists and Git confirms no checkpoint was
created, classify that repository checkpoint as not yet created, not as a
failed checkpoint commit. Preserve confirmed checkpoints in the other
repositories, then revalidate intact authorized work or recreate missing work
through a unique fresh implementer in the affected isolated integration
worktree. Root reruns affected checks and combined proof and creates only the
missing checkpoint. Leave ambiguous staged or unstaged bytes untouched; do not
guess, discard, stage, commit, or release a successor. No successor is released
until every repository checkpoint and the combined deterministic proof settle.

## Completion standard

The graph is complete only when every child has one confirmed root checkpoint,
all blockers are settled, every final repository worktree boundary is clean,
deterministic proof is current for every exact `baseline..final` range, the
complete Parent PRD is proved directly against those full cumulative diffs, and
one fresh Standards reviewer completed on the repository-keyed range map with
an `APPROVE` verdict covering requirement fidelity and correctness. A child
checkpoint, local test result, tracker status, worker report, generic verdict,
or review of only the final child cannot establish Parent completion.

Report any skipped check, Decision Delta, unresolved overlap, remote Git action,
or tracker action honestly. Never infer push or PR authority from local graph
completion.
