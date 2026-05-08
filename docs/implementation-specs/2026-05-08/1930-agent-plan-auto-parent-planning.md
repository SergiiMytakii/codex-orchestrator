---
title: "agent:plan-auto parent planning and autonomous child marking"
created_at: "2026-05-08T19:30:36+03:00"
source_type: "issue"
source_plan: "None"
source_issues:
  - "https://github.com/SergiiMytakii/IntelleReach/issues/151"
  - "https://github.com/SergiiMytakii/IntelleReach/issues/156"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_verdict: "Approved"
---

### 1. Execution Context
- **Goal:** Implement the planning half of `agent:plan-auto`: claim one eligible parent issue, run a structured Codex planning session, update the parent PRD and child issues through runner-owned GitHub mutations, and stop safely when the child graph is incoherent.
- **Source Material:** Parent PRD #151, child issue #156, #156 owner comment, merged prerequisite PR #4 (`Add scoped agent auto execution`), current `/Users/serhiimytakii/Projects/codex-orchestrator`.
- **Approved Scope:** Parent `agent:plan-auto` claim; project-local PRD, issue-breakdown, breakdown-review, and triage prompt handoff; structured planning report schema; parent PRD update; child issue create/update; explicit autonomous child marker plus parent reference; child authorization only for marked children; blocked report for incoherent graphs.
- **Out of Scope:** Executing child waves (#157), auto-merge, npm publish, live autonomous runs, production deploy/release, non-GitHub trackers, treating manually linked issues as autonomous children, direct GitHub mutations by Codex.
- **Simplest Viable Path:** Add one parent planning runner beside `runScopedAutoCommand`, reuse `claimIssue`, `RunnerStateStore`, `CodexCommandAdapter`, `GitWorktreeManager`, workflow config, and existing label definitions, and extend the GitHub issue adapter only for issue create/update.
- **Primary Risk:** Child membership and inherited authorization can drift into unsafe behavior. The only source of truth for autonomous child membership must be the runner-written `agent:child` label plus exact body marker `<!-- codex-orchestrator:autonomous-child parent=#<parentIssueNumber> -->`.

### 2. Preconditions & Evidence
- **Required Services / Env / Fixtures:** Node.js `>=18`; npm dependencies installed; `git` CLI available for worktree tests; local `gh` CLI credentials only for real adapter usage; automated tests must use temp git repositories, fake Codex adapters, in-memory issue adapters, and package-local prompt fixtures.
- **Blocking Unknowns:** None.
- **Confirmed Targets:**
  - CLI entrypoint: `src/cli.ts`.
  - Config/workflow contracts: `src/config/schema.ts`, `src/config/constants.ts`, `src/setup/project-config.ts`, `src/setup/workflows.ts`.
  - Existing workflow fallback prompts: `prompts/workflows/prd.md`, `prompts/workflows/issue-breakdown.md`, `prompts/workflows/breakdown-review.md`, `prompts/workflows/triage.md`.
  - Issue state owner: `claimIssue`, `discoverIssueWork`, and clarification helpers in `src/runner/issue-state-machine.ts`.
  - Durable prompt/report helpers and Codex report validation owner: `src/runner/prompt.ts`.
  - Local process metadata owner: `src/runner/local-state.ts`.
  - GitHub issue adapter/fake: `src/github/issues.ts`, `src/github/gh-issue-adapter.ts`.
  - Git worktree helper: `src/git/worktree.ts`.
  - Current scoped runner for publication/report patterns: `src/runner/scoped-auto-command.ts`.
  - Current tests use `node:test` under `test/`; `npm test` builds then runs `dist/test/**/*.test.js`.
- **Confirmed External CLI Contract:** Local `gh issue create --help` supports `--title`, `--body`, repeated `--label`, and `--repo`. Local `gh issue edit --help` supports `--title`, `--body`, `--add-label`, `--remove-label`, and `--repo`. `gh issue view --json` supports `number,title,body,url,state,labels,comments,closedByPullRequestsReferences`.
- **Protected Paths / Rejected Approaches:** Do not read `.env*` or configured secret file patterns. Do not add auto-merge. Do not push, commit, open PRs, deploy, publish, or execute child implementation waves. Do not infer child membership from arbitrary links, milestones, projects, comments, issue references, or parent text.

### Risk Controls
- **Source of Truth:** Parent and child issue state is owned by GitHub labels/body through `GitHubIssueAdapter`; local state stores only runner process metadata; child membership is owned only by `src/runner/issue-tree.ts`.
- **Safety Constraints:** Codex must return a structured planning report only. The runner must block if Codex changes repository files, changes git `HEAD`, returns a malformed report, references unknown dependency nodes, creates cycles, omits ownership/verification, or requests unauthorized child execution.
- **Contract Constraints:** GitHub issue creation/update goes through fakeable adapters. Planning prompt/report schema lives in `src/runner/prompt.ts`. `agent:auto` inheritance for children is added only after the runner writes and verifies the `agent:child` label plus exact parent marker in the child body.
- **Concurrency / State Constraints:** #156 handles one parent tree planning session at a time. `runner.maxParallelChildren` remains config for later execution but no child wave is executed in this issue.
- **Forbidden Scope:** No child-wave execution, no integration PR, no live autonomous run, no automatic merge, no npm publish, no direct Codex GitHub writes, no membership heuristics from links/milestones/projects/comments.

| Behavior / Data | Owner | Readers / Projections | Non-Owners |
|-----------------|-------|-----------------------|------------|
| Parent planning claim/block/review state | `claimIssue` plus runner finish helpers through `GitHubIssueAdapter` | status/recovery output, issue comments | Codex prompt text |
| Autonomous child membership | `src/runner/issue-tree.ts` marker helpers | plan runner, later #157 wave executor | issue links, milestones, projects, comments |
| Planning report schema | `src/runner/prompt.ts` | plan runner tests, fake Codex output | GitHub issue bodies |
| Child issue persistence | `GitHubIssueAdapter` create/update methods | plan runner | direct `gh` calls from runner modules |
| Inherited child authorization | plan runner after marker verification | later issue discovery/wave execution | arbitrary `agent:auto` labels without marker+parent |

### Write Scope Summary
- `src/github/issues.ts` - Extend issue adapter contracts and in-memory fake with issue create/update operations.
- `src/github/gh-issue-adapter.ts` - Implement `gh issue create/edit/view` backed create/update behavior.
- `src/runner/issue-tree.ts` - Create exact autonomous child marker, membership, body-normalization, and graph validation helpers.
- `src/runner/prompt.ts` - Add parent planning prompt builder and planning report reader/validator.
- `src/runner/plan-auto-command.ts` - Add end-to-end parent planning command.
- `src/cli.ts` - Route `run --target <path> --issue <number>` to scoped or parent planning mode based on issue discovery.
- `src/index.ts` - Export public planning runner and membership helpers needed by adopters/tests.
- `README.md` - Document `agent:plan-auto` planning-only behavior, explicit child marker, blocked graph behavior, and out-of-scope child execution.
- `test/**` - Add focused tests for issue adapter create/update, marker rules, graph validation, planning prompt/report, parent planning command, CLI routing, and public exports.

### 3. Execution Phases

#### Progress Discipline
- [x] Update this checklist as work is completed.
- [x] Leave blocked work unchecked with a short `Blocked:` note.
- [x] Stop if repo reality contradicts a confirmed target, command, precondition, or scope boundary.
- [x] Stop if implementation requires child-wave execution, auto-merge, npm publish, live GitHub-only validation, direct Codex GitHub mutation, secret file reads, destructive database/cache actions, or production deploy/release.

#### Phase 1 - GitHub Issue Create/Update Contract
- [x] Objective: Give the runner a fakeable way to create/update parent and child issues without letting Codex mutate GitHub.
- [x] Target: `src/github/issues.ts`
  - [x] Action: Add `CreateIssueInput { title: string; body: string; labels: string[] }`.
  - [x] Action: Add `UpdateIssueInput { title?: string; body?: string; addLabels?: string[]; removeLabels?: string[] }`.
  - [x] Action: Extend `GitHubIssueAdapter` with `createIssue(input): Promise<GitHubIssue>` and `updateIssue(issueNumber, input): Promise<GitHubIssue>`.
  - [x] Action: Implement both methods in `InMemoryGitHubIssueAdapter`. New issue numbers must be deterministic: one greater than the current max issue number, or `1` when empty.
  - [x] Rule: `updateIssue` must preserve existing labels/comments/pull request links unless its input explicitly changes title/body/labels.
  - [x] Validation: `test/github-issue-adapter.test.ts` proves create assigns deterministic numbers, stores body/title/labels, update changes title/body, `addLabels` is idempotent, `removeLabels` removes only requested labels, and comments are preserved.
- [x] Target: `src/github/gh-issue-adapter.ts`
  - [x] Action: Implement `createIssue` with `gh issue create --repo <owner>/<repo> --title <title> --body <body>` plus one `--label <name>` per label.
  - [x] Action: Parse stdout for `/issues/<number>`; if parsing fails, throw `gh issue create did not return an issue URL`.
  - [x] Action: After create, call `getIssue(number)` and return the normalized issue; if missing, throw `Created issue #<number> was not found`.
  - [x] Action: Implement `updateIssue` with `gh issue edit <number> --repo <owner>/<repo>`, adding `--title`, `--body`, repeated `--add-label`, and repeated `--remove-label` only for provided fields.
  - [x] Action: After edit, call `getIssue(number)` and return the normalized issue; if missing, throw `Updated issue #<number> was not found`.
  - [x] Validation: `test/github-issue-adapter.test.ts` asserts exact `gh` args for create/update, body argument usage, URL parsing, and post-mutation `getIssue` readback.

#### Phase Exit Gate
- [x] `npm run typecheck` passes after Phase 1.

#### Phase 2 - Autonomous Child Marker and Graph Validation
- [x] Objective: Make child membership and graph coherence deterministic before any planning runner writes issues.
- [x] Target: `src/runner/issue-tree.ts`
  - [x] Action: Create `renderAutonomousChildMarker(parentIssueNumber: number): string` returning exactly `<!-- codex-orchestrator:autonomous-child parent=#<parentIssueNumber> -->`.
  - [x] Action: Create `ensureAutonomousChildBody(body: string, parentIssueNumber: number): string` that puts the exact marker as the first line, removes duplicate existing `codex-orchestrator:autonomous-child` marker lines, and preserves the remaining body.
  - [x] Action: Create `isAutonomousChildOfParent(issue, config, parentIssueNumber): boolean`.
  - [x] Rule: `isAutonomousChildOfParent` returns `true` only when the issue has `config.github.labels.child.name` and its `body` contains the exact marker for that parent issue. It must ignore comments, issue links, project fields, milestone fields, title text, and generic `Parent issue: #<n>` prose.
  - [x] Action: Create planning graph types:
    - `PlanChildNode { stableId: string; issueNumber?: number; title: string; body: string; afkHitl: 'afk' | 'hitl'; ownershipScope: string[]; dependsOn: string[]; verification: string[] }`
    - `PlanDependencyEdge { from: string; to: string; reason: string }`
    - `PlanGraph { nodes: PlanChildNode[]; edges: PlanDependencyEdge[]; specGate: 'wave-level' }`
  - [x] Action: Create `validatePlanGraph(graph): { ok: true } | { ok: false; errors: string[] }`.
  - [x] Rule: Validation must reject empty `nodes`, duplicate `stableId`, graph edges that reference unknown nodes, `dependsOn` values that reference unknown nodes, self-dependencies, cycles, empty `ownershipScope`, empty `verification`, and any `specGate` other than `wave-level`.
  - [x] Rule: Validation must reject same-wave ownership overlap. Compute topological waves from dependencies, then reject two nodes in the same wave when any `ownershipScope` string is exactly equal after trimming.
  - [x] Validation: Add `test/issue-tree.test.ts` proving exact marker rendering, body normalization, membership requires both label and exact parent marker, arbitrary links/comments do not count, wrong parent marker does not count, valid DAG passes, unknown edges fail, cycles fail, empty ownership/verification fail, wrong spec gate fails, and same-wave ownership overlap fails.

#### Phase Exit Gate
- [x] `npm run typecheck` and `npm test` pass after Phase 2.

#### Phase 3 - Parent Planning Prompt and Report Schema
- [x] Objective: Make the Codex planning handoff deterministic and verifiable before GitHub writes.
- [x] Target: `src/runner/prompt.ts`
  - [x] Action: Add `PlanAutoPromptInput { parentIssue; config; prompts; promptPath; reportPath; branchName; worktreePath }` where `prompts` has exact keys `prd`, `issueBreakdown`, `breakdownReview`, and `triage`.
  - [x] Action: Add `buildPlanAutoPrompt(input): string`.
  - [x] Required prompt sections, in this exact order:
    - `# Codex Orchestrator Parent Planning`
    - `## Parent Issue Context` with parent issue number, title, URL, body, labels, and comments sorted by `createdAt`.
    - `## PRD Workflow` containing the project-local PRD prompt.
    - `## Issue Breakdown Workflow` containing the project-local issue breakdown prompt.
    - `## Breakdown Review Workflow` containing the project-local breakdown review prompt.
    - `## Triage Workflow` containing the project-local triage prompt.
    - `## Runner-Owned GitHub Contract` stating Codex must not create/edit GitHub issues, labels, comments, milestones, projects, branches, commits, pushes, PRs, merges, publishes, deploys, or execute child waves.
    - `## Autonomous Child Contract` stating every child must be represented in the JSON report, must use explicit marker plus parent reference, and arbitrary links/milestones/projects/comments do not grant membership.
    - `## Planning Report Contract` requiring JSON at `reportPath`.
  - [x] Action: Add `PlanAutoCompletionReport` with:
    - `status: 'completed'`
    - `parent: { title?: string; body: string }`
    - `graph: PlanGraph`
    - `residualRisks: string[]`
  - [x] Action: Add `readPlanAutoCompletionReport(reportPath)` returning `{ kind: 'missing' } | { kind: 'valid'; report: PlanAutoCompletionReport }`, throwing `Invalid plan-auto completion report: <reason>` for malformed reports.
  - [x] Rule: The report reader must call `validatePlanGraph`; graph validation errors make the report malformed.
  - [x] Rule: Do not silently repair malformed output. Missing/invalid data blocks the parent through the runner.
  - [x] Validation: `test/prompt-builder.test.ts` proves the plan prompt includes all four project-local prompt texts, parent context, runner-owned GitHub contract, autonomous child contract, report path, and exact planning report schema text. It also proves missing report behavior, malformed status rejection, graph validation rejection, and valid report parsing.

#### Phase Exit Gate
- [x] `npm run typecheck` and `npm test` pass after Phase 3.

#### Phase 4 - Parent Planning Runner
- [x] Objective: Claim one `agent:plan-auto` parent, run planning in an isolated issue-tree worktree, and apply runner-owned parent/child issue mutations only after a coherent report is proven.
- [x] Target: `src/runner/plan-auto-command.ts`
  - [x] Action: Create `PlanAutoCommandOptions { targetRoot: string; issueNumber: number; issueAdapter?: GitHubIssueAdapter; git?: GitWorktreeManager; codexAdapter?: { run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> }; now?: Date }`.
  - [x] Action: Create `PlanAutoCommandResult { parentIssueNumber; branchName; worktreePath; promptPath; reportPath; childIssues: GitHubIssue[]; status: 'planning-ready' | 'blocked'; reportComment: string }`.
  - [x] Action: Create `runPlanAutoCommand(options): Promise<PlanAutoCommandResult>`.
  - [x] Step order:
    1. Resolve `targetRoot` absolute path and load `<targetRoot>/.codex-orchestrator/config.json` through `validateConfig`.
    2. Instantiate default `GhCliIssueAdapter`, `GitWorktreeManager`, and `CodexCommandAdapter` only when fakes are not provided.
    3. Fetch parent issue with `issueAdapter.getIssue(issueNumber)`; if missing, throw `Issue #<issueNumber> was not found`.
    4. Run `discoverIssueWork([parentIssue], config)` and require one eligible decision with `mode === 'plan-parent'`; otherwise throw `Issue #<issueNumber> is not eligible for agent:plan-auto planning: <reason>`.
    5. Read project-local workflow prompt files from `config.workflows.prd.promptPath`, `config.workflows.issueBreakdown.promptPath`, `config.workflows.breakdownReview.promptPath`, and `config.workflows.triage.promptPath`. If any is missing, throw `Plan-auto workflow prompt not found at <path>` before any label mutation.
    6. Render `branchName` from `config.branches.issueTree` with `{ parentIssueNumber: issueNumber }`.
    7. Set `worktreePath` to `<targetRoot>/<config.runner.workspaceRoot>/tree-<issueNumber>`.
    8. Call `claimIssue(issueAdapter, config, issueNumber, 'plan-parent', now)`.
    9. After claim succeeds, wrap remaining handled failures so they call `finishPlanBlocked`.
    10. Create the issue-tree worktree from `config.branches.base`; this is for repository inspection only and must not be committed, pushed, or opened as a PR in #156.
    11. Create `sessionId = plan-<issueNumber>-<YYYYMMDDHHMMSS>` using `now`.
    12. Compute `promptPath` with existing `sessionPromptPath`, compute `reportPath` with existing `sessionReportPath`, and set `isolatedHomePath = <targetRoot>/<config.runner.stateDir>/codex-home/<sessionId>`.
    13. Write the durable planning prompt and create `dirname(reportPath)` plus `isolatedHomePath`.
    14. Store local run metadata with issue number, mode `plan-parent`, workspace path, session id, branch name, prompt path, report path, retry count `0`, createdAt, and updatedAt.
    15. Capture `beforeHead = git.getHead(worktreePath)`.
    16. Run the Codex adapter using `buildPlanAutoPrompt` text.
    17. Capture `afterHead`; if changed, block with `Planning session changed git HEAD; planning must not commit.`
    18. Call `git.listChangedFiles(worktreePath)`; if non-empty, block with `Planning session changed repository files; planning must return structured output only.`
    19. If Codex exits non-zero, block with `Codex exited with code <exitCode>: <stderr-or-stdout>`.
    20. Read the planning report. If missing, block with `Codex did not write CODEX_ORCHESTRATOR_REPORT_FILE; runner cannot prove planning graph.`
    21. If malformed or graph validation fails, block with the thrown `Invalid plan-auto completion report: ...` message.
    22. Update the parent issue through `issueAdapter.updateIssue(issueNumber, { title, body })`, using `parent.title` only when provided and always using `parent.body`.
    23. For each child node in topological order:
        - Build `childBody = ensureAutonomousChildBody(node.body, issueNumber)` and append a short runner-owned metadata section containing `AFK/HITL: <value>`, `Depends on: <stableIds or none>`, `Ownership: <ownershipScope list>`, `Spec gate: wave-level`, and `Verification: <verification list>`.
        - If `node.issueNumber` is present, fetch it with `getIssue`; require `isAutonomousChildOfParent(existingIssue, config, issueNumber)` before updating. If this check fails, block with `Existing issue #<n> is not an autonomous child of #<parent>; refusing to update arbitrary issue.`
        - For existing children, call `updateIssue(node.issueNumber, { title: node.title, body: childBody, addLabels })`.
        - For new children, call `createIssue({ title: node.title, body: childBody, labels })`.
        - `labels` and `addLabels` must include `config.github.labels.child.name`; include `config.github.labels.auto.name` only when `node.afkHitl === 'afk'` and the generated/readback issue body contains the exact marker for this parent.
        - Do not add `agent:auto` to `hitl` children.
    24. After every create/update, verify the returned child with `isAutonomousChildOfParent(returnedIssue, config, issueNumber)`. If false, block with `Child issue #<n> was not persisted with the autonomous marker for #<parent>.`
    25. Remove `agent:running`, add `agent:review`, and post one planning report comment beginning `codex-orchestrator planning report for #<parent>`.
    26. Planning report comment must include child issue numbers, dependency edges, ownership scopes, AFK/HITL classification, `Spec gate: wave-level`, verification expectations, skipped execution note `Child wave execution is out of scope for #156.`, and residual risks.
    27. Remove local run metadata with `RunnerStateStore.removeRun(issueNumber)` after the planning report comment succeeds.
  - [x] Action: Implement private `finishPlanBlocked`: remove `running`, add `blocked`, post one comment beginning `codex-orchestrator blocked parent planning for #<issueNumber>`, include reasons and residual risks when available, and return status `blocked`.
  - [x] Rule: No GitHub issue create/update may run until the planning report is fully parsed and the graph is coherent.
  - [x] Rule: If any child create/update fails after some prior child mutations succeeded, mark the parent blocked and include already-mutated child issue numbers in the blocked comment.
  - [x] Validation: Add `test/plan-auto-command.test.ts` proving:
    - happy path claims `agent:plan-auto`, creates an issue-tree worktree, sends all four workflow prompts to fake Codex, updates parent PRD, creates new marked children, adds `agent:child`, adds `agent:auto` only to AFK children, posts planning report, moves parent to `agent:review`, does not create commits/pushes/PRs, and removes local run metadata;
    - existing child update is allowed only when the issue already has `agent:child` plus exact parent marker;
    - an existing arbitrary linked issue number without marker blocks and is not updated;
    - malformed graph blocks with `agent:blocked` and creates/updates no child issues;
    - Codex worktree file changes block before issue mutations;
    - `hitl` children do not get `agent:auto`;
    - missing workflow prompt throws before claim and causes no mutations.

#### Phase Exit Gate
- [x] `npm run typecheck` and `npm test` pass after Phase 4.

#### Phase 5 - CLI Routing, Public Exports, and Docs
- [x] Objective: Expose parent planning through the existing CLI without adding a separate live runner or child execution flow.
- [x] Target: `src/cli.ts`
  - [x] Action: Keep the public command shape `codex-orchestrator run --target <path> --issue <number>`.
  - [x] Action: Replace direct `runScopedAutoCommand` dispatch with a small mode router that loads config, fetches the issue, calls `discoverIssueWork`, then dispatches `scoped-issue` to `runScopedAutoCommand` and `plan-parent` to `runPlanAutoCommand`.
  - [x] Rule: The router must preserve existing usage errors for missing/invalid `--target` and `--issue`.
  - [x] Rule: The router must not duplicate label state logic; `discoverIssueWork` remains the authorization source.
  - [x] Validation: `test/cli.test.ts` covers help text mentioning `agent:auto` and `agent:plan-auto`, invalid run args unchanged, and injected/fake mode routing at unit level if direct CLI injection is not practical.
- [x] Target: `src/index.ts`
  - [x] Action: Export `runPlanAutoCommand`, `PlanAutoCommandOptions`, `PlanAutoCommandResult`, `renderAutonomousChildMarker`, `ensureAutonomousChildBody`, `isAutonomousChildOfParent`, and `validatePlanGraph`.
  - [x] Validation: `test/public-api.test.ts` proves these exports are available from the package entrypoint.
- [x] Target: `README.md`
  - [x] Action: Update CLI section to state `run` executes one authorized issue in either scoped `agent:auto` mode or planning-only `agent:plan-auto` mode.
  - [x] Action: Document the explicit child marker and parent reference requirement.
  - [x] Action: Document that arbitrary links, milestones, projects, and comments do not authorize child membership.
  - [x] Action: Document that #156 creates/updates child issues but does not execute child waves, open integration PRs, auto-merge, publish, or run live autonomous loops.

#### Phase Exit Gate
- [x] `npm run typecheck`, `npm run build`, and `npm test` pass after Phase 5.

### Halt Conditions
- [x] Stop if `gh issue create/edit/view` local behavior contradicts the confirmed CLI contract above.
- [x] Stop if a child issue would receive `agent:auto` before the runner verifies both `agent:child` and exact parent marker on the persisted issue body.
- [x] Stop if implementation needs membership from links, milestones, projects, or comments to satisfy a test.
- [x] Stop if planning output requires heuristic repair to become a coherent graph.
- [x] Stop if the requested change expands into child wave execution, integration PR creation, auto-merge, npm publish, or live autonomous polling.

### Defect Closure Notes
- [x] Every `implementation-spec-review` defect is fixed or explicitly blocked with a concrete reason.

### 4. Validation & Done Criteria
- [x] **Lint/Format:** Not applicable; no lint script exists in `package.json`.
- [x] **Typecheck:** `npm run typecheck`
- [x] **Build:** `npm run build`
- [x] **Tests:** `npm test`
- [x] **Architecture Check:** Not applicable; this repository has no architecture-check script.
- [x] **Live/Manual Validation:** Not required and must not launch a live autonomous run for #156.
- [x] **Behavior Proof:** Automated tests prove parent claim, four-prompt handoff, parent update, marked child create/update, marker-gated inherited authorization, no arbitrary link/milestone/project/comment membership, coherent graph success, incoherent graph `agent:blocked`, and no child-wave execution.
- [x] **Post-Implementation Gate:** For this medium/large runtime change, run `$code-review`, then `$cleanup-review` in a dedicated subagent, after validation commands pass or any skipped validation is justified.
- [x] **Final Reconciliation:** all unchecked work is unfinished, blocked with a note, or intentionally not applicable.

### 5. Final Action
After saving the file, respond in chat with exactly:

Spec Status: Ready
Saved Path: docs/implementation-specs/2026-05-08/1930-agent-plan-auto-parent-planning.md
Execution Model: Single-Agent
Review Verdict: Approved
Validation Gates: Local / Tests
Blockers: None
