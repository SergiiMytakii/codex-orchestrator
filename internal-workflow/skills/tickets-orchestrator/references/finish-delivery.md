# Finish And Deliver

## Cumulative Parent acceptance

Start only after every child has a confirmed root checkpoint, every blocker is
settled, every repository-keyed integration worktree is clean, and required
deterministic proof is current on every final checkpoint.

1. In the in-memory ledger, pin each repository's final checkpoint and exact
   `baseline..final` range. Compare the complete Parent PRD directly against the
   full cumulative diff for every range. Cover every Parent obligation,
   exclusion, child interaction, and failure path.
2. Launch one fresh `spec_reviewer` and one fresh `standards_reviewer` in
   parallel. Give both briefs the
   repository-keyed map of integration worktrees, baselines, final checkpoints,
   exact final ranges, and proof plus the Parent PRD, child graph, and repository
   policy. Require Spec to check Parent-obligation fidelity and Standards to
   check correctness and cleanup, each returning `APPROVE` or `BLOCK`.
3. Capture both non-empty identities and require both completed waits. Their
   outputs must tie findings to every pinned final range.
   Generic `PASS`, a partial wait, missing Parent coverage, or a failed or
   timed-out reviewer blocks Parent completion. The reviewer verdict is
   evidence, not authority: approval exists when the completed independent
   review has no verified blocker or required-proof gap. A blocker requires a
   concrete defect or proof gap causally linked to a Parent obligation,
   existing invariant, or mandatory repository rule; other findings are
   non-blocking observations.
4. Verify findings against the cumulative diff. Before repair dispatch,
   independently establish **Authority**, **Trigger**, **Impact**, and
   **Minimal repair**. Only a finding with all four facts is a verified blocker
   eligible for repair. For every authorized in-scope defect,
   assign a unique fresh implementer to the affected existing ticket under its
   original bounded assignment and explicit no-Git boundary. Root integrates
   the worker result, reruns affected target-state checks and combined
   deterministic proof, creates a new scoped checkpoint, pins that revision,
   and launches only the affected fresh targeted lens: Spec for Parent behavior,
   Standards for correctness or mandatory rules, and both for mixed or
   unisolatable repairs. Root never
   edits the repair. Before relaunch, update the affected in-memory final
   checkpoint and range. Give the reviewer the previous reviewed checkpoint
   as baseline, the repair delta, repaired blockers, directly affected Parent
   obligations and cross-ticket seams, and current affected proof. Review only
   the repair delta and directly affected Parent obligations. Untouched parts of
   the cumulative result retain their approval. Before dispatch, consolidate
   every verified blocker from the current review into one graph-final repair batch and
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

After coordinator approval from the completed independent evidence, report
every repository key, integration worktree,
baseline, checkpoint and recovery-commit SHA, final checkpoint, exact final
range, direct Parent coverage, deterministic proof, reviewer identities and
verdicts, skipped checks, and residual risk. This is a report, not durable
workflow state. Reconcile tracker state only when explicitly authorized. Push,
PR, merge, and release each require separate authority; local graph acceptance
grants none of them.
