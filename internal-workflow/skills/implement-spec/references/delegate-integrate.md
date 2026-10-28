# Delegate And Integrate

## Fresh child ownership

Launch one unique fresh `implementer` per child. Root never keeps a ticket for
itself, splits one child among workers, or reuses a prior worker context. Begin
the assignment with the role and named child as its only executable scope, then
put the complete ticket before scope, proof, stop/Git boundaries, Parent
context, and repository policy.

Parent context is acceptance authority, not scope. Quote source-identified Parent
sections that constrain the child and link the complete PRD for read-only inspection.
Include the complete Parent only when constraints cannot be separated safely.
Use pointers for shared research and prior commits instead of repeating those sources.

```text
Assigned role: implementer
Your only executable scope is ticket #<id>.

COMPLETE CHILD TICKET #<id>
<verbatim ticket>

WORKSPACE / BASE CHECKPOINT / SCOPE / EXCLUSIONS / PROOF / STOP / NO-GIT
<absolute workspace, confirmed base SHA, bounded instructions>
Use $tdd where a meaningful pre-change failure is possible; otherwise direct proof.
Apply the Design Decisions rule in
$CODEX_ORCHESTRATOR_WORKFLOW_ROOT/docs/agents/coding-skill-routing.md#design-decisions
before editing; preserve approved design constraints.

PARENT CONTEXT — acceptance authority only
<verbatim relevant sections with headings or anchors>
Complete Parent PRD (read-only): <reference>

REPOSITORY POLICY / CONCURRENT WORK
You are not alone in the codebase. Preserve others' edits and work only in the
assigned workspace and scope. Perform no Git actions and spawn no children.
<applicable policy and source pointers>
```

Record a non-empty identity and complete the wait for that same worker. Require
changed files including additions and deletions, local proof, skipped checks,
risks, Decision Deltas, overlap, and blockers. A worker failure, timeout, scope
drift, incomplete wait, or Git action blocks that child and its dependents.
Root must not finish the ticket on the worker's behalf.

## Workspace isolation and result transfer

Prefer one root-created clean worker worktree per active child, based on the latest
confirmed integration checkpoint for its repository. Root confirms its exact base
SHA before dispatch. Workers write files only: root owns worktree creation, transfer,
index, commits, and cleanup. Never reset or repurpose an existing user worktree.

Root compares the completed workspace to its recorded base and inspects all changes,
including new, deleted and binary files and mode changes. Transfer only the authorized
child delta into the current integration worktree. Use a checked patch or equivalent
bounded file transfer that preserves additions, deletions, binaries and modes; do not
copy an entire checkout or overwrite changes already integrated by other children.
A patch must apply cleanly against the current checkpoint. Stale overlap or conflicts
return to a fresh worker at the current checkpoint; root does not silently resolve
behavioral differences. Rerun affected proof on integrated bytes, regardless of the
worker's local result. An advanced integration tip alone does not invalidate a
non-overlapping delta; its integrated proof still must be current.

If the execution environment cannot give each worker an isolated working directory,
use the root-owned integration worktree. Parallel shared-worktree writers require
proven disjoint file scopes and resources. Wait for every shared writer to stop before
inspection, proof and commit; otherwise run tickets serially. Never stage or commit
while a worker can still change the bytes being checked.

## Frontier and settlement

Build readiness from authoritative native blockers and confirmed root checkpoints.
Resolve every ticket to one stable repository key and use only that repository's
in-memory integration-worktree, baseline, and checkpoint entry. A successor remains
blocked until its prerequisites and current combined proof are confirmed.

Concurrent children must have disjoint owners, write scopes, public seams, proof
resources, migrations, generated artifacts and source-of-truth contracts. Any
uncertainty or overlap forces sequencing, even with separate worktrees.

For isolated workers, integrate each completed child independently and recalculate
the frontier after its confirmed checkpoint. A slow unrelated worker does not block
an otherwise ready successor. Compare the successor's scope and proof resources to
all still-running children before dispatch. A failed unrelated child blocks its own
closure and final Parent acceptance, not an independently proved settlement.

Wait as a group when shared-worktree writers are active or acceptance requires
coupled proof across children or repositories. A multi-repository wave settles
checkpoints per repository but releases as one unit. Do not release a successor
from one repository's checkpoint while its coupled prerequisite is unsettled.

## Root integration gate

The mandatory order is: completed worker wait, scoped transfer and root diff
inspection, affected behavioral checks, combined proof on integrated bytes,
root checkpoint commit, Git confirmation, then successor release.

Before committing, verify every changed file belongs to the settled child or coupled
group and that no active writer can mutate the integration worktree. Use existing
repository checks where they exercise the requested behavior. Add or adjust proof
only for the missing behavior; no rule requires rewriting an existing test or adding
a new runner. Never accept a worker report or skill-structure test as product proof.

Proof briefs must name the repository key, integration worktree, baseline, current
checkpoint, and exact range being exercised. Keep repository Git ranges separate.
Confirm each scoped checkpoint from Git and append its SHA to the matching ledger
entry before recalculating readiness. Create no affected checkpoint on failed or
stale proof. Preserve already confirmed independent checkpoints.

## Coupled multi-repository settlement

If settlement is interrupted after some repositories commit, retain those earlier
commits; do not roll them back, rewrite them, or duplicate them to simulate an atomic
wave. Reconstruct every affected repository from Git before retrying.
No matching commit means its checkpoint is not yet created; it is not by itself a
failed checkpoint commit. Revalidate intact authorized work or recreate missing
work through a unique fresh implementer under the original no-Git ticket boundary.
Rerun affected checks and combined proof over every coupled repository range, then
create only the missing checkpoints. Release no successor until the coupled group
settles. See [stop-completion.md](stop-completion.md) for recovery and stop conditions.
