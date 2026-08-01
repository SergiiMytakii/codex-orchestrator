# Delegate And Integrate

## Fresh child ownership

Launch one unique fresh `implementer` per child. Root never keeps a ticket for
itself, splits one child among workers, or reuses a prior worker context. Begin
the assignment with `Assigned role: implementer` and provide the complete
ticket, complete Parent PRD, repository policy, bounded write scope and
exclusions, blocker state, proof, stop conditions, concurrent-work warning,
and no-Git boundary.

Record a non-empty identity and complete the wait for that same worker. Require
changed files, local proof, skipped checks, risks, Decision Deltas, overlap, and
blockers. Worker timeout, failure, missing identity, incomplete wait, scope
drift, or any staging or commit attempt blocks its ticket. Root must not finish
the child on the worker's behalf.

## Frontier and waves

Build readiness from authoritative native blockers and the current root
checkpoints. Before scheduling, resolve every ticket to one stable repository
key and use only that repository's in-memory integration-worktree, baseline,
and checkpoint entry. A successor stays blocked until its prerequisites have a
confirmed checkpoint in the correct repository entries and current combined
proof across every affected repository range.

Tickets may share one wave only when their owners, write scopes, public seams,
proof resources, migrations, generated artifacts, and source-of-truth
contracts are all disjoint. Any uncertainty or overlap forces strict
sequencing. Wait for the whole disjoint wave before integration.

## Root integration gate

The mandatory order is: worker completion, root diff inspection, rewritten
target-state checks, combined deterministic proof, root checkpoint commit,
then successor release.

After every wave, root:

1. verifies each worker identity, completed wait, report, and local proof;
2. inspects the complete integrated diff and status in every affected
   repository-keyed integration worktree without discarding unrelated or
   ambiguous work;
3. confirms every changed file belongs to exactly one authorized child scope;
4. runs only the rewritten targeted coordinator checks and the smallest
   affected combined deterministic check on settled bytes;
5. creates no new checkpoint in an unsettled repository and releases no
   successor on any failure or stale result, while retaining any earlier
   repository checkpoint already confirmed for the wave; and
6. after all gates pass, creates one scoped root checkpoint in each affected
   repository whose message names the Parent and exact child or wave issues,
   confirms each from Git, appends each SHA to the matching in-memory checkpoint
   sequence, and only then recalculates the frontier.

Proof briefs must name the repository key, integration worktree, baseline,
current checkpoint, and exact range being exercised. Never combine bytes from
different repositories into an implied single Git range. The coordinator may
aggregate proof outcomes in memory, but must not persist the integration ledger
or create bookkeeping commits.

## Multi-repository wave settlement

Checkpoint settlement is per repository even though successor release is per
wave. If settlement is interrupted after some repositories commit, keep every
confirmed earlier checkpoint and reconstruct all affected repository entries
from Git. Never roll back, rewrite, or duplicate a confirmed commit to make the
wave appear atomic.

For each repository without a confirmed checkpoint, first use Git to determine
whether its authorized work is intact. No matching commit means its checkpoint
is not yet created; it is not by itself a failed checkpoint commit. Revalidate
intact work in that repository's isolated integration worktree. If work is
missing, assign a unique fresh implementer to recreate it under the original
ticket scope and no-Git boundary, then integrate it there. Rerun affected
target-state checks and the combined deterministic proof over every repository
range before root creates only the missing scoped checkpoints. Release no
successor until every repository checkpoint for the wave is confirmed and the
combined proof is current. Record no settlement state outside the ephemeral
repository-keyed ledger.

Root may make a small integration-only repair after diff inspection and must
rerun affected proof. A change to product behavior, ownership, scope, or ticket
boundaries is a Decision Delta and stops integration.
