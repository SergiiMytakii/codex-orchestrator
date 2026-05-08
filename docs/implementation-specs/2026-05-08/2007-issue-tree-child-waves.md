---
title: "Execute autonomous issue-tree child waves with isolated worktrees"
created_at: "2026-05-08T20:07:50+03:00"
source_type: "issue"
source_plan: "None"
source_issues:
  - "https://github.com/SergiiMytakii/IntelleReach/issues/151"
  - "https://github.com/SergiiMytakii/IntelleReach/issues/157"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_verdict: "Approved"
---

### 1. Execution Context
- **Goal:** Implement the execution half of `agent:plan-auto`: execute only marked autonomous child issues in dependency-safe batches, isolate each child in its own temporary worktree, merge successful child commits into one parent integration branch, and open one integration draft PR.
- **Source Material:** Parent PRD #151, child issue #157, #157 owner comment, merged prerequisites PR #4 (`agent:auto` scoped execution) and PR #5 (`agent:plan-auto` parent planning and child marking), current `/Users/serhiimytakii/Projects/codex-orchestrator`.
- **Approved Scope:** Parent tree execution after planning; child graph reconstruction from runner-owned child metadata; max 3 parallel child runs; exact ownership-scope batch separation; child worktree branch/commit flow; merge into parent integration branch; conflict block report; one draft PR with parent and child links plus consolidated validation.
- **Out of Scope:** Auto-merge, npm publish, hosted runner infrastructure, live autonomous polling, production deploy/release, destructive database/cache actions, secret file reads/changes, non-GitHub trackers, separate public PRs per child issue, heuristic merge conflict resolution.
- **Simplest Viable Path:** Extend the existing `runPlanAutoCommand` path so `agent:plan-auto` becomes planning plus execution. Reuse `GitHubIssueAdapter`, `GitHubPullRequestAdapter`, `GitWorktreeManager`, `CodexCommandAdapter`, `RunnerStateStore`, existing safety checks, and the scoped completion report schema instead of creating a second publication system.
- **Primary Risk:** The runner could accidentally execute unrelated issues or merge unsafe child work. The only source of truth for child membership remains `agent:child` plus exact marker `<!-- codex-orchestrator:autonomous-child parent=#<parentIssueNumber> -->`; every other link or reference is non-authoritative.

### 2. Preconditions & Evidence
- **Required Services / Env / Fixtures:** Node.js `>=18`; npm dependencies installed; `git` CLI available; local `gh` credentials only for real adapter usage; automated tests must use temp git repositories, local bare remotes, in-memory GitHub adapters, fake PR adapters, and fake Codex adapters.
- **Blocking Unknowns:** None.
- **Confirmed Targets:**
  - CLI dispatch for `run --target <path> --issue <number>`: `src/cli.ts`.
  - Parent planning runner: `src/runner/plan-auto-command.ts`.
  - Current child marker and graph validation owner: `src/runner/issue-tree.ts`.
  - Prompt/report owners: `src/runner/prompt.ts`.
  - Existing issue state owner: `src/runner/issue-state-machine.ts`.
  - Existing safety owner: `src/runner/safety.ts`.
  - Local process metadata owner: `src/runner/local-state.ts`.
  - Git worktree helper: `src/git/worktree.ts`.
  - GitHub issue and PR adapters/fakes: `src/github/issues.ts`, `src/github/pull-requests.ts`, `src/github/gh-issue-adapter.ts`, `src/github/gh-pull-request-adapter.ts`.
  - Config defaults and limits: `src/config/schema.ts`, `src/setup/project-config.ts`; `runner.maxParallelChildren` is already validated as integer `1..3`.
  - Package-owned issue-tree prompt fallback: `prompts/workflows/issue-tree-orchestration.md`.
  - Current test style: `node:test` under `test/`; `npm test` builds then runs `dist/test/**/*.test.js`.
- **Confirmed Existing Contracts:** Before this issue, `runScopedAutoCommand` already proved runner-owned worktree, prompt/report, safety, commit, push, draft PR, and issue review handoff for one issue. `runPlanAutoCommand` proved parent planning, marked child create/update, and graph validation, but explicitly reported child wave execution as out of scope.
- **Protected Paths / Rejected Approaches:** Do not read `.env*` or configured secret globs. Do not execute children lacking both exact marker and `agent:child`. Do not infer membership from links, milestones, projects, comments, parent text, or `agent:auto` alone. Do not let Codex commit, push, merge, open PRs, edit labels/comments, publish, deploy, or resolve conflicts.

### Risk Controls
- **Source of Truth:** Child membership and child metadata are owned by `src/runner/issue-tree.ts`; GitHub labels/body are the durable public state; local runner state stores only process metadata. Dependency/cycle/spec-gate validation and execution batching are separate concerns: structural graph validation must not reject independent ready children only because their ownership scopes overlap; the scheduler serializes those children into later batches.
- **Safety Constraints:** Codex sessions change files only. The runner blocks on missing/malformed reports, Codex-owned `HEAD` changes, prohibited actions, configured secret/denied path changes, missing file changes, ineligible child state, and merge conflicts.
- **Contract Constraints:** The child implementation prompt must use `config.workflows.issueTreeOrchestration.promptPath`; child completion uses the existing `ScopedCompletionReport` schema and safety validators. GitHub mutations and PR creation go through fakeable adapters.
- **Concurrency / State Constraints:** Runtime child execution may run at most `min(config.runner.maxParallelChildren, 3)` children concurrently. Same batch children must have no exact trimmed `ownershipScope` intersection. Child branches start from the current parent integration branch at batch start and are merged back sequentially after the batch finishes.
- **Forbidden Scope:** No child PRs, no auto-merge, no npm publish, no live-only tests, no direct `gh` calls outside adapters, no conflict auto-resolution, no best-effort execution of manual/HITL/blocked/review/running/closed children.

| Behavior / Data | Owner | Readers / Projections | Non-Owners |
|-----------------|-------|-----------------------|------------|
| Autonomous child membership | `src/runner/issue-tree.ts` marker helpers | parent planner, tree executor, tests | links, milestones, projects, comments |
| Child execution metadata | runner-owned metadata section in child issue body parsed by `src/runner/issue-tree.ts` | scheduler, prompt builder, PR report | parent issue comments |
| Child publication | `GitWorktreeManager` plus `GitHubPullRequestAdapter` | issue reports, draft PR body, tests | Codex session |
| Child safety decision | `src/runner/safety.ts` plus tree runner checks | tree executor, blocked comments | prompt text alone |
| Final review state | GitHub labels/comments through adapters | status/recovery output, maintainers | local state file |

### Write Scope Summary
- `src/runner/issue-tree.ts` - Add durable child metadata parsing, child graph reconstruction, executable-state classification, and batch scheduling helpers.
- `src/runner/plan-auto-command.ts` - Change `agent:plan-auto` from planning-only to planning plus child wave execution and final integration PR handoff.
- `src/runner/prompt.ts` - Add issue-tree child implementation prompt builder while reusing `ScopedCompletionReport` validation.
- `src/git/worktree.ts` - Add branch merge, merge abort, and temporary worktree removal helpers.
- `src/runner/local-state.ts` and `src/runner/recovery.ts` - Add runner mode `tree-child` plus optional `parentIssueNumber` metadata for active child runs under a parent.
- `src/cli.ts` - Keep the same public `run` command but update output/help to describe full `agent:plan-auto` execution.
- `src/index.ts` - Update the exported `PlanAutoCommandResult` contract for final tree statuses; do not export scheduler/parser internals in this issue.
- `README.md` - Document full parent tree execution, explicit marker gate, child worktrees, one integration draft PR, and block conditions.
- `test/**` - Add focused unit and temp-git integration tests for metadata parsing, scheduling, isolated child worktrees, merges, conflict blocking, final PR creation, and CLI routing.

### 3. Execution Phases

#### Progress Discipline
- [x] Update this checklist as work is completed.
- [ ] Leave blocked work unchecked with a short `Blocked:` note.
- [ ] Stop if repo reality contradicts a confirmed target, command, precondition, or scope boundary.
- [ ] Stop if implementation requires auto-merge, npm publish, live-only validation, direct Codex GitHub mutation, child PRs, conflict auto-resolution, secret file reads, destructive database/cache actions, or production deploy/release.

#### Phase 1 - Child Metadata and Scheduling Source of Truth
- [ ] Objective: Make a planned autonomous tree executable from durable child issues without trusting arbitrary links or parent comments.
- [x] Target: `src/runner/issue-tree.ts`
  - [x] Action: Add `AutonomousChildMetadata { stableId: string; afkHitl: 'afk' | 'hitl'; dependsOn: string[]; ownershipScope: string[]; verification: string[] }`.
  - [x] Action: Add `AutonomousChildNode { issue: GitHubIssue; metadata: AutonomousChildMetadata }`.
  - [x] Action: Add `parseAutonomousChildMetadata(issue, config, parentIssueNumber): { ok: true; node: AutonomousChildNode } | { ok: false; errors: string[] }`.
  - [x] Rule: Parsing first requires `isAutonomousChildOfParent(issue, config, parentIssueNumber)`. If false, return an error and never classify the issue as part of the tree.
  - [x] Rule: Parse only the runner-owned `## codex-orchestrator metadata` section. Required fields are `Stable ID: <id>`, `AFK/HITL: afk|hitl`, `Depends on: <stableIds or none>`, `Ownership:` bullet list, `Spec gate: wave-level`, and `Verification:` bullet list.
  - [x] Rule: Reject empty stable id, duplicate stable ids, missing ownership, missing verification, wrong spec gate, unknown dependencies, self-dependencies, and cycles. Do not reject same-wave ownership overlap during structural parsing; overlapping ready nodes are valid tree members and must be serialized by the scheduler.
  - [x] Action: Refactor `validatePlanGraph` or add a new structural validator so planning can still reject same-wave ownership overlap when needed, while execution can validate ids/dependencies/cycles/spec gate without blocking serializable ownership overlap. Tests must cover both behaviors.
  - [x] Action: Add `collectExecutableChildBatches(nodes, config): { ok: true; batches: AutonomousChildNode[][] } | { ok: false; errors: string[] }`.
  - [x] Rule: A child is executable only when it is `OPEN`, has `agent:auto`, has `agent:child`, has exact parent marker, has parsed `AFK/HITL: afk`, and lacks `agent:manual`, `agent:blocked`, `agent:running`, and `agent:review`.
  - [x] Rule: `hitl`, manual, blocked, running, review, closed, missing-auto, and malformed children are not started. If such a child is in the autonomous tree, return `ok: false` with issue number and reason so the parent tree blocks clearly.
  - [x] Rule: Batches must respect dependencies. A node can enter a batch only after all dependency stable ids completed in prior batches.
  - [x] Rule: Each batch size is at most `Math.min(config.runner.maxParallelChildren, 3)`.
  - [x] Rule: Same batch nodes must have no exact trimmed `ownershipScope` intersection. If more ready nodes exist than can safely fit, schedule leftovers into later batches without marking the graph invalid.
  - [x] Validation: `test/issue-tree.test.ts` proves metadata parse success, missing stable id failure, duplicate stable id failure, malformed metadata failure, exact marker plus child label requirement, hitl/manual/blocked/running/review/closed children rejected for execution, dependency order, max 3 batch size, and overlapping ownership scopes never appear in the same batch.
- [x] Target: `src/runner/plan-auto-command.ts`
  - [x] Action: Update the existing child body builder so new child issues include `Stable ID: <node.stableId>` in the `## codex-orchestrator metadata` section.
  - [x] Rule: Existing children without `Stable ID` must block execution with a clear metadata error rather than guessing from title, issue number, or report comment.
  - [x] Validation: Existing plan-auto tests are updated to assert `Stable ID` is persisted for new and updated children.

#### Phase Exit Gate
- [ ] `npm run typecheck` and `npm test` pass after Phase 1.

#### Phase 2 - Git Worktree Merge Primitives
- [ ] Objective: Give the runner safe primitives for child branches, sequential integration merges, conflict reporting, and successful child worktree cleanup.
- [ ] Target: `src/git/worktree.ts`
  - [ ] Action: Add `mergeBranch({ worktreePath, branchName, message }): Promise<void>` that runs `git -C <worktreePath> merge --no-ff <branchName> -m <message>`.
  - [ ] Action: Add `abortMerge(worktreePath): Promise<void>` that runs `git -C <worktreePath> merge --abort`.
  - [ ] Action: Add `removeWorktree({ targetRoot, worktreePath }): Promise<void>` that runs `git -C <targetRoot> worktree remove <worktreePath>`.
  - [ ] Action: Add a typed `GitMergeConflictError` containing `worktreePath`, `branchName`, `stdout`, and `stderr` when `mergeBranch` exits non-zero.
  - [ ] Rule: `mergeBranch` must throw `GitMergeConflictError` for non-zero merge exits and must not auto-resolve or stage conflict files.
  - [ ] Rule: The tree executor catches `GitMergeConflictError`, calls `abortMerge`, and blocks the parent with the branch/worktree/error details. If `abortMerge` also fails, include that failure in the blocked report and stop.
  - [ ] Rule: `removeWorktree` runs only for child worktrees that were committed and merged successfully. Keep failed/conflicted child worktrees for maintainer inspection.
  - [ ] Validation: `test/worktree-manager.test.ts` proves successful no-ff merge creates a merge commit, pushed parent branch contains child changes, merge conflict throws `GitMergeConflictError`, and successful child worktree removal calls the expected git command.

#### Phase Exit Gate
- [ ] `npm run typecheck` and `npm test` pass after Phase 2.

#### Phase 3 - Issue-Tree Child Prompt and Completion Contract
- [ ] Objective: Give each child Codex session enough parent/tree context while preserving runner-owned publication and the existing safety report schema.
- [ ] Target: `src/runner/prompt.ts`
  - [ ] Action: Add `IssueTreeChildPromptInput { parentIssue: GitHubIssue; childIssue: GitHubIssue; config: CodexOrchestratorConfig; workflowPromptText: string; childMetadata: AutonomousChildMetadata; dependencyIssues: GitHubIssue[]; promptPath: string; reportPath: string; branchName: string; worktreePath: string }`.
  - [ ] Action: Add `buildIssueTreeChildPrompt(input): string`.
  - [ ] Required prompt sections, in order:
    - `# Codex Orchestrator Issue-Tree Child Implementation`
    - `## Parent Issue Context` with parent issue number, title, URL, and body.
    - `## Child Issue Context` with child issue number, title, URL, body, labels, comments sorted by `createdAt`, stable id, ownership scope, dependencies, and verification expectations.
    - `## Dependency Context` listing dependency child issue numbers/titles and stating they were merged into the parent integration branch before this child starts.
    - `## Project Workflow` containing `config.workflows.issueTreeOrchestration.promptPath` text.
    - `## Runner-Owned Publication Contract` stating Codex must change files only and must not commit, push, merge, open PRs, publish, deploy, or edit GitHub labels/comments.
    - `## Safety Contract` matching the scoped runner safety constraints.
    - `## Completion Report Contract` requiring the existing `ScopedCompletionReport` JSON at `reportPath`.
  - [ ] Rule: Reuse `readScopedCompletionReport` and `validateCompletionReportSafety`; do not add a second completion schema for child implementation unless one required field cannot fit the existing schema.
  - [ ] Validation: `test/prompt-builder.test.ts` proves parent context, child context, dependency context, issue-tree workflow prompt, runner-owned publication contract, safety contract, report path, and existing scoped report schema are present.

#### Phase Exit Gate
- [ ] `npm run typecheck` and `npm test` pass after Phase 3.

#### Phase 4 - Child Wave Execution Runner
- [ ] Objective: Execute planned child batches safely and merge completed child commits into the parent integration branch.
- [ ] Target: `src/runner/plan-auto-command.ts`
  - [ ] Action: Refactor the current planning flow so `runPlanAutoCommand` performs planning, persists children, then executes the child tree before moving the parent to `agent:review`.
  - [ ] Action: Replace final planning-only success status with final tree statuses: `status: 'review-ready' | 'blocked'`.
  - [ ] Rule: Remove the planning report line `Child wave execution is out of scope for #<parent>`. Final reports must describe execution batches, merges, validation, skipped checks, residual risks, and PR URL.
  - [ ] Action: Read `config.workflows.issueTreeOrchestration.promptPath` before claiming the parent. If missing, throw `Issue-tree orchestration workflow prompt not found at <path>` before any label mutation.
  - [ ] Action: After child persistence, use the `childIssues` returned by `persistChildNode` as the candidate set for this run, read each child back with `issueAdapter.getIssue(child.number)`, require `isAutonomousChildOfParent(issue, config, parentIssueNumber)`, parse metadata, and build executable batches.
  - [ ] Rule: Only persisted/readback children with both `agent:child` and exact parent marker can enter the tree. A different issue with `agent:auto` alone must never be prompted, claimed, committed, or reported as a child.
  - [ ] Rule: If batch construction returns non-executable child errors, block the parent before launching any child Codex session. Include issue numbers and exact reasons.
  - [ ] Action: Create the parent integration worktree at `<targetRoot>/<config.runner.workspaceRoot>/tree-<parentIssueNumber>` on branch rendered from `config.branches.issueTree`.
  - [ ] Rule: The parent integration branch starts from `config.branches.base` for a new run. If the worktree or branch already exists, stop with a clear recovery/blocker message; do not force-delete or reset it.
  - [ ] For each child batch:
    - [ ] Create one child worktree per child at `<targetRoot>/<config.runner.workspaceRoot>/tree-<parentIssueNumber>-issue-<childIssueNumber>` on branch `codex/tree-<parentIssueNumber>-issue-<childIssueNumber>` from the current parent integration branch.
    - [ ] Add `agent:running` to each child issue and post a claim comment before launching its Codex session.
    - [ ] Create a durable prompt/report and isolated home path using a session id `tree-<parentIssueNumber>-issue-<childIssueNumber>-<YYYYMMDDHHMMSS>`.
    - [ ] Upsert local run metadata for each active child using mode `tree-child` and `parentIssueNumber: <parentIssueNumber>`. Extend `RunnerMode`, `RunnerProcessMetadata`, `assertValidRun`, and recovery/status rendering to accept and display this mode without treating child metadata as GitHub source of truth.
    - [ ] Run all children in the batch concurrently with `Promise.allSettled`, never exceeding the scheduled batch size.
    - [ ] For each child, enforce the scoped safety sequence: capture `beforeHead`, run Codex, reject Codex-owned `HEAD` changes, require a valid `ScopedCompletionReport` with `status: "completed"`, require at least one changed file, validate changed paths and prohibited actions, run configured checks in the child worktree, commit all child changes with message `Codex: implement issue #<childIssueNumber> for parent #<parentIssueNumber>`.
    - [ ] Rule: `ScopedCompletionReport.status === "needs-promotion"` blocks the whole parent tree before merge/push/PR. Mark that child `agent:blocked`, remove its `agent:running`, post the promotion evidence in the child blocked report, post a parent blocked report, and keep the child worktree/branch for maintainer inspection.
    - [ ] Rule: A child Codex non-zero exit, missing report, malformed report, no changed files, safety violation, needs-promotion report, or commit failure blocks the whole parent tree before merging that batch.
    - [ ] Rule: If any started child in a batch fails, wait for every started sibling to settle, merge none of that batch, push no parent branch, and open no PR. Remove `agent:running` from every started child in the batch. Mark failed children `agent:blocked`. Mark successful-but-unmerged siblings `agent:blocked` with a report explaining their branch/worktree was preserved because a sibling failed before batch merge. Keep every failed or unmerged batch child worktree for maintainer inspection.
    - [ ] After every child in the batch commits successfully, merge child branches into the parent integration worktree sequentially in ascending child issue number with message `Codex: merge issue #<childIssueNumber> into parent #<parentIssueNumber>`.
    - [ ] Rule: On merge conflict, call `abortMerge`, mark the parent blocked, mark the conflicting child blocked, do not push, do not open a PR, and include parent worktree, child worktree, child branch, stdout/stderr, completed prior child issue numbers, and remaining unstarted child issue numbers in the report.
    - [ ] After each successful merge, remove that child worktree, remove child `agent:running`, add child `agent:review`, post a child review report referencing the parent integration branch.
    - [ ] Remove each successful child run metadata entry after its review report succeeds.
  - [ ] Rule: If a draft PR has already been created and a later label/comment update fails, throw an error mentioning the PR URL and do not mark the parent blocked after publication.
  - [ ] Validation: `test/plan-auto-command.test.ts` or new `test/issue-tree-execution-command.test.ts` proves:
    - only marked `agent:child` plus exact parent marker children execute;
    - an unmarked `agent:auto` issue is ignored;
    - hitl/manual/blocked/running/review/closed/malformed children block before Codex launch;
    - dependency order is respected;
    - active fake Codex child sessions never exceed `runner.maxParallelChildren` and never exceed `3`;
    - children with exact overlapping ownership scopes are scheduled in separate batches;
    - each child receives a distinct worktree path, branch name, report path, and isolated home path;
    - child commits are runner-owned and merged into the parent branch;
    - configured check failures appear in consolidated validation rather than preventing draft PR creation;
    - merge conflicts block without push or PR creation and include a clear report;
    - local child run metadata is removed after successful child handoff.

#### Phase Exit Gate
- [ ] `npm run typecheck` and `npm test` pass after Phase 4.

#### Phase 5 - Final Integration PR, CLI, Exports, and Docs
- [ ] Objective: Publish one reviewable draft PR for the whole tree and update public docs/contracts.
- [ ] Target: `src/runner/plan-auto-command.ts`
  - [ ] Action: After all child batches merge successfully, run configured checks once more in the parent integration worktree and append the results to the consolidated validation report.
  - [ ] Action: Push the parent integration branch through `git.pushBranch({ worktreePath: parentWorktreePath, branchName })`.
  - [ ] Action: Create one draft PR through `GitHubPullRequestAdapter.createDraftPullRequest` with title rendered from `config.pullRequests.issueTreeTitle`, base `config.branches.base`, and head `branchName`.
  - [ ] PR body must include:
    - `Parent issue: #<parentIssueNumber>`
    - `Child issues:` with every executed child issue number and title;
    - changed files grouped by child;
    - child validation and final integration validation;
    - skipped checks and residual risks;
    - merge summary with child branch names;
    - statement that auto-merge is disabled.
  - [ ] Action: Remove parent `agent:running`, add parent `agent:review`, post one parent review report beginning `codex-orchestrator issue-tree review report for #<parentIssueNumber>`, include PR URL, executed batches, child issues, validation, skipped checks, residual risks, and merge summary.
  - [ ] Action: Remove parent local run metadata only after the parent review comment succeeds.
  - [ ] Rule: No npm publish, deploy, release, or merge command may be invoked anywhere in this flow.
  - [ ] Validation: Tests prove one draft PR request is created, its body links the parent and child issues, no child PR request is created, parent and child labels move to review after success, and the remote parent branch contains all merged child commits.
- [ ] Target: `src/cli.ts`
  - [ ] Action: Keep `codex-orchestrator run --target <path> --issue <number>`.
  - [ ] Action: Update help text so `run` states scoped `agent:auto` opens one issue PR and `agent:plan-auto` plans plus executes one issue tree into one integration draft PR.
  - [ ] Rule: Do not add a separate required CLI command for child execution in this issue.
  - [ ] Validation: `test/cli.test.ts` proves plan-auto routing reaches the full tree runner and CLI output contains the final issue-tree review or blocked report.
- [ ] Target: `src/index.ts`
  - [ ] Action: Update exported `PlanAutoCommandResult` typing so `status` is `review-ready | blocked` for `agent:plan-auto` tree execution.
  - [ ] Rule: Keep metadata parsers, schedulers, and child execution helpers internal to `src/runner/*`; tests may import those modules directly but the package entrypoint should not expose them in this issue.
  - [ ] Validation: `test/public-api.test.ts` proves the existing package entrypoint still exports `runPlanAutoCommand` and the updated result type compiles through TypeScript usage.
- [ ] Target: `README.md`
  - [ ] Action: Document `agent:plan-auto` as full PR-first tree execution, not planning-only.
  - [ ] Action: Document explicit autonomous child membership, max 3 parallel child implementations, worktree-per-child isolation, blocked/HITL/manual/review behavior, conflict blocking, and one integration draft PR.
  - [ ] Action: State that npm publish, auto-merge, secret/destructive/deploy actions, and separate child PRs are out of scope.

#### Phase Exit Gate
- [ ] `npm run typecheck`, `npm run build`, `npm test`, `npm pack --dry-run`, and `git diff --check` pass after Phase 5.

### Halt Conditions
- [ ] Stop if child metadata cannot be reconstructed from the issue body without using parent comments, issue links, project fields, or title heuristics.
- [ ] Stop if any child would be executed without both `agent:child` and exact marker for the parent.
- [ ] Stop if a child is HITL/manual/blocked/running/review/closed/malformed and the implementation would need to guess whether to skip, satisfy, or merge it.
- [ ] Stop if child work requires shared working tree writes instead of per-child worktrees.
- [ ] Stop if merge conflict handling would require automatic file resolution.
- [ ] Stop if the runner would push/open a PR after any child safety violation, child failure, or unresolved merge conflict.

### Defect Closure Notes
- [x] Every `implementation-spec-review` defect is fixed or explicitly blocked with a concrete reason.

### 4. Validation & Done Criteria
- [x] **Lint/Format:** Not applicable; no lint script exists in `package.json`.
- [x] **Typecheck:** `npm run typecheck`
- [x] **Build:** `npm run build`
- [x] **Tests:** `npm test`
- [x] **Package Dry Run:** `npm pack --dry-run`
- [x] **Diff Check:** `git diff --check`
- [x] **No-Unused Check:** `npm exec -- tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`
- [x] **Architecture Check:** Not applicable; this repository has no architecture-check script.
- [x] **Live/Manual Validation:** Optional only. Do not run live autonomous execution unless a maintainer separately approves a fake/test issue dry-run.
- [x] **Behavior Proof:** Automated temp-git tests prove marker-gated membership, blocked child handling, dependency-aware batches, max 3 concurrency, ownership separation, isolated child worktrees, child commits, parent merges, conflict blocking, one integration draft PR, and consolidated validation report.
- [x] **Post-Implementation Gate:** `$code-review` completed; `$cleanup-review` run inline by maintainer request after validation passed.
- [x] **Final Reconciliation:** all unchecked work is unfinished, blocked with a note, or intentionally not applicable.

### 5. Final Action
After saving the file, respond in chat with exactly:

Spec Status: Ready
Saved Path: docs/implementation-specs/2026-05-08/2007-issue-tree-child-waves.md
Execution Model: Single-Agent
Review Verdict: Approved
Validation Gates: Local / Tests
Blockers: None
