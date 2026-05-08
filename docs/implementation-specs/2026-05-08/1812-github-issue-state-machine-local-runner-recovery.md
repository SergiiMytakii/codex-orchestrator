---
title: "GitHub issue state machine and local runner recovery"
created_at: "2026-05-08T15:12:09Z"
source_type: "issue"
source_plan: "None"
source_issues:
  - "https://github.com/SergiiMytakii/IntelleReach/issues/151"
  - "https://github.com/SergiiMytakii/IntelleReach/issues/154"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_verdict: "Approved"
---

### 1. Execution Context
- **Goal:** Implement the #154 GitHub Issue state machine, clarification gate, local process metadata store, restart recovery, and status dry-run CLI for `codex-orchestrator`.
- **Source Material:** Parent PRD #151, active child issue #154, #154 clarification-gate comment, closed prerequisite #153, merged codex-orchestrator PR #2.
- **Source State Note:** `#154` was observed as accidentally closed at `2026-05-08T15:16:12Z` before implementation existed; it was reopened during orchestration because the user explicitly requested continuing the next wave after PR #2 merge.
- **Approved Scope:** Discovery of configured autonomous labels, skip reasons, visible GitHub claim/block/resume transitions, local metadata-only state, restart recovery reconciliation, status dry-run output, fake adapter tests.
- **Out of Scope:** Running Codex sessions, opening pull requests, issue-tree child implementation waves, npm publishing, auto-merge, destructive operations, secret file reads.
- **Simplest Viable Path:** Add a runner-owned state machine and issue adapter boundary, expose a `status` CLI command, and keep all automated tests fake-adapter and temp-directory based.
- **Primary Risk:** Splitting state ownership between GitHub and local files. GitHub labels/comments/PR links must remain the public source of truth; local files may store only process metadata.

### 2. Preconditions & Evidence
- **Required Services / Env / Fixtures:** Node.js `>=18`; existing `npm install`; local `gh` CLI credentials only for real adapter usage; automated tests must not require network, GitHub credentials, secrets, or real repositories.
- **Blocking Unknowns:** None.
- **Confirmed Targets:**
  - Existing CLI entrypoint: `src/cli.ts`.
  - Existing package exports: `src/index.ts`.
  - Existing config contract: `src/config/schema.ts`, `src/config/constants.ts`.
  - Default labels and state paths: `src/setup/project-config.ts`.
  - Existing gh command adapter pattern: `src/setup/github-label-adapter.ts`.
  - Existing test style: `node:test` files under `test/`.
  - Existing commands: `npm run typecheck`, `npm run build`, `npm test`, `npm pack --dry-run`.
- **Protected Paths / Rejected Approaches:** Do not read `.env*` or other secret files. Do not store issue bodies, comments, labels, PR data, question text, answer text, or GitHub snapshots in local state. Do not infer state from free text alone. Do not implement Codex execution, PR creation, child wave execution, auto-merge, or npm publish.

### Source-of-Truth Map
| Behavior / Data | Owner | Allowed Readers / Projections | Explicit Non-Owners / Compatibility Layers |
|-----------------|-------|-------------------------------|-------------------------------------------|
| Issue authorization and state | GitHub labels from `CodexOrchestratorConfig.github.labels` | Runner discovery, recovery, status output, CLI dry-run | Local state file, CLI output |
| Clarification questions and maintainer answers | GitHub issue comments | Clarification gate detector, recovery, status output | Local state file |
| Completed handoff evidence | GitHub `review` label and `closedByPullRequestsReferences` from issue adapter | Recovery and status output | Local state file |
| Process metadata | Local runner state file under configured `runner.stateDir` | Recovery and status output | GitHub labels/comments |
| Public status explanation | Deterministic projection from GitHub state plus local metadata | CLI output and tests | Free-text issue body inference |

### Public Reason String Contract
| Decision / Status | Exact `reason` string |
|-------------------|-----------------------|
| eligible `scoped-issue` | `has configured auto label and no blocking state labels` |
| eligible `plan-parent` | `has configured plan-auto label and no blocking state labels` |
| skipped `manual-label` | `manual label is present` |
| skipped `blocked-label` | `blocked label is present` |
| skipped `conflicting-authorization-labels` | `auto and plan-auto labels are both present` |
| skipped `conflicting-state-labels` | `multiple state labels are present` |
| skipped `already-running` | `running label is present` |
| skipped `ready-for-review` | `review label is present` |
| skipped `missing-authorization-label` | `no configured auto or plan-auto label is present` |
| skipped `closed` | `issue is closed` |
| recovery `active` | `GitHub still marks the issue running` |
| recovery `stale` | `local run exists but GitHub no longer marks it running` |
| recovery `missing` | `local run has no matching GitHub issue` |
| recovery `completed` | `GitHub marks the work completed` |
| recovery `waiting-for-clarification` | `blocked clarification is waiting for maintainer response` |
| recovery `clarification-resumable` | `maintainer clarification response detected` |

### File Modification Matrix
| Target File Path | Action | Layer / Responsibility | Required Reuse / Abstraction | Required Documentation |
|------------------|--------|------------------------|------------------------------|------------------------|
| `src/github/gh-cli.ts` | Create | Shared gh command executor | Move/reuse the existing `CommandExecutor` pattern instead of duplicating process execution | None |
| `src/setup/github-label-adapter.ts` | Update | Label setup adapter | Import `CommandExecutor` and default executor from `src/github/gh-cli.ts` | None |
| `src/github/issues.ts` | Create | Public GitHub issue adapter contracts and fake adapter | Use configured labels; no live credentials in tests | Exported type docblocks for non-obvious adapter methods |
| `src/github/gh-issue-adapter.ts` | Create | Local `gh` CLI implementation of issue adapter | Use `src/github/gh-cli.ts`; never read secret files | None |
| `src/runner/issue-state-machine.ts` | Create | GitHub-owned issue state decisions and transitions | Use config label names only; no hard-coded label strings except tests | Comments only for conflict and clarification response rules |
| `src/runner/local-state.ts` | Create | Metadata-only local state persistence | Use `runner.stateDir`; atomic write via temp file then rename | Exported type docblock for allowed persisted fields |
| `src/runner/recovery.ts` | Create | Restart reconciliation | Read GitHub through adapter, local process metadata through store | None |
| `src/runner/status-command.ts` | Create | Status/dry-run orchestration and output formatting | Reuse state machine, recovery, config loader helpers where present | None |
| `src/cli.ts` | Update | CLI parsing and command dispatch | Follow existing simple parser style | README command docs |
| `src/index.ts` | Update | Public package API | Export runner contracts needed by tests/adopters | None |
| `README.md` | Update | User-facing CLI docs | Keep concise; state no Codex launch in status/dry-run | README update |
| `test/fixtures/config.ts` | Update if needed | Test fixture config | Keep aligned with `CodexOrchestratorConfig` | None |
| `test/github-issue-adapter.test.ts` | Create | Fake and gh-adapter command tests | Fake command executor only | None |
| `test/issue-state-machine.test.ts` | Create | Discovery, skip, claim, clarification tests | Fake issue fixtures | None |
| `test/local-state.test.ts` | Create | Local metadata persistence tests | Temp dirs only | None |
| `test/recovery.test.ts` | Create | Restart recovery tests | Fake adapter plus temp state | None |
| `test/status-command.test.ts` | Create | Status/dry-run output tests | Fake adapter plus temp config/state | None |
| `test/cli.test.ts` | Update | CLI status command smoke | Fake `gh` binary or direct command fixture; no network | None |

### 3. Execution Phases

#### Progress Discipline
- [ ] Update this checklist as work is completed.
- [ ] Leave blocked work unchecked with a short `Blocked:` note.
- [ ] Stop if repo reality contradicts a confirmed target, command, precondition, or scope boundary.
- [ ] Stop if implementing #154 requires Codex session launch, PR creation, child issue wave execution, auto-merge, secret reads, or npm publishing.

#### Phase 1 - GitHub Issue Adapter Boundary
- [ ] Objective: Create a fakeable GitHub issue adapter without introducing live GitHub dependencies into tests.
- [ ] Target: `src/github/gh-cli.ts`
  - [ ] Action: Create `CommandExecutor`, `CommandResult`, and `defaultGhExecutor(file, args)` using the existing `execFile`/`promisify` pattern from `src/setup/github-label-adapter.ts`.
  - [ ] Action: `CommandResult` must be `{ stdout: string; stderr: string }`; `CommandExecutor` must be `(file: string, args: string[]) => Promise<CommandResult>`. The default executor must reject with an `Error` that preserves a numeric `code` and string `stderr` when `execFile` rejects.
  - [ ] Validation: Existing setup tests still pass after the setup label adapter imports this shared executor.
- [ ] Target: `src/setup/github-label-adapter.ts`
  - [ ] Action: Remove the local `execFile`/`promisify` implementation and import the shared `CommandExecutor` plus default executor from `../github/gh-cli.js`.
  - [ ] Validation: `test/setup-command.test.ts` and `test/cli.test.ts` still prove setup label behavior with fake `gh`.
- [ ] Target: `src/github/issues.ts`
  - [ ] Action: Create these exported contracts:
    - `IssueState = 'OPEN' | 'CLOSED'`
    - `PullRequestState = 'OPEN' | 'CLOSED' | 'MERGED'`
    - `GitHubIssueLabel { name: string }`
    - `GitHubIssueComment { id: string; url: string; body: string; createdAt: string; author: { login: string }; authorAssociation: string }`
    - `GitHubPullRequestLink { number: number; url: string; state: PullRequestState }`
    - `GitHubIssue { number: number; title: string; url: string; state: IssueState; labels: GitHubIssueLabel[]; comments: GitHubIssueComment[]; closedByPullRequestsReferences: GitHubPullRequestLink[] }`
    - `GitHubIssueAdapter` with `listOpenIssuesWithAnyLabel(labels: string[]): Promise<GitHubIssue[]>`, `getIssue(number: number): Promise<GitHubIssue | undefined>`, `addLabels(issueNumber: number, labels: string[]): Promise<void>`, `removeLabels(issueNumber: number, labels: string[]): Promise<void>`, `postComment(issueNumber: number, body: string): Promise<void>`
    - `InMemoryGitHubIssueAdapter` for tests, recording label/comment mutations in public arrays.
  - [ ] Validation: `test/github-issue-adapter.test.ts` proves the in-memory adapter lists issues by any matching label, returns `undefined` for missing issues, mutates labels, and records posted comments.
- [ ] Target: `src/github/gh-issue-adapter.ts`
  - [ ] Action: Create `GhCliIssueAdapter(owner, repo, executor = defaultGhExecutor)` implementing `GitHubIssueAdapter`.
  - [ ] Action: `listOpenIssuesWithAnyLabel(labels)` must call `gh issue list --repo <owner>/<repo> --state open --label <label> --limit 100 --json number,title,url,state,labels,comments,closedByPullRequestsReferences` once per requested label, merge by issue number, and normalize missing arrays to `[]`.
  - [ ] Action: `getIssue(number)` must call `gh issue view <number> --repo <owner>/<repo> --json number,title,url,state,labels,comments,closedByPullRequestsReferences` and return `undefined` only when the executor rejects with `code: 1` and `stderr` matches `/(not found|could not resolve to an issue or pull request)/i`. All other failures must be rethrown.
  - [ ] Action: `addLabels`, `removeLabels`, and `postComment` must use `gh issue edit <number> --repo <owner>/<repo> --add-label <name>`, `--remove-label <name>`, and `gh issue comment <number> --repo <owner>/<repo> --body <body>`.
  - [ ] Validation: `test/github-issue-adapter.test.ts` uses a fake executor to assert exact command arguments, JSON normalization, and missing issue handling for both `not found` and `GraphQL: Could not resolve to an issue or pull request...` stderr shapes.

#### Phase Exit Gate
- [ ] `npm run typecheck` passes after Phase 1.

#### Phase 2 - State Machine and Clarification Gate
- [ ] Objective: Implement deterministic discovery, skip reasons, claim transitions, and clarification transitions using GitHub as source of truth.
- [ ] Target: `src/runner/issue-state-machine.ts`
  - [ ] Action: Export `RunnerMode = 'scoped-issue' | 'plan-parent'`.
  - [ ] Action: Export `SkipReasonCode = 'manual-label' | 'blocked-label' | 'conflicting-authorization-labels' | 'conflicting-state-labels' | 'already-running' | 'ready-for-review' | 'missing-authorization-label' | 'closed'`.
  - [ ] Action: Export `IssueDiscoveryDecision` as either `{ kind: 'eligible'; issueNumber; title; mode; reason }` or `{ kind: 'skipped'; issueNumber; title; reasonCode; reason }`.
  - [ ] Action: Export `discoverIssueWork(issues, config)` returning decisions sorted by issue number ascending.
  - [ ] Rule: Eligible scoped issue has configured `auto` label, lacks `planAuto`, lacks `manual`, `blocked`, `running`, `review`, and has state `OPEN`.
  - [ ] Rule: Eligible parent issue has configured `planAuto` label, lacks `auto`, lacks `manual`, `blocked`, `running`, `review`, and has state `OPEN`.
  - [ ] Rule: Skip precedence must be exactly `conflicting-state-labels`, `conflicting-authorization-labels`, `manual-label`, `blocked-label`, `already-running`, `ready-for-review`, `closed`, `missing-authorization-label`, then eligible. This means an issue with both `auto` and `planAuto` plus `manual` skips as `conflicting-authorization-labels`, while an issue with `manual` only skips as `manual-label`.
  - [ ] Rule: More than one authorization label from `auto` and `planAuto` skips with `conflicting-authorization-labels`.
  - [ ] Rule: More than one state label from `running`, `blocked`, `review` skips with `conflicting-state-labels`.
  - [ ] Rule: `running` skips with `already-running`; `review` skips with `ready-for-review`; closed issues skip with `closed`; no auth labels skip with `missing-authorization-label`.
  - [ ] Action: Export `claimIssue(adapter, config, issueNumber, mode, now)` that adds the configured `running` label and posts exactly `codex-orchestrator: claimed #<number> for <scoped-issue|plan-parent> autonomous work at <ISO timestamp>.`
  - [ ] Action: Export `ClarificationQuestion { question: string; blocks: string }` and `CodexSessionResult = { status: 'ready' } | { status: 'needs-clarification'; questions: ClarificationQuestion[] }`.
  - [ ] Action: Export `applyClarificationGate(adapter, config, issueNumber, questions, now)` that removes `running`, adds `blocked`, and posts one comment starting with `codex-orchestrator clarification questions for #<number>` followed by numbered lines in the format `<n>. <question> Blocks: <blocks>`.
  - [ ] Rule: `applyClarificationGate` must throw `needs-clarification requires at least one question with non-empty question and blocks` when `questions` is empty or any `question` or `blocks` value is blank after trimming.
  - [ ] Action: Export `applyCodexSessionResult(adapter, config, issueNumber, result, now)` that returns `{ action: 'none' }` for `{ status: 'ready' }` without label/comment mutations, and returns `{ action: 'blocked-for-clarification' }` after delegating to `applyClarificationGate` for `{ status: 'needs-clarification' }`.
  - [ ] Action: Export `hasMaintainerResponseAfterLatestClarification(issue)` that returns `true` only when a comment authored after the latest orchestrator clarification comment has `authorAssociation` equal to `OWNER`, `MEMBER`, or `COLLABORATOR`.
  - [ ] Action: Export `clearClarificationGate(adapter, config, issueNumber, now)` that removes `blocked`, adds `running`, and posts exactly `codex-orchestrator: maintainer clarification detected for #<number>; resuming at <ISO timestamp>.`
  - [ ] Validation: `test/issue-state-machine.test.ts` covers eligible `agent:auto`, eligible `agent:plan-auto`, manual skip, blocked skip, conflicting authorization skip, conflicting state skip, running skip, review skip, closed skip, missing auth skip, claim mutation/comment, no-clarification no-op path, clarification-blocked path, clarification-resumed path, empty clarification questions rejection, and blank question/blocks rejection.

#### Phase Exit Gate
- [ ] `npm run typecheck` and `npm test` pass after Phase 2.

#### Phase 3 - Metadata-Only Local State
- [ ] Objective: Persist only local process metadata needed for restart recovery.
- [ ] Target: `src/runner/local-state.ts`
  - [ ] Action: Create `RunnerStateFile` with `version: 1` and `runs: RunnerProcessMetadata[]`.
  - [ ] Action: Create `RunnerProcessMetadata` with only these persisted fields: `issueNumber`, `mode`, `workspacePath`, `sessionId`, `retryCount`, `createdAt`, `updatedAt`, optional `lastRecoveredAt`.
  - [ ] Action: Create `RunnerStateStore` with constructor `new RunnerStateStore(targetRoot: string, config: CodexOrchestratorConfig)` and methods `load()`, `save(state)`, `upsertRun(metadata)`, `removeRun(issueNumber)`, and `statePath()`.
  - [ ] Rule: `statePath()` must be `<targetRoot>/<config.runner.stateDir>/runner-state.json`.
  - [ ] Rule: Missing state file loads as `{ version: 1, runs: [] }`.
  - [ ] Rule: Saves must create the state directory and write atomically through a temporary sibling file followed by rename.
  - [ ] Rule: `save` must reject unknown persisted keys so issue bodies, comments, labels, PR links, question text, answer text, or GitHub snapshots cannot be stored accidentally.
  - [ ] Validation: `test/local-state.test.ts` proves missing file default, atomic persisted JSON shape, upsert/remove behavior, and rejection of forbidden extra keys such as `labels`, `comments`, `body`, `questions`, and `pullRequests`.

#### Phase Exit Gate
- [ ] `npm run typecheck` and `npm test` pass after Phase 3.

#### Phase 4 - Restart Recovery
- [ ] Objective: Reconcile local metadata against GitHub state and report stale, missing, completed, blocked, and resumable work clearly.
- [ ] Target: `src/runner/recovery.ts`
  - [ ] Action: Create `RecoveryStatus = 'active' | 'stale' | 'missing' | 'completed' | 'waiting-for-clarification' | 'clarification-resumable'`.
  - [ ] Action: Create `RecoveryEntry { issueNumber; mode; status; reason; workspacePath; sessionId; retryCount }`.
  - [ ] Action: Create `reconcileRunnerState({ store, issueAdapter, config, now, allowClarificationResume, updateLocalState })` returning entries sorted by issue number ascending.
  - [ ] Rule: `allowClarificationResume` defaults to `false`; when false, reconciliation reports resumable work without mutating GitHub.
  - [ ] Rule: `updateLocalState` defaults to `true`; when `false`, reconciliation must not write local state or update `lastRecoveredAt`.
  - [ ] Rule: When `updateLocalState` is `true`, reconciliation must only set `lastRecoveredAt` to `now` on each retained local run after classification; it must not remove runs or modify `issueNumber`, `mode`, `workspacePath`, `sessionId`, `retryCount`, `createdAt`, or `updatedAt`. Cleanup/removal of completed, missing, or stale runs is out of scope.
  - [ ] Rule: Only the non-status recovery path may call reconciliation with `updateLocalState: true`. The status/dry-run CLI must always use `updateLocalState: false`.
  - [ ] Rule: Missing GitHub issue returns `missing` with reason `local run has no matching GitHub issue`.
  - [ ] Rule: Closed GitHub issue, configured `review` label, or non-empty `closedByPullRequestsReferences` returns `completed`.
  - [ ] Rule: Configured `blocked` label with no maintainer response after latest clarification returns `waiting-for-clarification`.
  - [ ] Rule: Configured `blocked` label with maintainer response after latest clarification returns `clarification-resumable`; it must call `clearClarificationGate` only when `allowClarificationResume` is `true`.
  - [ ] Rule: Configured `running` label returns `active`.
  - [ ] Rule: Local run without `running`, `blocked`, `review`, closed issue, or PR link returns `stale` with reason `local run exists but GitHub no longer marks it running`.
  - [ ] Validation: `test/recovery.test.ts` covers every status above, verifies `clearClarificationGate` is called only for answered clarification when `allowClarificationResume` is `true`, verifies the default path is report-only, proves `updateLocalState: true` updates only `lastRecoveredAt` and does not delete completed/missing/stale runs, and proves local state does not gain GitHub-derived content during reconciliation.

#### Phase Exit Gate
- [ ] `npm run typecheck` and `npm test` pass after Phase 4.

#### Phase 5 - Status / Dry-Run CLI
- [ ] Objective: Expose a read-only status view that shows picked work and skipped reasons without launching Codex or mutating GitHub.
- [ ] Target: `src/runner/status-command.ts`
  - [ ] Action: Create `StatusCommandResult { output: string; dryRun: boolean; eligible: IssueDiscoveryDecision[]; skipped: IssueDiscoveryDecision[]; recovery: RecoveryEntry[] }`.
  - [ ] Action: Create `runStatusCommand({ targetRoot, issueAdapter?, dryRun? }): Promise<StatusCommandResult>`.
  - [ ] Action: Load `<targetRoot>/.codex-orchestrator/config.json`, validate it with `validateConfig`, instantiate `GhCliIssueAdapter` when no adapter is provided, load local state through `RunnerStateStore`, discover issues through `discoverIssueWork`, and reconcile local state through `reconcileRunnerState`.
  - [ ] Rule: Status discovery must call `listOpenIssuesWithAnyLabel` with this exact configured label set, in order: `auto`, `planAuto`, `manual`, `blocked`, `running`, `review`. It must not include `child` because #154 does not implement child wave execution. Because discovery uses open issue listing, closed issues can appear only in recovery via `getIssue` for existing local runs.
  - [ ] Rule: Status mode is read-only in both normal and dry-run modes. It must call `reconcileRunnerState` with `allowClarificationResume: false` and must not call `addLabels`, `removeLabels`, or `postComment`.
  - [ ] Action: Format output exactly in this section order:
    - `codex-orchestrator status`
    - `repo: <owner>/<repo>`
    - `target: <absolute targetRoot>`
    - `mode: dry-run` or `mode: status`
    - `eligible:`
    - one line per eligible decision: `  - #<number> <mode>: <reason>`
    - `skipped:`
    - one line per skipped decision: `  - #<number> <reasonCode>: <reason>`
    - `recovery:`
    - one line per recovery entry: `  - #<number> <status>: <reason>`
    - Use `  - none` for empty sections.
  - [ ] Validation: `test/status-command.test.ts` proves the `StatusCommandResult` shape, output ordering, eligible lines, skipped reason lines, recovery lines, empty `none` sections, invalid config failure, and dry-run no-mutation behavior.
- [ ] Target: `src/cli.ts`
  - [ ] Action: Add help text and parser support for `codex-orchestrator status --target <path> [--dry-run]`.
  - [ ] Action: Missing `--target` must return exit code `2` and stderr `status requires --target <path>`.
  - [ ] Action: Unknown status flags must follow the existing unknown-option style and return exit code `2`.
  - [ ] Validation: `test/cli.test.ts` covers help includes `status`, status missing target exits `2`, and a dry-run status command uses fake `gh` output without launching Codex.
- [ ] Target: `src/index.ts`
  - [ ] Action: Export `GitHubIssueAdapter`, `InMemoryGitHubIssueAdapter`, discovery/recovery/status public functions and result types.
  - [ ] Validation: `test/public-api.test.ts` imports these exports from `../src/index.js`.
- [ ] Target: `README.md`
  - [ ] Action: Document `status --target <path> [--dry-run]`, state that it reads configured GitHub issues and local metadata, and state that dry-run does not launch Codex or mutate labels/comments.
  - [ ] Validation: README references must match the implemented command.

#### Phase Exit Gate
- [ ] `npm run typecheck`, `npm run build`, and `npm test` pass after Phase 5.

### 4. Acceptance Criteria Mapping
| #154 Acceptance Criterion | Required Implementation Proof |
|---------------------------|-------------------------------|
| Discover `agent:auto` issues and `agent:plan-auto` parent issues according to configured labels. | `discoverIssueWork` tests for configured `auto` and `planAuto`; `status` output eligible section. |
| Ignore issues with `agent:manual`, `agent:blocked`, or conflicting state labels. | State machine skip tests for `manual-label`, `blocked-label`, `conflicting-authorization-labels`, and `conflicting-state-labels`; `status` skipped section. |
| Treat GitHub labels, comments, and pull request links as public source of truth. | Source-of-truth map, adapter contracts, recovery tests using labels/comments/`closedByPullRequestsReferences`; local-state tests reject GitHub snapshots. |
| Store only process metadata locally: workspace path, session id, retry count, timestamps. | `RunnerProcessMetadata` exact field test plus rejection of labels/comments/body/questions/PR links. |
| Restart recovery reconciles local state against GitHub state and reports stale, missing, or completed work clearly. | `reconcileRunnerState` tests for `stale`, `missing`, `completed`, `active`, `waiting-for-clarification`, `clarification-resumable`; `status` recovery output. |
| CLI exposes status or dry-run view showing what would be picked and why others are skipped. | `codex-orchestrator status --target <path> --dry-run` tests and output ordering tests. |
| Codex session can report `needs-clarification` with concrete questions. | `CodexSessionResult` and `ClarificationQuestion` public types plus no-clarification and needs-clarification tests. |
| Runner applies blocked/waiting state and posts questions to GitHub. | `applyClarificationGate` removes running, adds blocked, posts deterministic numbered question comment. |
| Runner does not continue until maintainer response detected. | Discovery skips blocked issues; recovery reports `waiting-for-clarification` when no maintainer answer exists. |
| Resume rehydrates issue/tree context and clears blocker only when answers are present. | `hasMaintainerResponseAfterLatestClarification` and `reconcileRunnerState` tests for answer/no-answer branches; dry-run does not mutate. |
| Tests cover no-clarification, clarification-blocked, clarification-resumed paths. | `test/issue-state-machine.test.ts` and `test/recovery.test.ts` named tests for all three paths. |

### 5. Validation & Done Criteria
- [ ] **Lint/Format:** Not applicable; repository has no lint script.
- [ ] **Typecheck:** `npm run typecheck`
- [ ] **Build:** `npm run build`
- [ ] **Tests:** `npm test`
- [ ] **Package Check:** `npm pack --dry-run`
- [ ] **Architecture Check:** Not applicable; repository has no architecture script.
- [ ] **Live/Manual Validation:** Optional only: `node dist/src/cli.js status --target <safe target repo> --dry-run`. This must not be required for completion because automated fake-adapter tests cover behavior without GitHub credentials.
- [ ] **Behavior Proof:** Status output lists eligible work, skipped work with reason codes, and recovery entries; tests prove GitHub remains public state owner and local state remains metadata-only.
- [ ] **Post-Implementation Review:** Because this is a medium/large runtime change, run `$code-review`, then run `$cleanup-review` in a dedicated subagent, then reconcile any required fixes before final response.
- [ ] **Final Reconciliation:** all unchecked work is unfinished, blocked with a note, or intentionally not applicable.

### Halt Conditions
- [ ] A required precondition cannot be satisfied exactly.
- [ ] A target file, symbol, command, dependency, or interface differs from confirmed evidence.
- [ ] A validation command fails and cannot be fixed within two focused attempts.
- [ ] A write target, ownership boundary, or source-of-truth assumption is contradicted by repo reality.
- [ ] A protected path or rejected approach would need to be violated.
- [ ] An included issue acceptance criterion cannot be mapped to implementation and validation proof.
- [ ] A prerequisite issue, external contract, credential, license, fixture, or live validation input is missing or contradicted.
- [ ] The implementation would require scope not approved by #154, such as Codex launch, PR creation, child issue wave execution, auto-merge, secret file reads, or npm publish.

### 6. Final Action
After saving the file, respond in chat with exactly:

Spec Status: Ready
Saved Path: docs/implementation-specs/2026-05-08/1812-github-issue-state-machine-local-runner-recovery.md
Execution Model: Single-Agent
Review Verdict: Approved
Validation Gates: Local / Tests
Blockers: None
