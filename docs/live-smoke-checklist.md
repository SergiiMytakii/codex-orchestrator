# Live smoke checklist

This checklist verifies `codex-orchestrator` against a dedicated scratch GitHub
repository by default: `SergiiMytakii/codex-orchestrator-live-smoke`. It is
intentionally broader than issue #11: the goal is to prove the full package flow
through the packaged CLI, real GitHub Issues, real labels, real daemon polling,
real branches, real draft PRs, local runner state, worktrees, logs, review
gates, and cleanup behavior without polluting the source repository.

The default `npm run smoke:live` run uses the `core-release` profile. It
packages the current code with `npm pack`, runs the packaged CLI, creates real
GitHub Issues, and verifies the runner-owned GitHub handoff in the scratch
repository. Cleanup is on by default and uses delete mode for smoke-created
issues. PR records cannot be physically deleted by GitHub, so cleanup closes
them and deletes their remote branches, then verifies no live smoke issues, open
PRs, or remote branches remain for the run.

Run broader profile sets when release or policy work needs them:

```sh
npm run smoke:live -- --profile core-release
npm run smoke:live -- --profile extended-policy
npm run smoke:live -- --profile proof-matrix
npm run smoke:live -- --profile full
```

Use this selection guide when an agent needs live smoke after implementing a
change:

| Change type | Command | Why |
| --- | --- | --- |
| Ordinary release gate, scoped runner behavior, diagnostics, quality gates, safety gates, browser proof, plan-auto happy path, or real-Codex handoff | `npm run smoke:live -- --profile core-release` | Covers the main publish path without running every edge matrix. |
| Loop policy, priority selection, bounded rework, Fresh-Context Review, remote base branch resolution, Acceptance Proof rework/negative cases, or plan-auto blocking behavior | `npm run smoke:live -- --profile extended-policy` | Exercises policy and blocking edge cases that are intentionally outside the default profile. |
| Browser proof, Acceptance Proof, UI Evidence, proof rework, proof product-diff blocking, low-confidence proof, or viewport/UI Evidence validation | `npm run smoke:live -- --profile proof-matrix` | Focuses on proof contracts without unrelated daemon and package scenarios. |
| Scenario selection/profile behavior, release-signoff after policy/proof/publication changes, or uncertainty about which profile is sufficient | `npm run smoke:live -- --profile full` | Runs every top-level live smoke scenario. |
| One known contract while developing or debugging a failure | `npm run smoke:live -- --scenario <name>` | Keeps feedback focused; `--scenario` overrides profile selection. |

If multiple rows apply, use the broader matching profile. If no row applies, use
`core-release`. Do not use `full` as the default after every implementation; it
is the expensive release-signoff and broad-regression profile.
The focused `plan-auto-tree-recovery` scenario mutates the scratch GitHub
repository and should be run only after explicit approval.

Run focused subsets while developing:

```sh
npm run smoke:live -- --scenario package-install
npm run smoke:live -- --scenario discovery-matrix
npm run smoke:live -- --scenario quality-gates
npm run smoke:live -- --scenario browser-proof
npm run smoke:live -- --scenario acceptance-proof-positive
npm run smoke:live -- --scenario acceptance-proof-negative
npm run smoke:live -- --scenario diagnostics
npm run smoke:live -- --scenario incomplete-progress-rework
npm run smoke:live -- --scenario risk-routing
npm run smoke:live -- --scenario plan-auto-blocking
npm run smoke:live -- --scenario tree-child-quality-rework --cleanup
npm run smoke:live -- --scenario plan-auto-tree-recovery --cleanup
```

Run the full live smoke matrix before a release when policy/proof coverage
changed:

```sh
npm run smoke:live -- --profile full
```

Use `--keep-artifacts` only when a failed run needs manual GitHub inspection.
Use `--cleanup-mode close` only when issue deletion would remove evidence needed
for a temporary investigation. Use `--repo <owner/name>` only for an intentional
alternate scratch repository; do not point routine smoke runs at the source repo.

## Automated scenario map

- `baseline` - packaged CLI help/version/health/setup/status and package files.
- `package-install` - installs the packed package into an external Node project,
  imports the root and `config/schema` exports, and runs the installed bin.
- `discovery-matrix` - verifies skipped issue states for manual, conflicting
  authorization, running, blocked, and review labels.
- `real-codex` - runs one docs-only scoped issue through the real Codex command.
- `remote-base-branch` - verifies scoped PRs target and build from an explicit
  remote base branch.
- `scoped-runner-commit` - daemon scoped success with runner-owned commit.
- `commit-policy` - daemon scoped success with accepted agent local commit and
  blocked publication when local commits are disallowed.
- `run-scoped` - direct `codex-orchestrator run --issue` scoped success.
- `loop-policy` - priority-based daemon selection, bounded rework evidence,
  optional Fresh-Context Review evidence, Durable Run Summary excerpts, and
  non-mutating Policy Suggestions.
- `incomplete-progress-rework` - exact idle timeout after safe local progress
  without a completion report becomes bounded scoped rework from the existing
  worktree, then publishes after the rework attempt writes a valid report.
- `diagnostics` - packaged CLI proof for `doctor`, `status --json`,
  phase-specific profile selection, lifecycle event evidence, and context
  snapshot artifact references.
- `browser-proof` - fake agent prepares a proof-owned browser scenario, then
  packaged `visual-proof auto` dispatches to browser proof and writes screenshot,
  DOM, console, network, run-summary, and UI Evidence artifacts. The package
  first reuses an existing local browser executable or Playwright browser cache;
  Chromium download is only a fallback when no installed browser can launch.
- `acceptance-proof-positive` - canonical machine-readable Acceptance Proof and
  UI Evidence Contract reports are validated and attached to PRs.
- `acceptance-proof-rework` - failed Acceptance Proof requests implementation
  rework and then passes within the proof loop.
- `acceptance-proof-negative` - low-confidence proof, proof-phase product diffs,
  missing UI Evidence, and invalid desktop viewport coverage block Draft PR
  Handoff.
- `quality-gates` - blocks missing TDD, missing code-review, and missing
  cleanup-review evidence before publication.
- `risk-routing` - parent `plan-auto` warn mode renders declared risk-routing
  metadata findings in the parent PR body and review report while continuing
  child execution.
- `safety-negative` - blocks a configured denied path and invalid scoped
  completion JSON before publication.
- `plan-auto` - daemon parent planning, child waves, integration branch, draft PR.
- `run-plan-auto` - direct `codex-orchestrator run --issue` plan-auto success.
- `plan-auto-blocking` - blocks malformed graph, planning file mutation, and
  arbitrary existing issue updates before integration publication.
- `tree-child-quality-rework` - proves bounded rework for a plan-auto child
  quality-gate failure and focused child validation behavior.
- `plan-auto-tree-recovery` - focused proof for parent tree recovery, recovered
  child evidence, and retryable child rework resume in the scratch repository.

## Smoke contract

- [ ] Run against `SergiiMytakii/codex-orchestrator-live-smoke` by default, not
      the source repository.
- [ ] Run the packaged CLI from `npm pack`, not TypeScript source files.
- [ ] Use real GitHub Issues and real labels through `gh`.
- [ ] Use `codex-orchestrator daemon --once` for the primary pickup path.
- [ ] Prove direct `codex-orchestrator run --issue` equivalence through
      `run-scoped` and `run-plan-auto`.
- [ ] Keep all smoke-created issues and PRs clearly named with
      `[live-smoke:<runId>]`.
- [ ] Do not merge smoke PRs unless the scenario explicitly checks cleanup after
      a merged PR.
- [ ] Record every created issue number, branch, PR URL, log path, and worktree
      path in the smoke notes, then verify cleanup removed or closed the GitHub
      artifacts for the run.
- [ ] Use real Codex as a required scenario in the default live smoke run.
- [ ] Use a deterministic fake Codex command only for runner contract checks
      that would otherwise be flaky or destructive to force through an LLM.

## Baseline setup

- [ ] Confirm working tree is clean enough for smoke changes:
      `git status --short`.
- [ ] Confirm GitHub CLI is authenticated and the scratch repo exists:
      `gh repo view SergiiMytakii/codex-orchestrator-live-smoke --json owner,name`.
- [ ] Build and package:
      `npm test`, `npm pack`.
- [ ] Install or invoke the generated tarball so `codex-orchestrator --version`
      reports the tarball version.
- [ ] Run `codex-orchestrator health`.
- [ ] Run `codex-orchestrator setup --target . --dry-run`.
- [ ] Run `codex-orchestrator setup --target . --prepare-labels`.
- [ ] Verify `.codex-orchestrator/config.json` exists and validates through
      `codex-orchestrator status --target . --dry-run`.
- [ ] Verify `codex-orchestrator doctor --target . --json` reports readiness
      without launching Codex or mutating GitHub.
- [ ] Verify `codex-orchestrator status --target . --json` returns repo,
      target, eligible, skipped, recovery, active runs, and recent events.
- [ ] Verify required labels exist in GitHub: `agent:auto`,
      `agent:plan-auto`, `agent:child`, `agent:running`, `agent:blocked`,
      `agent:manual`, and `agent:review`.

Expected result: setup can infer or use this repository, labels exist, status
can read GitHub, and no Codex execution starts during setup or status.

## Diagnostics proof

- [ ] `diagnostics` configures a scoped phase profile whose global Codex command
      would fail if the runner did not select the profile.
- [ ] Run one scoped issue through the packaged CLI path.
- [ ] Verify lifecycle events are written under runner state.
- [ ] Verify `status --json` exposes recent events newest-first.
- [ ] Verify recent events include a `snapshot` artifact path.
- [ ] Verify the snapshot file exists and remains bounded evidence rather than
      a raw Codex transcript or full issue comment dump.
- [ ] Verify `doctor --json` reports pass/warn/fail arrays without creating
      worktrees, launching Codex, editing labels, or changing issues.

Expected result: operator diagnostics can explain readiness and the latest run
from structured runner-owned artifacts.

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

- [ ] `baseline` runs `status --dry-run` with no eligible smoke issue.
- [ ] `discovery-matrix` verifies `agent:manual` is skipped as manual.
- [ ] `discovery-matrix` verifies `agent:auto` plus `agent:plan-auto` is skipped
      as conflicting authorization.
- [ ] `discovery-matrix` verifies `agent:running`, `agent:blocked`, and
      `agent:review` are skipped with deterministic reasons.
- [ ] Success scenarios verify daemon logs `running #<issue> scoped-issue` or
      `running #<issue> plan-parent`.
- [ ] Loop Policy scenarios verify daemon logs the selected priority label or
      `unprioritized` plus the configured tie-breaker.
- [ ] Manual/deeper: verify a totally unlabeled issue stays invisible to daemon
      discovery, because status queries only configured discovery labels.

Expected result: daemon discovers exactly one eligible issue and skips all
blocked states deterministically.

## Loop Policy live proof

- [ ] `loop-policy` creates two eligible scoped issues and verifies the daemon
      selects the issue with the configured priority label before the lower
      priority issue, even when the lower priority issue has the smaller number.
- [ ] `loop-policy` verifies daemon output records the selected priority label
      and the `issue-number-asc` tie-breaker.
- [ ] `loop-policy` exercises one bounded Rework Loop attempt by first producing
      a retryable no-change blocker, then completing on the configured final
      attempt.
- [ ] `loop-policy` enables Fresh-Context Review and verifies the generated PR
      and issue report include Fresh-Context Review evidence before handoff.
- [ ] `loop-policy` verifies Durable Run Summary excerpts and non-mutating
      Policy Suggestions appear in generated PR/report evidence.
- [ ] `loop-policy` runs a parent issue-tree after the scoped proof to verify
      child waves still complete with child loop outcomes under the same Loop
      Policy settings.
- [ ] `loop-policy` verifies the Runner-Owned Publication Boundary by checking
      the result remains draft-PR based, with no auto-merge and no agent-owned
      GitHub publication.

Expected result: Loop Policy behavior is proven in a controlled self-repo live
scenario without handing publication authority to Codex.

## Risk Routing live proof

- [ ] `risk-routing` creates a parent `agent:plan-auto` issue whose fake
      planning report intentionally omits `sizeRisk` and `parentReviewHandoff`.
- [ ] Verify warn mode does not stop child issue creation, child execution, the
      integration branch, or the draft PR.
- [ ] Verify the parent PR body and parent review report include the exact
      `Risk routing warnings` heading.
- [ ] Verify the warning text names missing parent `sizeRisk` and
      `parentReviewHandoff` metadata.

Expected result: declared parent risk-routing metadata findings are visible in
handoff surfaces without weakening existing child execution or publication
checks in warn mode.

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
- [ ] Verify Durable Run Summary evidence appears in the PR body and issue
      report, and that Policy Suggestions are marked as non-mutating when
      present.
- [ ] When Fresh-Context Review is enabled for the scenario, verify advisory
      findings are reported before handoff and do not give the review session
      GitHub publication authority.
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

- [ ] `quality-gates` blocks runtime changes with tests but no red-green
      validation evidence.
- [ ] `quality-gates` blocks runtime changes with TDD evidence but no
      code-review evidence.
- [ ] `quality-gates` blocks medium runtime changes with TDD and code-review
      evidence but no cleanup-review evidence.
- [ ] Existing success scenarios prove a runtime change with test, TDD evidence,
      and code-review evidence can pass.
- [ ] Manual/deeper: runtime change with no test file.
- [ ] Manual/deeper: tests-only and docs-only exemptions, beyond the real Codex
      docs-only smoke.

Expected result: quality gates match configured policy and do not over-block
non-runtime changes.

## Acceptance proof gate

- [ ] Create a UI/visual smoke issue whose text matches the acceptance proof
      trigger patterns.
- [ ] Fake Codex changes a configured frontend path without proof artifacts.
- [ ] Verify the run is blocked on missing acceptance proof before Draft PR
      Handoff.
- [ ] Configure `reviewGates.acceptanceProof.runnerValidationCommand` to create
      a machine-readable proof report under the issue proof directory.
- [ ] Rerun with canonical acceptance validation evidence.
- [ ] Verify the PR and issue report include the smoke-output artifact link.
- [ ] `acceptance-proof-positive` verifies screenshot proof includes
      `uiEvidence.workflowScope`, `viewportCoverage`, `artifactFreshness`,
      `layoutReview`, `copyReview`, and `sourceInputs`.
- [ ] Verify UI Evidence screenshot artifacts are linked from the PR body and
      exist under `.codex-orchestrator/proofs/issue-<number>/`.
- [ ] Verify the proof artifact file exists under
      `.codex-orchestrator/proofs/issue-<number>/`.
- [ ] Verify runner-owned visual proof environment variables are available to
      the command.
- [ ] `browser-proof` verifies a web/frontend change can prepare a browser proof
      scenario and pass through packaged `visual-proof auto`.
- [ ] Verify browser proof screenshot, DOM snapshot, console log, network log,
      and run summary artifacts are linked from the PR body and exist under the
      issue proof directory.
- [ ] Verify failed browser, screenshot, or smoke proof blocks publication with
      preserved artifacts.
- [ ] `acceptance-proof-negative` verifies screenshot proof without
      `uiEvidence` blocks publication.
- [ ] `acceptance-proof-negative` verifies desktop UI proof with a
      too-narrow viewport blocks publication.
- [ ] Verify low-confidence proof reports block publication instead of becoming
      Draft PR Handoff.
- [ ] Verify product-code changes created during proof block publication even
      when the proof report itself claims success.
- [ ] Verify a proof rework request keeps the issue in the runner-owned loop and
      can pass after implementation rework.

Expected result: acceptance proof is runner-owned when configured, missing proof
blocks handoff, and legacy visual proof artifacts remain attached when present.

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

- [ ] `plan-auto-blocking` verifies planning file mutation blocks the parent.
- [ ] `plan-auto-blocking` verifies malformed graph output blocks the parent.
- [ ] `plan-auto-blocking` verifies an arbitrary existing issue update is
      rejected before integration publication.
- [ ] `plan-auto-blocking` verifies no draft PR or remote integration branch is
      published for those blocked parents.
- [ ] Manual/deeper: planning Codex creates a commit.
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

- [ ] `run-scoped` runs `codex-orchestrator run --target . --issue <n>` for a
      scoped issue and verifies the same branch, draft PR, labels, report, log,
      and state cleanup expected from daemon success.
- [ ] `run-plan-auto` runs `codex-orchestrator run --target . --issue <n>` for a
      plan-auto parent and verifies the same parent/child/integration handoff
      expected from daemon success.
- [ ] Verify invalid CLI arguments return usage errors for `setup`, `status`,
      `run`, and `daemon`.

Expected result: direct `run` and daemon share the same execution contracts.

## Public package surface

- [ ] `baseline` verifies `codex-orchestrator --help`, `--version`, and `health`
      through the packaged CLI.
- [ ] `baseline` verifies `npm pack` contents include `dist/src`, `prompts`,
      `README.md`, and `LICENSE`.
- [ ] `package-install` verifies package exports can be imported by a minimal
      external Node project.
- [ ] `package-install` verifies `codex-orchestrator/config/schema` can be
      imported by that external project.
- [ ] `package-install` verifies the installed package bin reports the packaged
      version.
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

- [ ] The default `npm run smoke:live -- --cleanup` `core-release` profile
      passes.
- [ ] The full `npm run smoke:live -- --profile full --cleanup` matrix passes
      before releases that change policy, proof, or publication behavior.
- [ ] Every blocked scenario blocks before push/PR publication.
- [ ] Every success scenario creates exactly the expected branch, draft PR,
      issue labels, issue comments, logs, and local state.
- [ ] Browser and Acceptance Proof scenarios attach screenshot, DOM, run-summary,
      smoke-output, and UI Evidence artifacts where expected.
- [ ] Daemon pickup is proven for both scoped and plan-auto work.
- [ ] Direct `run` is proven equivalent for focused reruns.
- [ ] Recovery and merged-worktree cleanup behavior is observed separately when
      that area changes.
- [ ] The real Codex scenario passed as part of the default live smoke run.
- [ ] All smoke-created branches, issues, PRs, and worktrees are either recorded
      for inspection or cleaned up deliberately.
