---
name: tickets-orchestrator
description: Coordinate an approved multi-ticket dependency graph through unique fresh workers, strict dependency-safe integration, root-owned Git checkpoints, direct Parent proof, and one cumulative parallel Spec and Standards review. Route a single ticket to Implement.
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

## Authority and ownership

Before work, require:

- a clean isolated integration worktree and pinned baseline;
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

## Coordinator contract

1. Pin `baseline`, inspect clean status, reread Parent, tickets, tracker links,
   blockers, and labels, then build the ready frontier.
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
   proof are current may root create the scoped checkpoint. Its message names
   the Parent and exact child or wave issues.
8. Reread Git to confirm the checkpoint and clean integration boundary before
   releasing successors. A proven checkpoint is an integration boundary, not
   a Parent completion claim.

Root may repair only a small integration defect discovered from the integrated
diff. New behavior, ownership, scope, or ticket boundaries are a Decision Delta
and stop the graph.

## Recovery

After interruption, reconstruct progress only from the pinned baseline,
Parent PRD, tracker, tickets, Git, and a unique root checkpoint. Do not trust
worker narration or create duplicate durable run state.

If a checkpoint command result is lost, reread Git before any retry. Accept
recovery only when exactly one reachable scoped commit after the baseline has
the expected Parent-and-ticket message and matching diff. Zero or multiple
matches, unexpected commits, uncertain ownership, or ambiguous uncommitted or
staged state fail closed. Leave uncertain bytes untouched, create no affected
checkpoint, and release no successor.

## Final Parent acceptance

After every child checkpoint and final deterministic proof are settled, compare
the complete Parent PRD directly against the full cumulative diff from the
pinned baseline through the final checkpoint. Do not substitute child reports,
local tests, tracker state, or the last child diff.

The reusable final-review mechanism launches exactly two distinct fresh
reviewer children in parallel on the same identical final revision:

- `Assigned role: spec_reviewer` checks every Parent obligation directly
  against the full diff and completed proof.
- `Assigned role: standards_reviewer` checks correctness, repository policy,
  failure paths, cleanup, duplicate ownership, compatibility residue, and
  unnecessary machinery on that same revision.

Capture both non-empty identities, complete both waits, and require
axis-specific findings and `APPROVE` from each. Generic `PASS` without direct
Parent coverage is rejected. A failed or timed-out axis blocks Parent
completion. After a material in-scope repair, rerun affected target-state and
combined deterministic proof, pin the new revision, and launch a new parallel
pair; no old approval carries forward.

Deterministic checks may prove this mechanism's contract without counting as a
real final-review activation. The real activation occurs only for the settled
final graph revision owned by the graph's final acceptance step.

Read [delegate-integrate.md](references/delegate-integrate.md) for workers,
waves, integration, and checkpoints; [finish-delivery.md](references/finish-delivery.md)
for cumulative review and authorized delivery; and
[stop-completion.md](references/stop-completion.md) for fail-closed recovery.

## Handoff

Report baseline and final checkpoint SHA, frontier state, worker identities and
write scopes, dependency and overlap decisions, checkpoint messages, combined
deterministic results, both final review axes when activated, tracker actions,
skipped checks, risks, Decision Deltas, blockers, and exact Git actions. Never
claim Parent completion from a child checkpoint.
