# Finish And Deliver

## Cumulative Parent acceptance

Start only after every child has a confirmed root checkpoint, every blocker is
settled, the integration worktree is clean, and required deterministic proof
is current on the final checkpoint.

1. Compare the complete Parent PRD directly against the full cumulative diff
   from the pinned baseline through the final checkpoint. Cover every Parent
   obligation, exclusion, child interaction, and failure path.
2. Pin one final revision and launch exactly two distinct fresh reviewer
   children in parallel on the same identical final revision:
   - `Assigned role: spec_reviewer` receives the Parent PRD, full diff, child
     graph, and proof, and reports Parent-obligation findings plus `APPROVE` or
     `BLOCK`.
   - `Assigned role: standards_reviewer` receives the identical revision and
     evidence plus repository policy, and reports correctness and cleanup
     findings plus `APPROVE` or `BLOCK`.
3. Capture two different non-empty identities and require completed waits for
   both. Their outputs must be axis-specific and tied to the pinned revision.
   Generic `PASS`, a partial wait, reused identity, missing Parent coverage, or
   a failed or timed-out axis blocks Parent completion.
4. Verify findings against the cumulative diff. For a material in-scope defect,
   assign a unique fresh implementer to the affected existing ticket under its
   original bounded assignment and explicit no-Git boundary. Root integrates
   the worker result, reruns affected target-state checks and combined
   deterministic proof, creates a new scoped checkpoint, pins that revision,
   and launches a new distinct fresh parallel reviewer pair. Reuse no prior
   verdict. Root may directly make only a small integration repair; it must not
   implement a material defect.
5. Never substitute the last child diff, checkpoint messages, child reports,
   tracker state, or root self-review for these two completed approvals.

Checking the reusable launch contract with deterministic tests is not the real
final activation. Activate reviewers only for the graph's settled final
revision after all source and consumer synchronization owned by that graph is
complete.

## Delivery boundaries

After both axes approve, report the cumulative range, direct Parent coverage,
deterministic proof, reviewer identities and verdicts, child checkpoints,
skipped checks, and residual risk. Reconcile tracker state only when explicitly
authorized. Push, PR, merge, and release each require separate authority; local
graph acceptance grants none of them.
