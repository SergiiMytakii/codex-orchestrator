# Finish And Deliver

## Cumulative Parent acceptance

Start only after every child has a confirmed root checkpoint, every blocker is
settled, every repository-keyed integration worktree is clean, and required
deterministic proof is current on every final checkpoint.

1. In the in-memory ledger, pin each repository's final checkpoint and exact
   `baseline..final` range. Compare the complete Parent PRD directly against the
   full cumulative diff for every range. Cover every Parent obligation,
   exclusion, child interaction, and failure path.
2. Launch exactly one fresh `standards_reviewer`. Give its brief the
   repository-keyed map of integration worktrees, baselines, final checkpoints,
   exact final ranges, and proof plus the Parent PRD, child graph, and repository
   policy. Require Parent-obligation, correctness, and cleanup findings plus
   `APPROVE` or `BLOCK`.
3. Capture its non-empty identity and require its completed wait. Its output
   must cover both review questions and tie findings to every pinned final range.
   Generic `PASS`, a partial wait, missing Parent coverage, or a failed or
   timed-out reviewer blocks Parent completion.
   A blocker requires a concrete correctness defect, missing Parent obligation,
   required-proof gap, or real ownership or runtime conflict. Fowler smells and
   general improvements are non-blocking observations without concrete impact;
   the reviewer may return `APPROVE` with observations.
4. Verify findings against the cumulative diff. For every authorized in-scope defect,
   assign a unique fresh implementer to the affected existing ticket under its
   original bounded assignment and explicit no-Git boundary. Root integrates
   the worker result, reruns affected target-state checks and combined
   deterministic proof, creates a new scoped checkpoint, pins that revision,
   and launches a new distinct fresh targeted reviewer. Root never
   edits the repair. Before relaunch, update the affected in-memory final
   checkpoint and range. Give the reviewer the previous reviewed checkpoint
   as baseline, the repair delta, repaired blockers, directly affected Parent
   obligations and cross-ticket seams, and current affected proof. Review only
   the repair delta and directly affected Parent obligations. Untouched parts of
   the cumulative result retain their approval. Before dispatch, consolidate
   every blocker from the current review into one graph-final repair batch and
   dispatch each affected ticket once for that revision. Repeat the graph-final repair and targeted
   Review loop until approval; reviewer count is never a stop condition, and
   in-scope repair requires no new user confirmation. Use a complete cumulative
   Review again only when the repair cannot be isolated from previously approved
   scope.
5. No per-ticket delivery Review runs for graph children. Never substitute the
   last child diff, checkpoint messages, child reports,
   tracker state, or root self-review for the completed approval.

Checking the reusable launch contract with deterministic tests is not the real
final activation. Activate reviewers only for the graph's settled final
revision after all source and consumer synchronization owned by that graph is
complete.

## Delivery boundaries

After the reviewer approves, report every repository key, integration worktree,
baseline, checkpoint and recovery-commit SHA, final checkpoint, exact final
range, direct Parent coverage, deterministic proof, reviewer identities and
verdicts, skipped checks, and residual risk. This is a report, not durable
workflow state. Reconcile tracker state only when explicitly authorized. Push,
PR, merge, and release each require separate authority; local graph acceptance
grants none of them.
