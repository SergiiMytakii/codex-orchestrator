# Live smoke checklist

This checklist verifies `codex-orchestrator` against this repository as the
target repository. It is intentionally broader than issue #11: the goal is to
prove the full package flow through the packaged CLI, real GitHub Issues, real
labels, real daemon polling, real branches, real draft PRs, local runner state,
worktrees, logs, review gates, and cleanup behavior.

Use this as the manual acceptance checklist first. Automate only after the
manual shape is stable.

## Smoke contract

- [ ] Run against `SergiiMytakii/codex-orchestrator`, not a synthetic repo.
- [ ] Run the packaged CLI from `npm pack`, not TypeScript source files.
- [ ] Use real GitHub Issues and real labels through `gh`.
- [ ] Use `codex-orchestrator daemon --once` for the primary pickup path.
- [ ] Use `codex-orchestrator run --issue` only for comparison or focused
      reruns.
- [ ] Keep all smoke-created issues and PRs clearly named with
      `[live-smoke]`.
- [ ] Do not merge smoke PRs unless the scenario explicitly checks cleanup after
      a merged PR.
- [ ] Record every created issue number, branch, PR URL, log path, and worktree
      path in the smoke notes.
- [ ] Use real Codex as a required scenario in the default live smoke run.
- [ ] Use a deterministic fake Codex command only for runner contract checks
      that would otherwise be flaky or destructive to force through an LLM.

## Baseline setup

- [ ] Confirm working tree is clean enough for smoke changes:
      `git status --short`.
- [ ] Confirm GitHub CLI is authenticated and points to the expected repo:
      `gh repo view --json owner,name`.
- [ ] Build and package:
      `npm test`, `npm pack`.
- [ ] Install or invoke the generated tarball so `codex-orchestrator --version`
      reports the tarball version.
- [ ] Run `codex-orchestrator health`.
- [ ] Run `codex-orchestrator setup --target . --dry-run`.
- [ ] Run `codex-orchestrator setup --target . --prepare-labels`.
- [ ] Verify `.codex-orchestrator/config.json` exists and validates through
      `codex-orchestrator status --target . --dry-run`.
- [ ] Verify required labels exist in GitHub: `agent:auto`,
      `agent:plan-auto`, `agent:child`, `agent:running`, `agent:blocked`,
      `agent:manual`, and `agent:review`.

Expected result: setup can infer or use this repository, labels exist, status
can read GitHub, and no Codex execution starts during setup or status.

## Controlled Codex mode

For deterministic scenarios, temporarily configure `.codex-orchestrator/config.json`
so `codex.command` points to a local smoke fake agent script. The fake agent must:

- [ ] Read `CODEX_ORCHESTRATOR_PROMPT_FILE`.
- [ ] Write `CODEX_ORCHESTRATOR_REPORT_FILE`.
- [ ] Print stdout progressively so log streaming can be observed.
- [ ] Support scenario selection through a non-secret environment variable or
      issue text marker.
- [ ] Never push, open PRs, edit labels, or post GitHub comments.
- [ ] For success scenarios, write a valid completion report with validation
      evidence for tests, red-green TDD, code review, and cleanup review when
      required.
- [ ] For failure scenarios, intentionally produce the exact unsafe output being
      tested.

Expected result: the runner is the only actor that changes GitHub state. The
fake agent may edit files and make local commits only inside the issue worktree.

## Discovery and daemon pickup

- [ ] Run `codex-orchestrator daemon --target . --once` with no eligible smoke
      issue.
- [ ] Verify daemon prints no eligible issues and performs cleanup scan.
- [ ] Create a smoke issue with no auth label.
- [ ] Run `codex-orchestrator status --target . --dry-run`.
- [ ] Verify the issue appears as skipped because it has no configured
      authorization label.
- [ ] Add `agent:manual`, run status, and verify it is skipped as manual.
- [ ] Remove manual label, add both `agent:auto` and `agent:plan-auto`, run
      status, and verify conflicting authorization is skipped.
- [ ] Leave only `agent:auto`, run status, and verify it is eligible as
      `scoped-issue`.
- [ ] Run `codex-orchestrator daemon --target . --once --max-runs 1`.
- [ ] Verify daemon logs `running #<issue> scoped-issue`.

Expected result: daemon discovers exactly one eligible issue and skips all
blocked states deterministically.

## Scoped success flow

- [ ] Use a `[live-smoke] scoped success` issue labeled `agent:auto`.
- [ ] Configure fake Codex to change one harmless tracked smoke fixture file and
      one test file.
- [ ] Configure fake Codex to write a valid completion report with passed
      validation evidence.
- [ ] Run daemon once.
- [ ] Verify issue receives `agent:running` during execution.
- [ ] Verify issue ends with `agent:review` and no `agent:running`.
- [ ] Verify a `codex/issue-<number>` branch exists on GitHub.
- [ ] Verify one draft PR is opened and references `Closes #<issue>`.
- [ ] Verify the PR body includes validation evidence, changed paths, residual
      risks, skipped checks, and artifacts section when present.
- [ ] Verify the issue has a review report comment beginning
      `codex-orchestrator review report for #<issue>`.
- [ ] Verify the worktree exists under `.codex-orchestrator/workspaces`.
- [ ] Verify local runner state no longer lists the run as active.
- [ ] Verify the isolated Codex home was cleaned up after success.

Expected result: a complete scoped implementation handoff is visible as a draft
PR, and GitHub state transitions are runner-owned.

## Local commit policy

- [ ] Set `runner.allowAgentLocalCommits` to `false`.
- [ ] Run a scoped issue where fake Codex creates a local commit.
- [ ] Verify publication is blocked.
- [ ] Verify no PR is opened for that issue.
- [ ] Verify the blocked report explains that commits are not allowed.
- [ ] Set `runner.allowAgentLocalCommits` to `true`.
- [ ] Run a scoped issue where fake Codex creates a local commit and leaves no
      uncommitted changes.
- [ ] Verify the PR is opened.
- [ ] Verify PR body and issue report include the local commit summary.
- [ ] Verify the pushed branch includes the agent commit.

Expected result: local commits are accepted only when project policy allows
them, and accepted commits are still validated before publication.

## Full change-set awareness

Run separate scoped issues for each change shape:

- [ ] Committed-only change.
- [ ] Staged-only change.
- [ ] Unstaged tracked change.
- [ ] Untracked file.
- [ ] Mix of committed, staged, unstaged, and untracked files.

For each issue:

- [ ] Verify the runner detects changed paths.
- [ ] Verify checks and review gates run against the full change set.
- [ ] Verify the final PR or blocked report lists the relevant change evidence.

Expected result: no changed file is invisible because of its git state.

## Safety gates

- [ ] Fake Codex writes `.env`.
- [ ] Verify the run is blocked and no PR is opened.
- [ ] Fake Codex writes `.env.local`.
- [ ] Verify the run is blocked and no PR is opened.
- [ ] Fake Codex changes a path matched by `deny.additionalPathGlobs`.
- [ ] Verify the run is blocked and no PR is opened.
- [ ] Fake Codex reports a prohibited action such as push, PR creation, release,
      deploy, or issue mutation.
- [ ] Verify the run is blocked and the report names the prohibited action.
- [ ] Fake Codex exits non-zero.
- [ ] Verify the run is blocked and preserves useful diagnostics.
- [ ] Fake Codex writes no completion report.
- [ ] Verify the run is blocked before publication.
- [ ] Fake Codex writes invalid JSON completion report.
- [ ] Verify the run is blocked with a clear validation error.
- [ ] Fake Codex writes a schema-invalid completion report.
- [ ] Verify the run is blocked with the missing or invalid field named.

Expected result: unsafe or unverifiable work never gets pushed or opened as a PR.

## Quality review gates

- [ ] Runtime change without a test file is blocked when TDD requires test
      changes.
- [ ] Runtime change with tests but no red-green validation evidence is blocked.
- [ ] Runtime change with no code-review evidence is blocked.
- [ ] Runtime change touching at least three runtime files without cleanup-review
      evidence is blocked.
- [ ] Same change with test file, red-green evidence, code-review evidence, and
      cleanup-review evidence passes.
- [ ] Tests-only change does not require runtime review gates unnecessarily.
- [ ] Documentation-only change does not require runtime review gates.

Expected result: quality gates match configured policy and do not over-block
non-runtime changes.

## Visual proof gate

- [ ] Create a UI/visual smoke issue whose text matches the visual proof
      trigger patterns.
- [ ] Fake Codex changes a configured frontend path without screenshot artifact.
- [ ] Verify the run is blocked.
- [ ] Configure `reviewGates.visualProof.runnerValidationCommand` to create a
      smoke screenshot artifact under the issue proof directory.
- [ ] Rerun with visual validation evidence.
- [ ] Verify the PR and issue report include the screenshot artifact link.
- [ ] Verify the screenshot artifact file exists under
      `.codex-orchestrator/proofs/issue-<number>/`.
- [ ] Verify runner-owned visual proof environment variables are available to
      the command.
- [ ] Verify skipped browser or screenshot proof blocks when the skipped reason
      matches configured block patterns.

Expected result: visual work requires real proof, and runner-owned proof can
satisfy the gate.

## Promotion and clarification

- [ ] Fake Codex writes a scoped report with `status: needs-promotion`.
- [ ] Verify the runner does not open a PR.
- [ ] Verify the issue receives the blocked/review handoff expected for
      promotion.
- [ ] Verify the issue comment tells the maintainer to replace `agent:auto` with
      `agent:plan-auto` when parent orchestration is desired.
- [ ] Create or simulate an issue requiring clarification if supported by the
      current workflow.
- [ ] Verify clarification comments block the issue and status reports recovery
      state.
- [ ] Add a maintainer response and verify status/daemon can resume when the
      recovery path allows it.

Expected result: the runner stops instead of inventing scope for work that
should become planning or needs maintainer input.

## Plan-auto parent flow

- [ ] Create a `[live-smoke] plan-auto parent` issue labeled `agent:plan-auto`.
- [ ] Configure fake Codex planning output to create at least three child nodes:
      one independent child and two dependent children.
- [ ] Run daemon once.
- [ ] Verify parent is claimed with `agent:running`.
- [ ] Verify child issues are created or updated with `agent:child`.
- [ ] Verify each child body contains the autonomous child marker and
      `codex-orchestrator metadata`.
- [ ] Verify only marked child issues are considered part of the tree.
- [ ] Verify child execution follows dependency order.
- [ ] Verify `runner.maxParallelChildren` limits child wave concurrency.
- [ ] Verify each successful child gets a child review report.
- [ ] Verify final integration branch `codex/tree-<parent>` is pushed.
- [ ] Verify one draft integration PR is opened for the parent.
- [ ] Verify parent ends with `agent:review` and no `agent:running`.
- [ ] Verify the parent review report lists children, batches, validation, and
      final PR.

Expected result: parent planning, child issue management, child execution,
integration branch creation, and final draft PR all work through the daemon.

## Plan-auto blocking cases

- [ ] Planning Codex mutates files.
- [ ] Verify parent is blocked before child issues are created or updated.
- [ ] Planning Codex creates a commit.
- [ ] Verify parent is blocked before child issues are created or updated.
- [ ] Planning output has malformed graph.
- [ ] Verify parent is blocked with graph errors.
- [ ] Planning output tries to update an arbitrary existing issue that is not a
      marked autonomous child.
- [ ] Verify parent is blocked.
- [ ] Child execution fails validation.
- [ ] Verify parent and failed child are blocked without final integration PR.
- [ ] Child branches create a merge conflict.
- [ ] Verify merge conflict report names the child branch and available local
      commits.

Expected result: planning mode remains structured-output only, and tree
execution blocks before unsafe child or integration publication.

## Logs, idle timeout, and recovery

- [ ] Fake Codex emits stdout and stderr chunks during execution.
- [ ] Verify durable log file exists under runner state.
- [ ] Verify log contains lifecycle, stdout, stderr, and final result evidence.
- [ ] Fake Codex emits no output longer than `codex.idleTimeoutMs`.
- [ ] Verify the run fails on idle timeout, not only wall-clock timeout.
- [ ] Verify idle warning or timeout evidence appears in the log/report.
- [ ] Interrupt a daemon run after issue claim but before completion.
- [ ] Run `codex-orchestrator status --target .`.
- [ ] Verify recovery section reports the interrupted run.
- [ ] Verify failed/blocked worktree is preserved for inspection.
- [ ] Verify dirty preserved worktree is not deleted by daemon cleanup.

Expected result: long and failed runs are inspectable without relying on terminal
scrollback.

## Worktree cleanup

- [ ] Complete a successful smoke PR.
- [ ] Merge the smoke PR when it is safe to do so.
- [ ] Run `codex-orchestrator daemon --target . --once`.
- [ ] Verify the merged clean worktree is removed.
- [ ] Create a dirty worktree under the workspace root.
- [ ] Run daemon once.
- [ ] Verify dirty worktree is skipped and reported.
- [ ] Verify active-run worktrees are skipped.
- [ ] Verify worktrees outside `runner.workspaceRoot` are skipped.
- [ ] Disable `runner.worktreeCleanup.enabled`.
- [ ] Verify daemon performs no cleanup removals.

Expected result: cleanup is conservative and never deletes active, dirty,
blocked, or unrelated work.

## CLI comparison path

- [ ] For one scoped issue, run `codex-orchestrator run --target . --issue <n>`
      instead of daemon.
- [ ] Verify the result matches the daemon scoped success flow.
- [ ] For one plan-auto parent, run `codex-orchestrator run --target . --issue <n>`.
- [ ] Verify the result matches the daemon plan-auto flow.
- [ ] Verify invalid CLI arguments return usage errors for `setup`, `status`,
      `run`, and `daemon`.

Expected result: direct `run` and daemon share the same execution contracts.

## Public package surface

- [ ] Verify `codex-orchestrator --help` lists all supported commands.
- [ ] Verify `codex-orchestrator --version` matches `package.json`.
- [ ] Verify package exports can be imported by a minimal external Node project.
- [ ] Verify `codex-orchestrator/config/schema` export can be imported and
      validates a generated config.
- [ ] Verify `npm pack` contents include `dist/src`, `prompts`, `README.md`,
      and `LICENSE`.
- [ ] Verify no local-only test fixtures or smoke secrets are included in the
      package tarball.

Expected result: the published package contains the intended runnable and public
API surface.

## Real Codex scenario

- [ ] Create one small, reversible `[live-smoke] real Codex` issue labeled
      `agent:auto`.
- [ ] Use real `codex` command in config.
- [ ] Run daemon once.
- [ ] Verify Codex receives the correct issue prompt and project policy.
- [ ] Verify the runner still owns push, PR creation, labels, and comments.
- [ ] Verify review gates block or pass based on real evidence, not final-answer
      text alone.
- [ ] Close or clean up the smoke PR/issue after inspection.

Expected result: the whole product path works with real Codex, while fake-agent
scenarios cover deterministic negative and edge cases.

## Exit criteria

- [ ] All required deterministic scenarios pass.
- [ ] Every blocked scenario blocks before push/PR publication.
- [ ] Every success scenario creates exactly the expected branch, draft PR,
      issue labels, issue comments, logs, and local state.
- [ ] The visual proof scenario embeds a screenshot artifact in the PR body.
- [ ] Daemon pickup is proven for both scoped and plan-auto work.
- [ ] Direct `run` is proven equivalent for focused reruns.
- [ ] Recovery and cleanup behavior is observed after both successful and failed
      runs.
- [ ] The real Codex scenario passed as part of the default live smoke run.
- [ ] All smoke-created branches, issues, PRs, and worktrees are either recorded
      for inspection or cleaned up deliberately.
