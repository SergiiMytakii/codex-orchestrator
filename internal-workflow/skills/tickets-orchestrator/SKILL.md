---
name: tickets-orchestrator
description: Coordinate an approved multi-ticket dependency graph through unique fresh workers, strict dependency-safe integration, root-owned Git checkpoints, direct Parent proof, and cumulative Spec and Standards review. Route a single ticket to Implement.
---

# Tickets Orchestrator

Coordinate the complete approved graph. This skill owns graph scheduling,
integration, local checkpoints, and the cumulative Parent outcome. It does not
replace Implement for one ticket or create another planning layer.

## Graph-only boundary

Activate only for an approved graph with multiple executable child tickets,
multiple ready disjoint children, dependency-frontier coordination, or an
explicit request to execute the complete graph. A single deterministic ticket
routes to `$implement`, which supplies its one fresh worker and owns its normal
proof and review path.

Do not implement a planning-context Parent when executable children exist.
Root must not implement a full child or merge ticket boundaries. A ticket that
cannot execute from its body plus the Parent PRD is a ticket-packet defect and
fails closed.

Every child must authorize a committed product delta. Treat a transient-evidence
or comment-only child as a ticket-packet defect: return it to `$to-tickets`
without requesting an exception or creating an empty checkpoint.

## Authority and ownership

Before work, require:

- one clean isolated integration worktree and pinned baseline for every
  repository in the graph;
- the complete Parent PRD, complete tickets, and authoritative tracker state,
  including native Parent, sub-issue, and blocker links;
- repository policy, bounded child write scopes and exclusions; and
- deterministic proof obligations that exercise the target coordinator state.

Every child receives a unique fresh `implementer`. Begin every assignment with
`Assigned role: implementer` and include the complete ticket, complete Parent
PRD, repository policy, bounded write scope, exclusions, required proof, stop
conditions, and explicit no-Git boundary. Capture a non-empty worker identity
and wait for that same worker to complete. Workers perform no Git action and
return changed files, local proof, skipped checks, risks, Decision Deltas,
overlap, and blockers. Any worker Git event fails the child.

Root is the only integrator and Git writer. After the required gates pass, root
automatically creates a scoped child or wave checkpoint. Push and PR always
require separate authority. Tracker writes also require explicit authority.

## Ephemeral integration ledger

Keep one in-memory integration ledger keyed by stable authoritative repository
identity, never by a worker or worktree path. For each repository record its
integration worktree, pinned baseline SHA, ordered confirmed checkpoint SHAs,
any checkpoint SHAs rediscovered during recovery as `recovery_commits`, and,
once settled, its final checkpoint and exact `baseline..final` range. Fail
closed when repository identity or membership is ambiguous.

This ledger coordinates only the current run. Never serialize it to a file,
database, branch, commit, tracker field, comment, tag, or other durable state.
Git checkpoints remain product integration commits, not workflow-state
records. Rebuild a lost ledger from authoritative sources and confirmed Git.

## Coordinator contract

1. Populate the repository-keyed in-memory ledger, pin every baseline, inspect
   each integration worktree's clean status, reread Parent, tickets, tracker
   links, blockers, and labels, then build the ready frontier.
2. Do not start a blocked child. Sequence any dependency or overlap. Use one
   parallel wave only when owners, write scopes, public seams, proof resources,
   migrations, generated artifacts, and source-of-truth contracts are all
   genuinely disjoint.
3. Launch one unique fresh worker per ready child. Never reuse a worker context
   or treat narration as completion.
4. Wait for every worker in the wave. A failure, timeout, missing identity,
   incomplete wait, scope drift, dirty overlap, or stale or missing proof fails
   the affected wave.
5. Root inspects each worker report and the complete integrated diff, confirms
   ownership and scope, and leaves unrelated or ambiguous state untouched.
6. Run only rewritten target-state checks plus the smallest affected combined
   deterministic proof on the settled bytes. Do not use inherited coordinator
   tests, live agents, or Codex execution as acceptance evidence, and do not
   create a replacement runner.
7. Only after worker proof, root inspection, target-state checks, and combined
   proof are current may root create the scoped checkpoint in the affected
   repository. Its message names the Parent and exact child or wave issues.
8. Reread Git to confirm the checkpoint and clean integration boundary, then
   append its SHA to that repository's in-memory checkpoint sequence before
   releasing successors. A proven checkpoint is an integration boundary, not
   a Parent completion claim.

A multi-repository wave settles checkpoints per repository but releases as one
unit. If settlement stops after one or more repository checkpoints are
confirmed, retain those earlier commits; do not roll them back, rewrite them,
or duplicate them to simulate an atomic wave. Reconstruct every affected
repository from Git. For a repository with no confirmed checkpoint, classify
the checkpoint as not yet created, not as a failed checkpoint commit. In that
repository's isolated integration worktree, revalidate intact authorized work
or assign a unique fresh implementer to recreate missing work under the
original ticket boundary. Root then reruns affected target-state checks and the
combined deterministic proof across every repository range and creates only
the missing scoped checkpoint. Release no successor until every repository
checkpoint in the wave is confirmed and that combined proof is current. Keep
all settlement state only in the ephemeral repository-keyed ledger.

Any authorized in-scope repair returns to a unique fresh implementer for the
affected existing ticket under that ticket's original bounded assignment and
no-Git boundary. Root never edits the repair itself. Root integrates the worker
result, reruns the affected proof, and creates a new scoped checkpoint before
final review resumes. New
behavior, ownership, scope, or ticket boundaries are a Decision Delta and stop
the graph.

No per-ticket delivery Review runs for graph children. Their worker proof and
root checkpoint gates accumulate into the one final Parent Review below.

## Recovery

After interruption, reconstruct each repository entry only from its integration
worktree, pinned baseline, Parent PRD, tracker, tickets, Git, and unique root
checkpoints. Do not trust worker narration or create duplicate durable run
state. Put a uniquely rediscovered checkpoint SHA in both its ordered checkpoint
sequence and `recovery_commits`; do not create a recovery-only commit.

If a checkpoint command result is lost, reread Git in the affected repository
before any retry. Accept recovery when exactly one reachable scoped commit
after that repository's baseline has the expected Parent-and-ticket message and
matching diff. Multiple matches, unexpected commits, uncertain ownership, or
ambiguous uncommitted or staged state fail closed. When no matching commit
exists and Git confirms that no checkpoint was created, mark that repository
checkpoint not yet created and resume the per-repository settlement path; do
not describe it as a failed checkpoint commit. Leave uncertain bytes untouched
and release no successor until the whole wave settles.

## Final Parent acceptance

After every child checkpoint and final deterministic proof are settled, pin the
final checkpoint and exact `baseline..final` range in every repository entry.
Compare the complete Parent PRD directly against all full cumulative repository
ranges. Do not substitute child reports, local tests, tracker state, or the
last child diff.

The reusable final-review mechanism launches one fresh `spec_reviewer` and one
fresh `standards_reviewer` in parallel on the repository-keyed set of final
checkpoints and ranges. Spec checks every Parent obligation against the full
diff and proof. Standards checks correctness, repository policy, failure paths,
cleanup, duplicate ownership, compatibility residue, and unnecessary machinery.

Capture both non-empty identities and complete both waits. Reviewer verdicts
are evidence, not authority: root verifies each finding against the Parent and
cumulative diff, and Parent approval exists when both independent reviews have
no verified blocker or required-proof gap. Generic `PASS` without direct Parent
coverage, failed review, and timeout remain blocking. A blocker
requires a concrete defect or proof gap causally linked to a Parent obligation,
existing invariant, or mandatory repository rule. Other findings are
non-blocking observations.

Before repair dispatch, root independently establishes **Authority** (the
Parent obligation, invariant, or rule), **Trigger**, **Impact**, and **Minimal
repair**. Only a finding with all four facts is a verified blocker eligible for
repair. When root verifies such a blocker, assign the
affected existing ticket to a unique fresh implementer with no Git authority.
Root integrates the returned repair, reruns affected target-state and combined
deterministic proof, creates the scoped checkpoint, pins the new revision, and
launches only the affected targeted lens: Spec for Parent behavior, Standards
for correctness or mandatory rules, and both lenses for mixed or unisolatable
repairs. Before relaunch, update the affected
repository's final checkpoint and range. Give the reviewer the previous
reviewed checkpoint as baseline, the repair delta, repaired blockers, directly
affected Parent obligations and cross-ticket seams, and current affected proof.
Review only the repair delta and directly affected Parent obligations.
Untouched parts of the cumulative result retain their approval.

Before each repair dispatch, consolidate every verified blocker from the current review
into one graph-final repair batch. Dispatch each affected existing ticket once
under its original boundary, then settle all returned checkpoints and proof
before targeted Review. The original Parent and ticket authority covers these
in-scope repairs without another user confirmation. Repeat the graph-final
repair and targeted Review loop until approval; reviewer count is never a stop
condition. Use a complete cumulative two-lens Review again only when the repair
cannot be isolated from previously approved scope.

Deterministic checks may prove this mechanism's contract without counting as a
real final-review activation. The real activation occurs only for the settled
final graph revision owned by the graph's final acceptance step.

Read [delegate-integrate.md](references/delegate-integrate.md) for workers,
waves, integration, and checkpoints; [finish-delivery.md](references/finish-delivery.md)
for cumulative review and authorized delivery; and
[stop-completion.md](references/stop-completion.md) for fail-closed recovery.

## Handoff

Report, per repository key, the integration worktree, baseline SHA, ordered
checkpoint and recovery-commit SHAs, final checkpoint SHA, and exact final
range. Also report frontier state, worker identities and write scopes,
dependency and overlap decisions, checkpoint messages, combined deterministic
results tied to repository ranges, both final review questions and the ranges
in the reviewer brief when activated, tracker actions, skipped checks, risks,
Decision Deltas, blockers, and exact Git actions. Never claim Parent completion
from a child checkpoint or persist the in-memory ledger as handoff state.
