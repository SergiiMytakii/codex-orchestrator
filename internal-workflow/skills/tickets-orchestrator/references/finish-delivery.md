# Finish And Deliver

## Cumulative Parent acceptance

Start only after every child has a confirmed root checkpoint, every blocker is
settled, every repository-keyed integration worktree is clean, and required
deterministic proof is current on every final checkpoint.

1. In the in-memory ledger, pin each repository's final checkpoint and exact
   `baseline..final` range. Compare the complete Parent PRD directly against the
   full cumulative diff for every range. Cover every Parent obligation,
   exclusion, child interaction, and failure path.
2. Launch exactly two distinct fresh reviewer children in parallel. Give both
   reviewer briefs the same identical repository-keyed map of integration
   worktrees, baselines, final checkpoints, exact final ranges, and proof:
   - `Assigned role: spec_reviewer` receives the Parent PRD, full diff for every
     range, child graph, and proof, and reports Parent-obligation findings plus
     `APPROVE` or `BLOCK`.
   - `Assigned role: standards_reviewer` receives the identical range map and
     evidence plus repository policy, and reports correctness and cleanup
     findings plus `APPROVE` or `BLOCK`.
3. Capture two different non-empty identities and require completed waits for
   both. Their outputs must be axis-specific and tied to every pinned final
   range.
   Generic `PASS`, a partial wait, reused identity, missing Parent coverage, or
   a failed or timed-out axis blocks Parent completion.
4. Verify findings against the cumulative diff. For a material in-scope defect,
   assign a unique fresh implementer to the affected existing ticket under its
   original bounded assignment and explicit no-Git boundary. Root integrates
   the worker result, reruns affected target-state checks and combined
   deterministic proof, creates a new scoped checkpoint, pins that revision,
   and launches a new distinct fresh parallel reviewer pair. Reuse no prior
   verdict. Root may directly make only a small integration repair; it must not
   implement a material defect. Before relaunch, update the affected in-memory
   final checkpoint and range and give both reviewers the complete updated map.
5. Never substitute the last child diff, checkpoint messages, child reports,
   tracker state, or root self-review for these two completed approvals.

Checking the reusable launch contract with deterministic tests is not the real
final activation. Activate reviewers only for the graph's settled final
revision after all source and consumer synchronization owned by that graph is
complete.

## Delivery boundaries

After both axes approve, report every repository key, integration worktree,
baseline, checkpoint and recovery-commit SHA, final checkpoint, exact final
range, direct Parent coverage, deterministic proof, reviewer identities and
verdicts, skipped checks, and residual risk. This is a report, not durable
workflow state. Reconcile tracker state only when explicitly authorized. Push,
PR, merge, and release each require separate authority; local graph acceptance
grants none of them.
