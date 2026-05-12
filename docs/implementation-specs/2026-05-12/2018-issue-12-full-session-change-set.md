---
title: "Issue #12 full session change set"
created_at: "2026-05-12T20:18:03+03:00"
source_type: "issue"
source_plan: "None"
source_issues:
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/12"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/11"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_verdict: "Approved"
---

## 1. Execution Context
- **Goal:** Add one runner-owned session change-set view that includes agent local commits plus staged, unstaged, and untracked files, then make implementation runners validate that full local set before any runner-owned push or draft PR.
- **Source Material:** GitHub issue #12, parent PRD #11, owner comments on both issues, `AGENTS.md`, `package.json`, `src/git/worktree.ts`, `src/runner/scoped-auto-command.ts`, `src/runner/plan-auto-command.ts`, `src/runner/safety.ts`, `src/runner/prompt.ts`, `test/worktree-manager.test.ts`, `test/scoped-auto-command.test.ts`, `test/plan-auto-command.test.ts`, `test/safety.test.ts`.
- **Approved Scope:** Session changed-path collection from `baseHead` to final `HEAD` plus staged, unstaged, and untracked paths; commit metadata sufficient for later reports; scoped and tree-child implementation runners consuming this full changed-path list for no-change, denied-path safety, review gates, PR body, and issue report; prompt contract updated so implementation agents may create local commits but still may not push, open PRs, merge, publish, deploy, or mutate GitHub issues/labels/comments.
- **Out of Scope:** Sandcastle dependency; stream logs; idle timeout; structured-output overhaul; reusable execution sessions; external sandbox providers; auto-merge; planning sessions creating commits or file changes; agents pushing branches, opening PRs, merging PRs, publishing, deploying, or mutating GitHub issues/labels/comments; release publishing.
- **Simplest Viable Path:** Add `GitWorktreeManager.collectSessionChangeSet({ worktreePath, baseHead })` as the only git source of truth, then replace runner uses of `listChangedFiles(worktreePath)` after implementation sessions with `changeSet.changedPaths`.
- **Primary Risk:** Current implementation runners block immediately when `HEAD` changes, which makes committed-only agent work invisible to safety checks. This issue must allow local implementation commits to be validated as data while preserving runner ownership of every external publication action.

## 2. Preconditions And Evidence
- **Required Services / Env / Fixtures:** Node.js `>=18`; npm dependencies installed; `git` CLI available; tests use temp git repositories, local bare remotes, fake Codex adapters, fake shell executors, and in-memory GitHub adapters only. No live GitHub calls or external auth are required.
- **Blocking Unknowns:** None.
- **Confirmed Targets:** `src/git/worktree.ts` owns git worktree operations and current porcelain parsing; `src/runner/scoped-auto-command.ts` captures `beforeHead`, currently blocks changed `HEAD`, then uses `git.listChangedFiles`; `src/runner/plan-auto-command.ts` keeps parent planning mutation-free and tree-child execution currently blocks changed `HEAD`; `src/runner/safety.ts` validates denied changed paths; `src/runner/prompt.ts` currently forbids implementation commits; `test/worktree-manager.test.ts`, `test/scoped-auto-command.test.ts`, `test/plan-auto-command.test.ts`, and `test/safety.test.ts` already use temp repos and public runner/git interfaces.
- **Confirmed Commands:**
  - `npm run build`
  - `npm run typecheck`
  - `npm test`
  - `npm run build && node --test dist/test/worktree-manager.test.js`
  - `npm run build && node --test dist/test/safety.test.js`
  - `npm run build && node --test dist/test/scoped-auto-command.test.js`
  - `npm run build && node --test dist/test/plan-auto-command.test.js`
  - `npm run build && node --test dist/test/prompt-builder.test.js`
- **Protected Paths / Rejected Approaches:** Do not read `.env` or `.env.*`; do not run `npm publish`; do not add Sandcastle; do not add parallel git diff/status parsing in runner files; do not use private helper assertions for issue #12 behavior tests; do not change parent planning to allow commits or file mutations; do not let Codex push, open PRs, merge, publish, deploy, or mutate GitHub issues/labels/comments.

## Risk Controls
- **Source of Truth:** `src/git/worktree.ts` owns full session change-set collection. Runners, safety checks, review gates, and reports are readers of `SessionChangeSet.changedPaths`.
- **Safety Constraints:** Agent local commits are local implementation artifacts only. The runner remains the only code path that calls `git.pushBranch`, creates draft PRs, merges child branches into the parent integration branch, changes labels, or posts issue comments.
- **Contract Constraints:** Parent planning remains structured-output-only and must still block changed `HEAD` or changed files before child issue mutation. Implementation modes may change local `HEAD`, but must validate committed and uncommitted paths before runner-owned publication.
- **Concurrency / State Constraints:** Single-agent execution. Do not split this issue across concurrent agents because `src/git/worktree.ts`, scoped runner flow, and tree-child runner flow share one change-set contract.
- **Forbidden Scope:** No local commit policy config in this issue; no PR/report redesign beyond feeding the existing changed-file lists from the new full change set; no future-facing logging or reusable-session abstractions.

| Behavior / Data | Owner | Readers / Projections | Non-Owners |
|-----------------|-------|-----------------------|------------|
| Full session changed paths | `src/git/worktree.ts` | `src/runner/scoped-auto-command.ts`, `src/runner/plan-auto-command.ts`, `src/runner/safety.ts`, review gates, PR/report builders | Prompt builders, GitHub adapters |
| Agent local commit metadata | `src/git/worktree.ts` | Future report enhancements; tests in this issue only require enough metadata to prove committed-only sessions | Safety validator |
| External publication | runner command flows after validation | GitHub issue/PR adapters and git push helper | Codex child session |

## Write Scope Summary
- `src/git/worktree.ts` - Update; add `CollectSessionChangeSetInput`, `SessionCommitInfo`, `SessionChangeSet`, and `collectSessionChangeSet`.
- `src/runner/scoped-auto-command.ts` - Update; collect full session change set after Codex exits and after runner visual proof artifacts, then use `changedPaths` for no-change, safety, review gates, PR body, and issue report.
- `src/runner/plan-auto-command.ts` - Update; keep parent planning strict, but use full child session change sets in `executeChild` for no-change, safety, review gates, child reports, parent PR body, and merge summary.
- `src/runner/safety.ts` - Update only if needed to keep `validateChangedPaths(paths, config)` as the single denied-path validator for full changed-path lists.
- `src/runner/prompt.ts` - Update scoped and issue-tree child implementation publication-contract text to allow local commits and continue forbidding push, PR creation, merges, publishing, deploying, and GitHub issue mutations. Do not change parent planning prompt.
- `test/worktree-manager.test.ts` - Update; add temp-git tests for committed-only and mixed committed/staged/unstaged/untracked paths through `GitWorktreeManager`.
- `test/safety.test.ts` - Update; prove denied path validation works for combined committed and uncommitted paths.
- `test/scoped-auto-command.test.ts` - Update; prove committed-only scoped sessions are validated/published by runner, denied committed paths block before PR, mixed paths appear in reports, and no-change still blocks.
- `test/plan-auto-command.test.ts` - Update; prove tree-child committed-only sessions are validated and merged by runner, denied committed paths block before parent PR, and parent planning still blocks commits/file changes.
- `test/prompt-builder.test.ts` - Update; prove implementation prompts allow local commits while still forbidding external publication, and parent planning still forbids commits.

## 3. Execution Slices

### Progress Discipline
- [ ] Update this checklist as work is completed.
- [ ] Leave blocked work unchecked with a short `Blocked:` note.
- [ ] Stop if repo reality contradicts a confirmed target, command, precondition, or scope boundary.
- [ ] Keep each implementation phase as a vertical tracer-bullet slice, not a horizontal layer pass.
- [ ] For behavior changes, start each slice with one behavior-first test/proof before implementation work.
- [ ] Do not write all tests first. Use RED -> GREEN -> refactor per slice.

### Slice 1 - Git Owner Reports Committed-Only Session Changes
- [ ] Objective: A session with only agent-created local commits is observable as changed files through the public git-facing manager.
- [ ] Test/Proof First: Add one failing test in `test/worktree-manager.test.ts`: create a temp repo, create an issue worktree through `GitWorktreeManager`, record `baseHead = await git.getHead(worktreePath)`, write `committed.txt`, run `git -C ${worktreePath} add committed.txt`, run `git -C ${worktreePath} commit -m "agent local commit"` with test git user config if needed, call `git.collectSessionChangeSet({ worktreePath, baseHead })`, and assert `changedPaths` is `['committed.txt']`, `commits.length === 1`, and `hasChanges === true`.
- [ ] Target: `src/git/worktree.ts`
  - [ ] Action: Add exported interfaces:
    - `CollectSessionChangeSetInput { worktreePath: string; baseHead: string }`
    - `SessionCommitInfo { sha: string; subject: string; authorName: string; authorEmail: string; committedAt: string }`
    - `SessionChangeSet { baseHead: string; head: string; changedPaths: string[]; commits: SessionCommitInfo[]; hasChanges: boolean }`
  - [ ] Action: Add `public async collectSessionChangeSet(input: CollectSessionChangeSetInput): Promise<SessionChangeSet>`.
  - [ ] Action: Inside the method, read final `HEAD` with existing `getHead`, collect committed paths with `git -C <worktreePath> diff --name-only -z <baseHead>..HEAD`, collect working-tree paths by reusing `listChangedFiles(worktreePath)`, collect commit metadata with `git -C <worktreePath> log --format=%H%x00%s%x00%an%x00%ae%x00%cI%x00 <baseHead>..HEAD`, normalize slash separators, dedupe, and sort `changedPaths` lexically.
  - [ ] Validation: Run `npm run build && node --test dist/test/worktree-manager.test.js`.
- [ ] Slice Exit Gate: The committed-only test fails before implementation and passes after implementation.

### Slice 2 - Git Owner Combines Committed and Working-Tree Paths
- [ ] Objective: Staged, unstaged, untracked, and committed paths are reported together without adding git parsing outside the owner.
- [ ] Test/Proof First: Add one failing test in `test/worktree-manager.test.ts`: before `baseHead`, create and commit `tracked.txt`; after `baseHead`, commit `committed.txt`, create and stage `staged.txt`, modify `tracked.txt` without staging, leave `untracked.txt`, call `collectSessionChangeSet`, and assert `changedPaths` is exactly `['committed.txt', 'staged.txt', 'tracked.txt', 'untracked.txt']`.
- [ ] Target: `src/git/worktree.ts`
  - [ ] Action: Ensure `collectSessionChangeSet` uses the existing porcelain parser for staged, unstaged, untracked, rename, and copy records instead of duplicating parser logic.
  - [ ] Action: Ensure paths changed both by commit history and working tree appear once.
  - [ ] Validation: Run `npm run build && node --test dist/test/worktree-manager.test.js`.
- [ ] Test/Proof First: Add one failing test in `test/safety.test.ts`: create a temp-git full change set with committed `secrets/committed.txt` and untracked `secrets/untracked.txt`, pass `changeSet.changedPaths` to `validateChangedPaths` with `additionalPathGlobs: ['secrets/**']`, and assert both denied paths are represented by `secret-file-change` violations.
- [ ] Target: `src/runner/safety.ts`
  - [ ] Action: Keep `validateChangedPaths(paths, config)` as the single denied-path validator. Do not add a separate committed-path validator.
  - [ ] Validation: Run `npm run build && node --test dist/test/safety.test.js`.
- [ ] Slice Exit Gate: Focused git and safety tests pass, and `rg "diff --name-only|status --porcelain" src/runner` shows no new runner-local git parsing.

### Slice 3 - Scoped Runner Validates Full Change Set Before Publication
- [ ] Objective: A scoped implementation session that creates only a local commit is validated and then published only by the runner.
- [ ] Test/Proof First: Add one failing test in `test/scoped-auto-command.test.ts`: fake Codex writes a valid completion report, configures test git user in `input.worktreePath`, creates and commits `committed-feature.txt`, leaves the working tree clean, and exits `0`; assert `result.status === 'review-ready'`, draft PR count is `1`, PR body and issue review report include `committed-feature.txt`, remote branch exists only after runner completion, and the last remote commit message is `Codex: implement issue #155`.
- [ ] Target: `src/runner/scoped-auto-command.ts`
  - [ ] Action: Capture `beforeHead` before Codex as today.
  - [ ] Action: After Codex exits and report is read, replace the implementation-mode `validateNoAgentOwnedGitPublication(beforeHead, afterHead)` block with full session change-set collection. Local `HEAD` changes are allowed here because they are input to validation.
  - [ ] Action: Use `const changeSet = await git.collectSessionChangeSet({ worktreePath, baseHead: beforeHead })`.
  - [ ] Action: Replace post-Codex `git.listChangedFiles(worktreePath)` reads with `changeSet.changedPaths`; after runner visual proof writes artifacts, recollect with the same `baseHead`.
  - [ ] Action: Keep runner-owned order: completion report validation, no-change check, denied-path validation, configured checks, visual proof, review gates, then `git.commitAll`, `git.pushBranch`, and draft PR creation.
  - [ ] Validation: Run `npm run build && node --test dist/test/scoped-auto-command.test.js`.
- [ ] Test/Proof First: Add one failing scoped test where fake Codex commits `.env.local` or `secrets/committed.txt`; assert result is `blocked`, draft PR count is `0`, and blocked report includes the denied committed path.
- [ ] Target: `src/runner/scoped-auto-command.ts`
  - [ ] Action: Ensure `validateChangedPaths(changeSet.changedPaths, config)` runs before configured checks, runner push, and draft PR creation.
- [ ] Test/Proof First: Add one failing scoped test where fake Codex writes a valid report but creates no commits and no working-tree changes; assert result is `blocked`, no PR is created, and report contains `Codex completed without file changes`.
- [ ] Target: `src/runner/scoped-auto-command.ts`
  - [ ] Action: Use `changeSet.hasChanges` or `changeSet.changedPaths.length === 0` for the existing no-change block.
- [ ] Slice Exit Gate: Scoped committed-only, denied committed path, and no-change tests pass; no agent code path pushes or opens PRs before runner validation.

### Slice 4 - Tree-Child Runner Uses Full Change Set, Parent Planning Stays Strict
- [ ] Objective: Issue-tree child implementation sessions can create local commits that are validated before runner merge/push, while parent planning remains mutation-free.
- [ ] Test/Proof First: Add one failing test in `test/plan-auto-command.test.ts`: child fake Codex creates and commits `child-<issueNumber>.txt`, writes a valid report, and exits `0`; assert parent result is `review-ready`, parent PR count is `1`, child review report and parent PR body include the committed file, and merge into `codex/tree-<parent>` is still runner-owned.
- [ ] Target: `src/runner/plan-auto-command.ts`
  - [ ] Action: In `executeChild`, capture `beforeHead` before Codex as today.
  - [ ] Action: Replace child implementation-mode `validateNoAgentOwnedGitPublication(beforeHead, afterHead)` block with `input.git.collectSessionChangeSet({ worktreePath, baseHead: beforeHead })`.
  - [ ] Action: Use `changeSet.changedPaths` for child no-change, denied-path validation, configured checks, visual proof, review gates, `ChildExecutionResult.changedFiles`, child review reports, parent PR body, and issue-tree review report.
  - [ ] Action: After runner visual proof writes artifacts, recollect with the same `baseHead`.
  - [ ] Validation: Run `npm run build && node --test dist/test/plan-auto-command.test.js`.
- [ ] Test/Proof First: Add one failing tree-child test where child Codex commits a denied path; assert parent result is `blocked`, child/parent PR count is `0`, failed child is marked blocked, and blocked reason includes the denied committed path.
- [ ] Target: `src/runner/plan-auto-command.ts`
  - [ ] Action: Ensure denied-path validation runs before child branch merge into the parent worktree and before parent push/PR.
- [ ] Test/Proof First: Extend the existing planning mutation test in `test/plan-auto-command.test.ts` or add a new one: plan-phase fake Codex creates a local commit and writes an otherwise valid plan report; assert parent result is `blocked`, no child issues are created, and the report includes `Planning session changed git HEAD; planning must not commit.`
- [ ] Target: `src/runner/plan-auto-command.ts`
  - [ ] Action: Keep parent planning code path using `beforeHead !== afterHead` and working-tree mutation checks before plan report child issue mutations.
- [ ] Slice Exit Gate: Tree-child committed-only and denied-path tests pass; parent planning still blocks commits and file changes before child mutations.

### Slice 5 - Prompt Contract Matches Local Commit Boundary
- [ ] Objective: Implementation prompts accurately permit local commits while preserving the external publication ban; planning prompt remains stricter.
- [ ] Test/Proof First: Update `test/prompt-builder.test.ts` with failing assertions that scoped and issue-tree child prompts include wording equivalent to `Local commits are allowed` and still include `must not push`, `open pull requests`, `publish`, `deploy`, and `edit GitHub labels/comments`.
- [ ] Target: `src/runner/prompt.ts`
  - [ ] Action: In `buildScopedImplementationPrompt`, replace `Change files only. Do not commit...` with text allowing local commits in the issue worktree while forbidding push, PR creation, merge, publish, deploy, and GitHub issue/label/comment mutation.
  - [ ] Action: In `buildIssueTreeChildPrompt`, make the same implementation-mode contract change.
  - [ ] Action: Do not change `buildPlanAutoPrompt`; parent planning must still forbid commits and repository mutation.
  - [ ] Validation: Run `npm run build && node --test dist/test/prompt-builder.test.js`.
- [ ] Slice Exit Gate: Prompt tests prove implementation agents are no longer instructed to avoid local commits, and planning agents still are.

### Slice 6 - Reconciliation and Public Surface
- [ ] Objective: The new change-set owner is discoverable without leaking unnecessary internals, and old no-change/path behavior is reconciled.
- [ ] Test/Proof First: If `GitWorktreeManager` types are exported from `src/index.ts` today only as the class, add no public export test unless implementation chooses to export `SessionChangeSet` types. If types are exported, update `test/public-api.test.ts` to assert the deliberate exports.
- [ ] Target: `src/index.ts`
  - [ ] Action: Export only `SessionChangeSet`-related types if TypeScript consumers need them through the package root. Do not export private parser helpers.
  - [ ] Validation: Run `npm run build` and `npm run typecheck`.
- [ ] Target: `src/runner/scoped-auto-command.ts`, `src/runner/plan-auto-command.ts`
  - [ ] Action: Ensure every existing report/PR body section named `Changed Files`, `Changed files`, or `Changes` receives the full `changeSet.changedPaths` list.
  - [ ] Action: Ensure runner-owned `git.commitAll` still creates the final publication commit after validation. If Codex already made commits, runner commit may include only remaining uncommitted files; do not squash or rewrite agent local commits in this issue.
  - [ ] Validation: Run scoped and plan-auto focused tests.
- [ ] Slice Exit Gate: All changed-file consumers in implementation flows use the full change-set owner, and no public/private API drift remains.

## Acceptance Criteria Mapping
- **#12 AC: A session with only agent-created commits is reported as having changed files.** Slice 1 proves this through `GitWorktreeManager`; Slices 3 and 4 prove runner flows consume it.
- **#12 AC: Staged, unstaged, and untracked files report alongside committed paths.** Slice 2 proves mixed full change sets through a temp git repository.
- **#12 AC: Denied path validation can run against the combined change set.** Slice 2 safety test plus Slices 3 and 4 runner denied-path tests prove committed and uncommitted denied paths block before publication.
- **#12 AC: Existing no-change behavior still blocks no committed or uncommitted changes.** Slice 3 scoped no-change test and Slice 4 tree-child no-change behavior if already covered by existing child no-change branch; add a child no-change assertion if existing coverage is insufficient.
- **#12 AC: Tests use temp git repositories and public runner/git interfaces rather than private helper assertions.** Slices 1-4 require temp repos, `GitWorktreeManager`, `runScopedAutoCommand`, `runPlanAutoCommand`, fake adapters, and no private parser assertions.
- **Parent #11 constraint: agents can create local commits.** Slices 3-5 permit and test local commits in implementation modes.
- **Parent #11 constraint: runner validates full session change set before push/PR.** Slices 3 and 4 use full `changedPaths` before `git.pushBranch` and draft PR creation.
- **Parent #11 constraint: no external publication by agent.** Risk controls, prompt tests, and runner-flow tests preserve runner-owned push/PR/merge/label/comment actions.

## Halt Conditions
- [ ] Stop if committed paths cannot be collected from `baseHead..HEAD` with git commands available in temp repositories.
- [ ] Stop if enabling local commits requires letting Codex call `push`, create PRs, merge branches, publish, deploy, or mutate GitHub issues.
- [ ] Stop if parent planning cannot remain strict while implementation modes allow local commits.
- [ ] Stop if a runner flow would validate only uncommitted paths after local commits; do not publish partial validation.
- [ ] Stop if implementation creates a second git status/diff parser outside `src/git/worktree.ts`.
- [ ] Stop if tests must call private parser helpers to prove issue #12 acceptance criteria.

## 4. Validation And Done Criteria
- [ ] **Lint/Format:** Not applicable; no lint script is defined in `package.json`.
- [ ] **Typecheck:** `npm run typecheck`
- [ ] **Build:** `npm run build`
- [ ] **Focused Tests:**
  - `npm run build && node --test dist/test/worktree-manager.test.js`
  - `npm run build && node --test dist/test/safety.test.js`
  - `npm run build && node --test dist/test/scoped-auto-command.test.js`
  - `npm run build && node --test dist/test/plan-auto-command.test.js`
  - `npm run build && node --test dist/test/prompt-builder.test.js`
- [ ] **Full Tests:** `npm test`
- [ ] **Architecture Check:** `rg "diff --name-only|status --porcelain" src/runner src/github src/codex src/process` must not show new git parsing outside the existing runner calls or the owner in `src/git/worktree.ts`; `rg "listChangedFiles\\(" src/runner` must not show implementation post-Codex changed-file collection for scoped or tree-child flows.
- [ ] **Live/Manual Validation:** Not applicable.
- [ ] **Behavior Proof:** Focused tests demonstrate committed-only, mixed committed/uncommitted, denied path, no-change, scoped runner, tree-child runner, and prompt-contract behavior.
- [ ] **Post-Implementation Hygiene:** Because this changes shared runtime flow across multiple modules, run `$cleanup-review` after implementation and integrate only high-confidence cleanup fixes.
- [ ] **Final Code Review:** Run `$code-review` after cleanup and relevant validation pass.
- [ ] **Final Reconciliation:** All unchecked work is unfinished, blocked with a note, or intentionally not applicable.

## Defect Closure Notes
- [ ] `implementation-spec-review` found no blocking defects. Review verdict: Approved.

## 5. Final Action
After saving the file, respond in chat with exactly:

Spec Status: Ready
Saved Path: docs/implementation-specs/2026-05-12/2018-issue-12-full-session-change-set.md
Execution Model: Single-Agent
Review Verdict: Approved
Validation Gates: Local / Tests
Blockers: None
