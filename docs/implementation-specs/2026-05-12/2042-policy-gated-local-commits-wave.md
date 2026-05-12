---
title: "Policy-gated agent local commits for scoped and issue-tree runs"
created_at: "2026-05-12T20:42:40+03:00"
source_type: "wave"
source_plan: "None"
source_issues:
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/11"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/13"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/14"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/12"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_verdict: "Approved"
---

## 1. Execution Context
- **Goal:** Finish the #13/#14 wave after #12 by allowing implementation agents to create local commits only when repository config allows it, while the runner still owns validation, push, draft PRs, labels, comments, and child-branch merges.
- **Source Material:** GitHub parent #11, child issues #13 and #14 with comments, completed #12 spec `docs/implementation-specs/2026-05-12/2018-issue-12-full-session-change-set.md`, `AGENTS.md`, `package.json`, `src/git/worktree.ts`, `src/runner/scoped-auto-command.ts`, `src/runner/plan-auto-command.ts`, `src/runner/prompt.ts`, `src/config/schema.ts`, `src/setup/project-config.ts`, and relevant tests under `test/`.
- **Approved Scope:** Add explicit project config policy for agent local commits; make scoped and issue-tree child implementation runs allow local commits only under that policy; validate the full session change set from #12 before any runner-owned push, PR, child merge, label, or comment publication; include local commit evidence in PR bodies and issue reports when commits exist.
- **Out of Scope:** Sandcastle dependency; stream logging; idle timeout; reusable execution sessions; changing parent planning to allow repository mutation; agent-owned push, PR creation, GitHub issue mutation, merge, publish, deploy, or auto-merge; release publishing.
- **Simplest Viable Path:** Add a boolean policy at `runner.allowAgentLocalCommits` with default `false`; condition prompts and `HEAD` handling on that policy; reuse `GitWorktreeManager.collectSessionChangeSet({ worktreePath, baseHead })`; add small report-rendering helpers for commit evidence.
- **Primary Risk:** A local commit can otherwise bypass current no-change/safety checks or get published before the runner validates the full committed-plus-uncommitted session change set.

## 2. Preconditions And Evidence
- **Required Services / Env / Fixtures:** Node.js `>=18`; npm dependencies installed; `git` CLI available. Tests use temp git repositories, local bare remotes, fake Codex adapters, fake shell executors, and in-memory issue/PR adapters. No live GitHub or external credentials.
- **Blocking Unknowns:** None.
- **Confirmed Targets:** `src/git/worktree.ts` already provides `collectSessionChangeSet` with `changedPaths`, `commits`, and `hasChanges`; `src/runner/scoped-auto-command.ts` and `src/runner/plan-auto-command.ts` still call `validateNoAgentOwnedGitPublication` after implementation runs; `src/runner/plan-auto-command.ts` keeps parent planning mutation-free before child issue mutation; `src/runner/prompt.ts` still tells implementation agents not to commit; `src/config/schema.ts` and `src/setup/project-config.ts` own config validation/defaults; `test/scoped-auto-command.test.ts` and `test/plan-auto-command.test.ts` already use temp repos and fake adapters.
- **Confirmed Commands:**
  - `npm run build`
  - `npm run typecheck`
  - `npm test`
  - `npm run build && node --test dist/test/config-schema.test.js`
  - `npm run build && node --test dist/test/setup-command.test.js`
  - `npm run build && node --test dist/test/prompt-builder.test.js`
  - `npm run build && node --test dist/test/scoped-auto-command.test.js`
  - `npm run build && node --test dist/test/plan-auto-command.test.js`
- **Protected Paths / Rejected Approaches:** Do not read `.env` or `.env.*`; do not run `npm publish`; do not add Sandcastle; do not duplicate git diff/status collection outside `src/git/worktree.ts`; do not change parent planning to allow commits/files; do not let child agents push, open PRs, merge, publish, deploy, or mutate GitHub labels/comments.

## Risk Controls
- **Source of Truth:** `runner.allowAgentLocalCommits` in `src/config/schema.ts` is the policy source of truth. `src/git/worktree.ts` remains the source of truth for full session changed paths and commit metadata.
- **Safety Constraints:** Local commits are local implementation artifacts only. The runner remains the only path that may call `git.pushBranch`, create draft PRs, merge child branches into a parent branch, change labels, or post comments.
- **Contract Constraints:** Parent planning remains structured-output-only and must still block changed `HEAD` or working-tree files before any child issue mutation.
- **Concurrency / State Constraints:** Single downstream agent. Do not split #13 and #14 because scoped and tree-child flows share config policy, prompt wording, change-set validation, and commit evidence rendering.
- **Forbidden Scope:** No new execution backend, no broad run-session abstraction, no report schema changes required from child Codex, no squashing or rewriting agent commits.

| Behavior / Data | Owner | Readers / Projections | Non-Owners |
|-----------------|-------|-----------------------|------------|
| Local commit permission | `src/config/schema.ts` and generated defaults in `src/setup/project-config.ts` | scoped runner, tree-child runner, implementation prompts, tests | GitHub adapters, Codex adapter |
| Full session change set and commits | `src/git/worktree.ts` | safety checks, review gates, PR/report builders, merge conflict reporting | prompt builders |
| External publication | runner command flows after validation | git helper and GitHub adapters | Codex child sessions |

## Write Scope Summary
- `src/config/schema.ts` - Update; add `runner.allowAgentLocalCommits: boolean` to `CodexOrchestratorConfig` and validation.
- `src/setup/project-config.ts` - Update; default `runner.allowAgentLocalCommits` to `false` and preserve existing project policy during setup migration.
- `src/runner/scoped-auto-command.ts` - Update; condition implementation `HEAD` changes on policy, validate full change set before runner publication, avoid empty runner commit when agent commits leave a clean tree, and include commit evidence in reports/PRs.
- `src/runner/plan-auto-command.ts` - Update; same policy/change-set/commit-evidence behavior for tree-child runs, keep parent planning strict, and include commit evidence in merge conflict and review reports.
- `src/runner/prompt.ts` - Update; scoped and issue-tree child prompts allow local commits only when policy is enabled; planning prompt remains stricter.
- `src/git/worktree.ts` - Update only if needed for a small public helper or missing commit metadata required by reports; do not add another change-set collector.
- `src/index.ts` - Update only if new public types/helpers are intentionally exported.
- `test/config-schema.test.ts`, `test/setup-command.test.ts`, `test/prompt-builder.test.ts`, `test/scoped-auto-command.test.ts`, `test/plan-auto-command.test.ts` - Update with focused behavior tests.

## 3. Execution Slices

### Progress Discipline
- [ ] Update this checklist as work is completed.
- [ ] Leave blocked work unchecked with a short `Blocked:` note.
- [ ] Stop if repo reality contradicts a confirmed target, command, precondition, or scope boundary.
- [ ] Keep each implementation phase as a vertical tracer-bullet slice, not a horizontal layer pass.
- [ ] For behavior changes, start each slice with one behavior-first test/proof before implementation work.
- [ ] Use RED -> GREEN -> refactor per slice; do not batch all tests first.

### Slice 1 - Config Policy Defaults To No Agent Local Commits
- [ ] Objective: Local commits are impossible unless project config explicitly enables them.
- [ ] Test/Proof First: In `test/config-schema.test.ts`, add failing assertions that `validConfig.runner.allowAgentLocalCommits === false`, `validateConfig(validConfig).ok === true`, and a config with `runner.allowAgentLocalCommits: "yes"` is rejected with `runner.allowAgentLocalCommits must be a boolean`.
- [ ] Target: `src/config/schema.ts`
  - [ ] Action: Add `allowAgentLocalCommits: boolean` under `CodexOrchestratorConfig['runner']`.
  - [ ] Action: In runner validation, require `runner.allowAgentLocalCommits` as a boolean.
  - [ ] Validation: `npm run build && node --test dist/test/config-schema.test.js`.
- [ ] Test/Proof First: In `test/setup-command.test.ts`, extend `setup creates project config...` or `setup migrates existing config defaults...` to assert migrated/generated config includes `runner.allowAgentLocalCommits === false` and preserves an existing `true` value.
- [ ] Target: `src/setup/project-config.ts`
  - [ ] Action: Add default `runner.allowAgentLocalCommits: false`.
  - [ ] Action: Ensure `mergeExistingProjectConfig` preserves an existing top-level `runner.allowAgentLocalCommits` value through the existing runner merge.
  - [ ] Validation: `npm run build && node --test dist/test/setup-command.test.js`.
- [ ] Slice Exit Gate: Config validation and setup tests prove the policy is explicit, default-off, and project-owned.

### Slice 2 - Scoped Prompt And Default Policy Preserve Current Commit Ban
- [ ] Objective: Scoped agents see the correct publication contract for both policy states, and default policy still blocks agent commits.
- [ ] Test/Proof First: In `test/prompt-builder.test.ts`, add failing assertions for `buildScopedImplementationPrompt`:
  - with `runner.allowAgentLocalCommits === false`, prompt says local commits are not allowed and still forbids push, pull requests, merge, publish, deploy, and GitHub labels/comments;
  - with `runner.allowAgentLocalCommits === true`, prompt says local commits in the issue worktree are allowed and still forbids the same external actions.
- [ ] Target: `src/runner/prompt.ts`
  - [ ] Action: Make `buildScopedImplementationPrompt` branch on `input.config.runner.allowAgentLocalCommits`.
  - [ ] Action: Keep `buildPlanAutoPrompt` forbidding commits and repository/GitHub mutations.
  - [ ] Validation: `npm run build && node --test dist/test/prompt-builder.test.js`.
- [ ] Test/Proof First: In `test/scoped-auto-command.test.ts`, add a failing default-policy test where fake Codex creates a local commit and a valid report; assert result is `blocked`, PR count is `0`, and report contains `Codex changed git HEAD; runner-owned publication was violated`.
- [ ] Target: `src/runner/scoped-auto-command.ts`
  - [ ] Action: Preserve the existing `validateNoAgentOwnedGitPublication(beforeHead, afterHead)` block when `config.runner.allowAgentLocalCommits === false`.
  - [ ] Validation: `npm run build && node --test dist/test/scoped-auto-command.test.js`.
- [ ] Slice Exit Gate: Default installs still reject implementation-agent commits and no runner publication occurs.

### Slice 3 - Scoped Runs Publish Validated Agent Commits When Policy Allows
- [ ] Objective: A scoped agent can create local commits under policy, but runner validation still gates push, PR, labels, and comments.
- [ ] Test/Proof First: In `test/scoped-auto-command.test.ts`, add a failing test using a config override with `runner.allowAgentLocalCommits: true`; fake Codex creates and commits `committed-feature.txt`, writes a valid completion report with TDD/code-review evidence as needed, and exits `0`; assert result is `review-ready`, PR count is `1`, the remote branch exists only after runner completion, and PR body plus issue review comment include `committed-feature.txt` and a `Commits` section with the agent commit SHA/subject.
- [ ] Target: `src/runner/scoped-auto-command.ts`
  - [ ] Action: When policy is enabled, do not treat `beforeHead !== afterHead` as a violation for scoped implementation.
  - [ ] Action: Read `const changeSet = await git.collectSessionChangeSet({ worktreePath, baseHead: beforeHead })` after report validation and use `changeSet.changedPaths` for no-change, `validateChangedPaths`, configured checks, visual proof, review gates, PR body, and issue report.
  - [ ] Action: Pass `changeSet.commits` into scoped report/PR rendering. Render `Commits` lines as `- ${commit.sha.slice(0, 12)} ${commit.subject} (${commit.authorName}, ${commit.committedAt})`, or `- none` when empty.
  - [ ] Action: Before `git.commitAll`, call `git.isWorktreeClean(worktreePath)`. If clean and `changeSet.commits.length > 0`, skip the runner commit and push the existing branch. If not clean, keep the runner-owned `git.commitAll` for remaining uncommitted files.
  - [ ] Validation: `npm run build && node --test dist/test/scoped-auto-command.test.js`.
- [ ] Test/Proof First: Add a failing scoped test with policy enabled where fake Codex commits `.env.local` or `secrets/committed.txt`; assert result is `blocked`, PR count is `0`, and the blocked report includes the denied path plus commit evidence.
- [ ] Target: `src/runner/scoped-auto-command.ts`
  - [ ] Action: Ensure denied-path validation runs before configured checks, runner commit, push, PR creation, label review transition, and review comment publication.
- [ ] Test/Proof First: Add a failing scoped test with policy enabled where configured checks fail after an agent commit; assert no push/PR is created and the blocked report includes the failed validation plus commit evidence.
- [ ] Target: `src/runner/scoped-auto-command.ts`
  - [ ] Action: Keep configured checks and review gates before runner-owned push/PR publication.
- [ ] Slice Exit Gate: Scoped committed-only, denied committed path, and failed-check paths prove full change-set validation before publication.

### Slice 4 - Issue-Tree Child Prompt And Policy Preserve Parent Planning Strictness
- [ ] Objective: Tree-child prompts follow the same policy, while parent planning remains mutation-free.
- [ ] Test/Proof First: In `test/prompt-builder.test.ts`, add failing assertions for `buildIssueTreeChildPrompt` mirroring scoped prompt behavior for policy disabled/enabled, and assert `buildPlanAutoPrompt` still says planning must not create commits or repository mutations.
- [ ] Target: `src/runner/prompt.ts`
  - [ ] Action: Make `buildIssueTreeChildPrompt` branch on `input.config.runner.allowAgentLocalCommits`.
  - [ ] Action: Do not relax `buildPlanAutoPrompt`.
  - [ ] Validation: `npm run build && node --test dist/test/prompt-builder.test.js`.
- [ ] Test/Proof First: In `test/plan-auto-command.test.ts`, add or extend a plan-phase mutation test where plan Codex creates a local commit and a valid plan report; assert parent result is `blocked`, no child issues are created, and the report includes `Planning session changed git HEAD; planning must not commit.`
- [ ] Target: `src/runner/plan-auto-command.ts`
  - [ ] Action: Keep parent planning `beforeHead !== afterHead` and working-tree checks before reading/persisting child issues.
  - [ ] Validation: `npm run build && node --test dist/test/plan-auto-command.test.js`.
- [ ] Slice Exit Gate: Tree-child implementation prompts can allow commits by policy, but planning prompts and behavior remain strict.

### Slice 5 - Issue-Tree Children Integrate Validated Agent Commits
- [ ] Objective: Tree-child runs accept local commits under policy, validate the full change set, then merge only through the runner-owned parent branch flow.
- [ ] Test/Proof First: In `test/plan-auto-command.test.ts`, add a failing policy-enabled test where child fake Codex creates and commits `child-${input.issueNumber}.txt`, writes a valid scoped report, and exits `0`; assert parent result is `review-ready`, parent PR count is `1`, child review comment and parent PR body include changed file plus commit evidence, and the parent remote branch contains runner-owned merge commits.
- [ ] Target: `src/runner/plan-auto-command.ts`
  - [ ] Action: In `executeChild`, when `config.runner.allowAgentLocalCommits === true`, allow local `HEAD` changes and collect `changeSet` from the child `beforeHead`.
  - [ ] Action: Use `changeSet.changedPaths` for no-change, `validateChangedPaths`, configured checks, visual proof, review gates, `ChildExecutionResult.changedFiles`, child review reports, parent PR body, and parent review report.
  - [ ] Action: Add `commits: SessionCommitInfo[]` to `ChildExecutionResult` and render commit evidence in child review reports, parent PR body, and parent review report.
  - [ ] Action: Before child `git.commitAll`, call `input.git.isWorktreeClean(worktreePath)` and skip empty runner commit when the agent committed everything and the tree is clean.
  - [ ] Validation: `npm run build && node --test dist/test/plan-auto-command.test.js`.
- [ ] Test/Proof First: Add a failing policy-enabled child test where child Codex commits a denied path; assert parent result is `blocked`, no parent PR is created, no parent branch push occurs, child is marked blocked, and blocked comments include denied path plus commit evidence.
- [ ] Target: `src/runner/plan-auto-command.ts`
  - [ ] Action: Ensure child denied-path validation runs before `git.mergeBranch`, parent push, parent PR creation, and review label/comment publication.
- [ ] Test/Proof First: Add a failing default-policy child test where child Codex creates a local commit and a valid scoped report; assert parent result is `blocked`, no parent PR is created, and child/parent blocked evidence names the changed `HEAD` violation.
- [ ] Target: `src/runner/plan-auto-command.ts`
  - [ ] Action: Preserve `validateNoAgentOwnedGitPublication` for tree-child implementation when policy is disabled.
- [ ] Slice Exit Gate: Issue-tree children can only integrate local commits after policy, full change-set validation, checks, visual proof, and review gates pass.

### Slice 6 - Merge Conflict And Report Evidence Is Complete
- [ ] Objective: Review and blocked reports expose local commit evidence consistently enough for manual recovery.
- [ ] Test/Proof First: Extend `test/plan-auto-command.test.ts` merge conflict coverage so each conflicting child creates a local commit under policy; assert child blocked comments name child issue, child branch, preserved worktree, and a `Commits` section with each child commit subject/SHA.
- [ ] Target: `src/runner/plan-auto-command.ts`
  - [ ] Action: Update `handleMergeConflict`, `blockFailedBatch`, `buildChildReviewReport`, `buildIssueTreeReviewReport`, and `buildIssueTreePullRequestBody` to include commit evidence from `ChildExecutionResult`.
  - [ ] Action: Do not require agent-provided report fields for commits; use runner-collected `changeSet.commits`.
  - [ ] Validation: `npm run build && node --test dist/test/plan-auto-command.test.js`.
- [ ] Test/Proof First: Extend scoped blocked-path or failed-check tests to assert blocked scoped report includes commit evidence when a local commit exists.
- [ ] Target: `src/runner/scoped-auto-command.ts`
  - [ ] Action: Update `finishBlocked`, `buildReviewReport`, and `buildPullRequestBody` to render commit evidence. Early blocks that happen before a change set exists may render `Commits - none`.
  - [ ] Validation: `npm run build && node --test dist/test/scoped-auto-command.test.js`.
- [ ] Slice Exit Gate: Every post-Codex success or validation-block report path can show commit evidence; early pre-report failures still block safely with `none`.

### Slice 7 - Reconciliation And Public Surface
- [ ] Objective: Final behavior is cohesive, exported surface stays intentional, and no duplicate change-set logic appears.
- [ ] Test/Proof First: If implementation exports `SessionCommitInfo`/`SessionChangeSet` from `src/index.ts`, update `test/public-api.test.ts` to assert the deliberate export. If no new root export is needed, leave `src/index.ts` unchanged.
- [ ] Target: `src/index.ts`
  - [ ] Action: Export only intentional public types; do not export parser helpers.
  - [ ] Validation: `npm run build && node --test dist/test/public-api.test.js` only if changed.
- [ ] Target: `src/runner/scoped-auto-command.ts`, `src/runner/plan-auto-command.ts`, `src/runner/prompt.ts`
  - [ ] Action: `rg "must not commit|Do not commit|changed git HEAD|collectSessionChangeSet|listChangedFiles\\(" src/runner` and reconcile stale prompt text, policy-disabled violation text, and post-Codex changed-file collection.
  - [ ] Action: Ensure parent planning is the only plan-auto path where `beforeHead !== afterHead` always blocks regardless of policy.
  - [ ] Validation: run focused tests plus full validation below.
- [ ] Slice Exit Gate: No runner-local git parsing or stale unconditional commit ban remains in implementation modes.

## Acceptance Criteria Mapping
- **#13: Scoped run succeeds when fake agent creates local commit and valid report.** Slice 3 policy-enabled scoped test.
- **#13: Runner validates full session change set before push/PR.** Slice 3 denied-path and failed-check tests prove no PR/push before validation.
- **#13: Runner blocks push/PR when safety, configured checks, or review gates fail.** Slice 3 safety/check tests; existing review-gate tests continue to run against `changeSet.changedPaths`.
- **#13: Runner still forbids agent-owned push, PR creation, labels/comments, publish, deploy, merge.** Slices 2 and 3 preserve completion safety contract and runner-owned publication order.
- **#13: Review report and PR body expose commit evidence.** Slices 3 and 6.
- **#14: Tree-child run succeeds when fake child agent creates local commits and valid report.** Slice 5 policy-enabled tree-child test.
- **#14: Child branch validation uses full session change set before merge.** Slice 5 denied-path test blocks before `git.mergeBranch`.
- **#14: Merge conflict reports identify child issue, branch, and commit evidence.** Slice 6 conflict test.
- **#14: Child issue review comments include validation, artifacts, risks, and commit evidence.** Slices 5 and 6.
- **#14: Parent integration PR creation remains runner-owned.** Slice 5 asserts parent PR appears only after child validation and runner merge.
- **#11: Existing projects keep current behavior until opt-in.** Slices 1, 2, and 5 default-policy blocks.
- **#11: Full session change-set must be validated before publication.** Slices 3 and 5 consume `GitWorktreeManager.collectSessionChangeSet`.

## Halt Conditions
- [ ] Stop if `runner.allowAgentLocalCommits` cannot be added without making existing generated or migrated config validation deterministic.
- [ ] Stop if allowing local commits requires agents to push, create PRs, merge, publish, deploy, or mutate GitHub issues/labels/comments.
- [ ] Stop if any scoped or tree-child success path can push, create PRs, merge into parent, or post review comments before denied-path validation, configured checks, visual proof, and review gates evaluate the full `changeSet.changedPaths`.
- [ ] Stop if parent planning would allow commits/files under the new policy.
- [ ] Stop if implementation needs a second git diff/status collector outside `src/git/worktree.ts`.
- [ ] Stop if clean committed-only sessions still call `git.commitAll` and fail because there is nothing for the runner to commit.

## 4. Validation And Done Criteria
- [ ] **Lint/Format:** Not applicable; no lint script is defined in `package.json`.
- [ ] **Typecheck:** `npm run typecheck`
- [ ] **Build:** `npm run build`
- [ ] **Focused Tests:**
  - `npm run build && node --test dist/test/config-schema.test.js`
  - `npm run build && node --test dist/test/setup-command.test.js`
  - `npm run build && node --test dist/test/prompt-builder.test.js`
  - `npm run build && node --test dist/test/scoped-auto-command.test.js`
  - `npm run build && node --test dist/test/plan-auto-command.test.js`
- [ ] **Full Tests:** `npm test`
- [ ] **Architecture Check:** `rg "diff --name-only|status --porcelain" src/runner src/github src/codex src/process` must not show new git parsing outside `src/git/worktree.ts`; `rg "listChangedFiles\\(" src/runner` must not show post-Codex implementation changed-file collection for scoped or tree-child flows; `rg "pushBranch|createDraftPullRequest|mergeBranch|addLabels|removeLabels|postComment" src/runner` must show those external publication calls remain in runner flows, not prompts or Codex adapters.
- [ ] **Live/Manual Validation:** Not applicable.
- [ ] **Behavior Proof:** Tests demonstrate default-off policy, policy-enabled scoped commits, policy-enabled tree-child commits, denied committed paths, failed checks/review gates blocking publication, commit evidence in reports, merge conflict evidence, and strict parent planning.
- [ ] **Post-Implementation Hygiene:** Run `$cleanup-review` after implementation because this touches shared runtime flow across more than three runtime files.
- [ ] **Final Code Review:** Run `$code-review` after cleanup and relevant validation pass.
- [ ] **Final Reconciliation:** all unchecked work is unfinished, blocked with a note, or intentionally not applicable.

## Defect Closure Notes
- [ ] `implementation-spec-review` verdict: Approved. No blocking defects after adding explicit default-off policy, empty-runner-commit handling, and report evidence requirements.

## 5. Final Action
After saving the file, respond in chat with exactly:

Spec Status: Ready
Saved Path: docs/implementation-specs/2026-05-12/2042-policy-gated-local-commits-wave.md
Execution Model: Single-Agent
Review Verdict: Approved
Validation Gates: Local / Tests
Blockers: None
