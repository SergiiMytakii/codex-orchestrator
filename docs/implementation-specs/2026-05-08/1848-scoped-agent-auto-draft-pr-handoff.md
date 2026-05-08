---
title: "Scoped agent:auto execution with draft PR handoff"
created_at: "2026-05-08T18:48:39+03:00"
source_type: "issue"
source_plan: "None"
source_issues:
  - "https://github.com/SergiiMytakii/IntelleReach/issues/151"
  - "https://github.com/SergiiMytakii/IntelleReach/issues/155"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_verdict: "Approved"
---

### 1. Execution Context
- **Goal:** Implement the first end-to-end scoped `agent:auto` runner path: claim one eligible issue, run Codex in an isolated worktree, safety-check the result, commit/push runner-owned changes, open one linked draft PR, and move the issue to `agent:review`.
- **Source Material:** Parent PRD #151, active child issue #155, #155 owner comment, completed prerequisite state-machine spec `docs/implementation-specs/2026-05-08/1812-github-issue-state-machine-local-runner-recovery.md`, current `main` in `/Users/serhiimytakii/Projects/codex-orchestrator`.
- **Approved Scope:** One scoped issue execution path for `agent:auto`; branch/worktree creation; configured Codex command adapter; durable prompt file; safety validation; runner-owned commit/push; fake GitHub draft PR adapter; review report; documented promotion stop path.
- **Out of Scope:** Parent issue-tree orchestration, parallel child waves, auto-merge, npm publish, production deploy/release, live GitHub validation as a required test, non-GitHub trackers, non-Codex agent support beyond keeping the adapter boundary.
- **Simplest Viable Path:** Add one `run --target <path> --issue <number>` CLI path backed by small git, Codex command, safety, PR, prompt, and scoped-runner modules. Reuse the existing issue state machine and local state store instead of creating a second state owner.
- **Primary Risk:** Accidentally letting Codex own publication or crossing safety boundaries. The runner must be the only owner of commit, push, PR creation, label handoff, and final report.

### 2. Preconditions & Evidence
- **Required Services / Env / Fixtures:** Node.js `>=18`; npm dependencies installed; `git` CLI available for worktree tests; local `gh` CLI credentials only for real adapter usage; automated tests must use temp git repositories, a local bare remote, fake Codex commands, in-memory issue adapters, and fake PR adapters.
- **Blocking Unknowns:** None.
- **Confirmed Targets:**
  - Current CLI entrypoint: `src/cli.ts`.
  - Current package exports: `src/index.ts`.
  - Current config contract: `src/config/schema.ts`, `src/setup/project-config.ts`, `test/fixtures/config.ts`.
  - Current issue adapter contracts and fake: `src/github/issues.ts`, `src/github/gh-issue-adapter.ts`.
  - Current issue state functions: `claimIssue`, `discoverIssueWork`, `applyClarificationGate` in `src/runner/issue-state-machine.ts`.
  - Current local metadata store: `src/runner/local-state.ts`.
  - Current status/recovery modules: `src/runner/status-command.ts`, `src/runner/recovery.ts`.
  - Current test runner style: `node:test` tests under `test/`; `npm test` builds then runs `dist/test/**/*.test.js`.
  - Existing commands: `npm run typecheck`, `npm run build`, `npm test`, `npm pack --dry-run`.
- **Confirmed External CLI Contract:** Local `codex --version` reports `codex-cli 0.129.0-alpha.15`. Local `codex exec --help` shows `codex exec [OPTIONS] [PROMPT]`, `--cd <DIR>`, `--sandbox <SANDBOX_MODE>`, `--ignore-user-config`, and `-` for reading instructions from stdin. It does **not** support `--ask-for-approval`; do not configure that flag.
- **Protected Paths / Rejected Approaches:** Do not read `.env*` or other configured secret files. Do not add auto-merge. Do not let Codex commit, push, open PRs, or publish. Do not require live GitHub for automated tests. Do not implement parent tree planning, child wave execution, npm publishing, or production deploy/release.

### Risk Controls
- **Source of Truth:** GitHub labels/comments/PRs remain the public source of truth for issue state; local state stores only process metadata; git branch/worktree state is owned by the runner.
- **Safety Constraints:** Runner must reject configured secret file changes, missing or malformed completion reports, reported secret file reads/changes, reported destructive database/cache actions, reported production deploy/release actions, and agent-owned git commits before PR creation.
- **Contract Constraints:** GitHub issue/PR operations go through fakeable adapters; Codex execution goes through a fakeable command adapter; CLI behavior is proven through public command tests.
- **Concurrency / State Constraints:** #155 implements one scoped issue at a time. Existing branches/worktree paths for the same issue are hard stops unless recovery explicitly handles them in a later issue.
- **Forbidden Scope:** No auto-merge, no Codex-owned publication, no live-only verification, no issue-tree orchestration, no cleanup of unrelated local worktrees, no compatibility shim that silently accepts unsafe config.

| Behavior / Data | Owner | Readers / Projections | Non-Owners |
|-----------------|-------|-----------------------|------------|
| Issue claim/review/block state | GitHub labels/comments through `GitHubIssueAdapter` | Runner, recovery, status output | Local state file |
| Branch/worktree creation | Runner git module | Scoped runner, tests | Codex command |
| Commit/push/PR creation | Runner git module and PR adapter | GitHub issue report, tests | Codex command |
| Durable prompt/report files | Runner prompt/session module under configured state dir | Codex adapter via stdin/env, final report builder | Git-tracked project files |
| Safety decision | `src/runner/safety.ts` | Scoped runner, tests | Prompt text alone |

### Write Scope Summary
- `src/config/schema.ts` - Update config contract for Codex command args and base branch; validate exact shapes.
- `src/setup/project-config.ts` - Update generated defaults for Codex command, base branch, and prompt/report env behavior.
- `src/github/issues.ts` - Add issue `body` support to issue contracts and fake fixtures.
- `src/github/gh-issue-adapter.ts` - Request/normalize issue `body`.
- `src/github/pull-requests.ts` - Create fakeable PR adapter contract and in-memory adapter.
- `src/github/gh-pull-request-adapter.ts` - Create `gh pr create` adapter.
- `src/process/command.ts` - Create process executor with cwd/env/stdin support for git, checks, and Codex command execution.
- `src/git/worktree.ts` - Create git worktree/branch/status/commit/push helper.
- `src/codex/command-adapter.ts` - Create configured Codex command adapter with a scrubbed environment.
- `src/runner/prompt.ts` - Create durable prompt and report-path builder.
- `src/runner/safety.ts` - Create safety validation for changed paths, required report flags, and agent-owned git publication.
- `src/runner/scoped-auto-command.ts` - Create the end-to-end scoped `agent:auto` orchestration path.
- `src/runner/local-state.ts` - Extend process metadata with branch/prompt/report paths without storing issue snapshots.
- `src/cli.ts` - Add `run --target <path> --issue <number>` help/parser/dispatch.
- `src/index.ts` - Export new public contracts needed by tests/adopters.
- `README.md` - Document the scoped run command, runner-owned publication, fake-testable adapters, and safety limits.
- `test/**` - Add focused tests for config, issue body, PR adapter, git worktree, Codex command, prompt, safety, scoped run, CLI, and public exports.

### 3. Execution Phases

#### Progress Discipline
- [ ] Update this checklist as work is completed.
- [ ] Leave blocked work unchecked with a short `Blocked:` note.
- [ ] Stop if repo reality contradicts a confirmed target, command, precondition, or scope boundary.
- [ ] Stop if implementation requires auto-merge, live GitHub-only validation, Codex-owned commit/push/PR creation, issue-tree orchestration, npm publish, secret file reads, destructive database/cache actions, or production deploy/release.

#### Phase 1 - Config, Issue Body, and PR Adapter Contracts
- [ ] Objective: Extend public contracts needed for scoped execution before orchestration code exists.
- [ ] Target: `src/config/schema.ts`
  - [ ] Action: Extend `CodexOrchestratorConfig.codex` to:
    - `adapter: 'codex-cli'`
    - `command: string`
    - `args: string[]`
    - `promptFileEnv: 'CODEX_ORCHESTRATOR_PROMPT_FILE'`
    - `reportFileEnv: 'CODEX_ORCHESTRATOR_REPORT_FILE'`
  - [ ] Action: Extend `CodexOrchestratorConfig.branches` with `base: string`.
  - [ ] Rule: `validateConfig` must require `codex.command` to be a non-empty string, `codex.args` to be a string array, exact env literals above, and `branches.base` to be a non-empty string.
  - [ ] Validation: `test/config-schema.test.ts` covers accepted defaults plus rejection of empty command, non-array args, wrong prompt/report env literals, and missing base branch.
- [ ] Target: `src/setup/project-config.ts`
  - [ ] Action: Update `buildProjectConfig` defaults:
    - `codex.command = 'codex'`
    - `codex.args = ['exec', '--cd', '${worktreePath}', '--sandbox', 'workspace-write', '--ignore-user-config', '-']`
    - `codex.promptFileEnv = 'CODEX_ORCHESTRATOR_PROMPT_FILE'`
    - `codex.reportFileEnv = 'CODEX_ORCHESTRATOR_REPORT_FILE'`
    - `branches.base = 'main'`
  - [ ] Action: Update setup output to include the Codex command and base branch without implying Codex launches during setup.
  - [ ] Validation: Existing setup tests are updated for the new output/config shape.
- [ ] Target: `src/github/issues.ts`
  - [ ] Action: Add `body: string` to `GitHubIssue`.
  - [ ] Action: Update `InMemoryGitHubIssueAdapter` cloning to preserve `body`.
  - [ ] Validation: `test/github-issue-adapter.test.ts` and `test/fixtures/issues.ts` cover issue body round-trip.
- [ ] Target: `src/github/gh-issue-adapter.ts`
  - [ ] Action: Change `issueJsonFields` to `number,title,body,url,state,labels,comments,closedByPullRequestsReferences`.
  - [ ] Action: Normalize missing or non-string `body` as an error with message `GitHub issue payload body must be a string`.
  - [ ] Validation: `test/github-issue-adapter.test.ts` asserts exact `gh issue list/view --json` fields include `body`.
- [ ] Target: `src/github/pull-requests.ts`
  - [ ] Action: Create `GitHubPullRequest { number: number; url: string; isDraft: boolean; headRefName: string; baseRefName: string }`.
  - [ ] Action: Create `CreateDraftPullRequestInput { title: string; body: string; headBranch: string; baseBranch: string }`.
  - [ ] Action: Create `GitHubPullRequestAdapter` with `createDraftPullRequest(input): Promise<GitHubPullRequest>`.
  - [ ] Action: Create `InMemoryGitHubPullRequestAdapter(owner = 'SergiiMytakii', repo = 'IntelleReach')` that records every input in `createdPullRequests` and returns deterministic URLs `https://github.com/<owner>/<repo>/pull/<n>`.
  - [ ] Validation: `test/pull-request-adapter.test.ts` proves fake adapter records one draft request and returns `isDraft: true`.
- [ ] Target: `src/github/gh-pull-request-adapter.ts`
  - [ ] Action: Create `GhCliPullRequestAdapter(owner, repo, executor = defaultGhExecutor)` implementing `GitHubPullRequestAdapter`.
  - [ ] Action: Run exactly `gh pr create --repo <owner>/<repo> --base <baseBranch> --head <headBranch> --title <title> --body <body> --draft`.
  - [ ] Action: Parse stdout as a PR URL and extract the trailing `/pull/<number>` number; throw `gh pr create did not return a pull request URL` if parsing fails.
  - [ ] Validation: `test/pull-request-adapter.test.ts` asserts exact command arguments and URL parsing.

#### Phase Exit Gate
- [ ] `npm run typecheck` passes after Phase 1.

#### Phase 2 - Process, Git Worktree, and Codex Command Boundaries
- [ ] Objective: Build fakeable command boundaries for git, checks, and Codex without publishing anything yet.
- [ ] Target: `src/process/command.ts`
  - [ ] Action: Create `ProcessCommandOptions { cwd?: string; env?: Record<string, string>; stdin?: string }`.
  - [ ] Action: Create `ProcessCommandResult { stdout: string; stderr: string; exitCode: number }`.
  - [ ] Action: Create `ProcessExecutor = (file: string, args: string[], options?: ProcessCommandOptions) => Promise<ProcessCommandResult>`.
  - [ ] Action: Create `defaultProcessExecutor` using `spawn`, capturing stdout/stderr, writing `stdin` when provided, and resolving for every exit code instead of throwing.
  - [ ] Action: Create `ShellCommandExecutor = (command: string, options?: ProcessCommandOptions) => Promise<ProcessCommandResult>`.
  - [ ] Action: Create `defaultShellCommandExecutor` using `spawn(command, { shell: true, cwd, env })`, capturing stdout/stderr, writing `stdin` when provided, and resolving for every exit code instead of throwing.
  - [ ] Rule: Callers decide which non-zero exits are errors so tests can assert failure reports without process exceptions hiding stdout/stderr.
  - [ ] Validation: `test/process-command.test.ts` proves cwd, env, stdin, stdout, stderr, shell command execution, and non-zero exit capture.
- [ ] Target: `src/git/worktree.ts`
  - [ ] Action: Create `GitWorktreeManager` using `ProcessExecutor`.
  - [ ] Action: Export `renderBranchTemplate(template, values)` supporting `${issueNumber}` and `${parentIssueNumber}` placeholders; for #155 scoped execution uses only `${issueNumber}`.
  - [ ] Action: Export methods:
    - `getHead(worktreePath): Promise<string>` via `git -C <path> rev-parse HEAD`.
    - `createIssueWorktree({ targetRoot, workspacePath, branchName, baseBranch })` via `git -C <targetRoot> worktree add -b <branchName> <workspacePath> <baseBranch>`.
    - `listChangedFiles(worktreePath): Promise<string[]>` via `git -C <worktreePath> status --porcelain=v1 -z`.
    - `commitAll({ worktreePath, message })` via `git -C <worktreePath> add --all` then `git -C <worktreePath> -c user.name=codex-orchestrator -c user.email=codex-orchestrator@users.noreply.github.com commit -m <message>`.
    - `pushBranch({ worktreePath, branchName })` via `git -C <worktreePath> push -u origin <branchName>`.
  - [ ] Rule: `createIssueWorktree` must create `dirname(workspacePath)` recursively before running `git worktree add`.
  - [ ] Rule: `listChangedFiles` must parse NUL-delimited porcelain records and return normalized relative paths. For rename records, return both old and new paths.
  - [ ] Rule: Any git command returning non-zero exit code must throw `git command failed: git <args>` including stderr in the error message.
  - [ ] Validation: `test/worktree-manager.test.ts` creates a temp repo with `main`, a local bare `origin`, creates `codex/issue-155`, writes a file in the worktree, commits, pushes to the bare remote, and verifies the pushed branch contains the runner commit.
- [ ] Target: `src/codex/command-adapter.ts`
  - [ ] Action: Create `CodexCommandRunInput { targetRoot; config; worktreePath; promptPath; promptText; reportPath; isolatedHomePath; issueNumber; sessionId; branchName }`.
  - [ ] Action: Create `CodexCommandRunResult { exitCode; stdout; stderr }`.
  - [ ] Action: Create `CodexCommandAdapter(config, executor = defaultProcessExecutor)` with `run(input)`.
  - [ ] Rule: Render placeholders in `config.codex.args`: `${worktreePath}`, `${promptFile}`, `${promptPath}`, `${reportFile}`, `${reportPath}`, `${issueNumber}`, `${sessionId}`, `${branchName}`.
  - [ ] Rule: Invoke `config.codex.command` with rendered args, cwd set to `worktreePath`, stdin set to `promptText`, and env built by `buildCodexProcessEnv(input, process.env)`.
  - [ ] Action: Create `buildCodexProcessEnv(input, sourceEnv)` in `src/codex/command-adapter.ts`.
  - [ ] Rule: `buildCodexProcessEnv` must never inherit `process.env` wholesale. It may copy only `PATH`, `CODEX_HOME`, `LANG`, `LC_ALL`, and `TMPDIR` from `sourceEnv` when present; it must set `HOME` to `isolatedHomePath`; it must add configured prompt/report env names pointing to `promptPath` and `reportPath`.
  - [ ] Rule: `buildCodexProcessEnv` must drop GitHub and SSH auth variables, including `GH_TOKEN`, `GITHUB_TOKEN`, `GITHUB_API_TOKEN`, `SSH_AUTH_SOCK`, `GIT_ASKPASS`, `GIT_SSH`, and `GIT_SSH_COMMAND`. If Codex cannot authenticate without these variables, the Codex command exits non-zero and the runner blocks without commit/push/PR.
  - [ ] Rule: Do not commit, push, or open PRs from this adapter.
  - [ ] Validation: `test/codex-command-adapter.test.ts` uses a fake executable that writes one controlled source file and a JSON report, then asserts stdin contained the durable prompt, env contained durable prompt/report paths, `PATH`/`CODEX_HOME` may be retained, `HOME` is the isolated session home, and GitHub/SSH auth env vars are absent.

#### Phase Exit Gate
- [ ] `npm run typecheck` and `npm test` pass after Phase 2.

#### Phase 3 - Prompt, Report, and Safety Contracts
- [ ] Objective: Make the Codex handoff deterministic and enforce runner safety before commit/push/PR.
- [ ] Target: `src/runner/local-state.ts`
  - [ ] Action: Extend `RunnerProcessMetadata` allowed keys with optional `branchName`, `promptPath`, and `reportPath`.
  - [ ] Rule: Continue rejecting issue bodies, comments, labels, questions, answers, PR links, and GitHub snapshots in local state.
  - [ ] Validation: `test/local-state.test.ts` proves the new keys are accepted and forbidden GitHub-derived keys still reject.
- [ ] Target: `src/runner/prompt.ts`
  - [ ] Action: Create `ScopedPromptInput { issue; config; workflowPromptText; promptPath; reportPath; branchName; worktreePath }`.
  - [ ] Action: Create `buildScopedImplementationPrompt(input): string`.
  - [ ] Required prompt sections, in this exact order:
    - `# Codex Orchestrator Scoped Implementation`
    - `## Issue Context` with issue number, title, URL, body, labels, and comments sorted by `createdAt`.
    - `## Project Workflow` containing `workflowPromptText`.
    - `## Runner-Owned Publication Contract` stating Codex must change files only, must not commit, push, open PRs, merge, publish, deploy, or edit GitHub labels/comments.
    - `## Safety Contract` stating Codex must not read or modify configured secret file patterns, must not run destructive database/cache actions, and must not run production deploy/release actions.
    - `## Completion Report Contract` requiring JSON at `reportPath` with the schema below.
  - [ ] Action: Create `ScopedCompletionReport` type:
    - `status: 'completed' | 'needs-promotion'`
    - `changes: string[]`
    - `validation: Array<{ command: string; status: 'passed' | 'failed' | 'skipped'; summary: string }>`
    - `skippedChecks: string[]`
    - `residualRisks: string[]`
    - `prohibitedActions: Array<{ type: 'secret-file-read' | 'secret-file-change' | 'destructive-db-or-cache' | 'production-deploy-or-release'; description: string }>`
    - optional `promotion: { reason: string; criteria: string[]; evidence: string[] }`
  - [ ] Action: Create `readScopedCompletionReport(reportPath)` returning a discriminated result `{ kind: 'missing' } | { kind: 'valid'; report: ScopedCompletionReport }`, and throwing `Invalid scoped completion report: <reason>` for malformed reports.
  - [ ] Rule: `status: 'needs-promotion'` requires non-empty `promotion.reason`, `promotion.criteria`, and `promotion.evidence`; otherwise the report is malformed.
  - [ ] Action: Create `writeDurablePrompt({ targetRoot, config, issueNumber, sessionId, promptText })` that writes to `<targetRoot>/<config.runner.stateDir>/prompts/issue-<issueNumber>-<sessionId>.md`.
  - [ ] Action: Create `sessionReportPath({ targetRoot, config, issueNumber, sessionId })` returning `<targetRoot>/<config.runner.stateDir>/reports/issue-<issueNumber>-<sessionId>.json`.
  - [ ] Validation: `test/prompt-builder.test.ts` proves prompt ordering, issue body/comment inclusion, workflow inclusion, publication/safety contract text, report schema text, durable prompt path, and report path.
- [ ] Target: `src/runner/safety.ts`
  - [ ] Action: Create `SafetyViolationCode = 'secret-file-change' | 'secret-file-read' | 'destructive-db-or-cache' | 'production-deploy-or-release' | 'agent-owned-git-publication'`.
  - [ ] Action: Create `SafetyViolation { code: SafetyViolationCode; message: string }`.
  - [ ] Action: Create `validateChangedPaths(paths, config): SafetyViolation[]`.
  - [ ] Rule: Match `config.deny.secretFiles` and `config.deny.additionalPathGlobs` against normalized relative changed paths. Implement deterministic glob support only for exact literals, `*` within one path segment, and `**` across path segments. Document this in the function docblock.
  - [ ] Action: Create `validateCompletionReportSafety(report): SafetyViolation[]`; malformed and missing reports are handled before this function.
  - [ ] Rule: Any `prohibitedActions` item maps to the same code as its `type`; if `type` is `secret-file-change`, also treat it as a secret path safety failure.
  - [ ] Action: Create `validateNoAgentOwnedGitPublication(beforeHead, afterHead): SafetyViolation[]`.
  - [ ] Rule: If Codex changed `HEAD`, return `agent-owned-git-publication` with message `Codex changed git HEAD; runner-owned publication was violated`.
  - [ ] Validation: `test/safety.test.ts` covers `.env`, `.env.local`, nested `**`, non-secret source changes, all prohibited action types, and changed `HEAD` rejection.

#### Phase Exit Gate
- [ ] `npm run typecheck` and `npm test` pass after Phase 3.

#### Phase 4 - Scoped agent:auto Runner
- [ ] Objective: Orchestrate one eligible scoped issue from claim through draft PR handoff.
- [ ] Target: `src/runner/scoped-auto-command.ts`
  - [ ] Action: Create `ScopedAutoCommandOptions { targetRoot: string; issueNumber: number; issueAdapter?: GitHubIssueAdapter; pullRequestAdapter?: GitHubPullRequestAdapter; git?: GitWorktreeManager; codexAdapter?: CodexCommandAdapter; shellExecutor?: ShellCommandExecutor; now?: Date }`.
  - [ ] Action: Create `ScopedAutoCommandResult { issueNumber; branchName; worktreePath; promptPath; reportPath; pullRequest?: GitHubPullRequest; status: 'review-ready' | 'blocked' | 'promotion-requested'; reportComment: string }`.
  - [ ] Action: Create `runScopedAutoCommand(options): Promise<ScopedAutoCommandResult>`.
  - [ ] Step order:
    1. Resolve `targetRoot` absolute path and load `<targetRoot>/.codex-orchestrator/config.json` through existing `validateConfig`.
    2. Instantiate default `GhCliIssueAdapter`, `GhCliPullRequestAdapter`, `GitWorktreeManager`, and `CodexCommandAdapter` only when fakes are not provided.
    3. Fetch the issue with `issueAdapter.getIssue(issueNumber)`; if missing, throw `Issue #<issueNumber> was not found`.
    4. Run `discoverIssueWork([issue], config)` and require one eligible decision with `mode === 'scoped-issue'`; otherwise throw `Issue #<issueNumber> is not eligible for scoped agent:auto execution: <reason>`.
    5. Render `branchName` from `config.branches.scopedIssue` with `${issueNumber}`.
    6. Set `worktreePath` to `<targetRoot>/<config.runner.workspaceRoot>/issue-<issueNumber>`.
    7. Read workflow prompt text from `<targetRoot>/<config.workflows.scopedImplementation.promptPath>`. If missing, throw `Scoped implementation workflow prompt not found at <path>` before any label mutation.
    8. Call existing `claimIssue(issueAdapter, config, issueNumber, 'scoped-issue', now)`.
    9. After the claim succeeds, wrap the remaining steps so every handled runner failure calls `finishBlocked` before returning; only process crashes may leave recovery to #154 behavior.
    10. Create the worktree from `config.branches.base`.
    11. Create `sessionId = issue-<issueNumber>-<YYYYMMDDHHMMSS>` using `now`.
    12. Build and write the durable prompt; compute the report path and `isolatedHomePath = <targetRoot>/<config.runner.stateDir>/codex-home/<sessionId>`.
    12a. Create `dirname(reportPath)` and `isolatedHomePath` recursively before running Codex.
    13. Store local run metadata with issue number, mode `scoped-issue`, workspace path, session id, branch name, prompt path, report path, retry count `0`, createdAt, and updatedAt.
    14. Capture `beforeHead` from the worktree.
    15. Run the Codex adapter with scrubbed env and isolated `HOME`.
    16. Capture `afterHead`; reject if Codex changed `HEAD`.
    17. Read the completion report.
    18. If Codex exits non-zero, mark blocked through `finishBlocked` and do not commit/push/open PR.
    19. If the completion report is missing or malformed, call `finishBlocked` and do not commit/push/open PR. Missing report reason must be `Codex did not write CODEX_ORCHESTRATOR_REPORT_FILE; runner cannot prove safety contract.`
    20. If report status is `needs-promotion`, call `finishPromotionRequested` and do not commit/push/open PR.
    21. List changed files; reject if there are no changed files with blocked report `Codex completed without file changes`.
    22. Run safety validation for changed paths and completion report; on any violation call `finishBlocked` and do not commit/push/open PR.
    23. Run configured checks from `config.checks` in insertion order through `defaultShellCommandExecutor` or an injected shell executor in the worktree; collect pass/fail summaries without stopping PR creation for failed checks.
    24. Commit all changes with message `Codex: implement issue #<issueNumber>`.
    25. Push the branch to `origin`.
    26. Create one draft PR with title rendered from `config.pullRequests.scopedIssueTitle`, base `config.branches.base`, head `branchName`, and body containing `Closes #<issueNumber>`.
    27. Remove `agent:running`, add `agent:review`, and post one review report comment.
    28. Remove the local run metadata with `RunnerStateStore.removeRun(issueNumber)` after the review comment succeeds.
  - [ ] Action: Implement `finishBlocked` inside the module or as a private helper: remove `running`, add `blocked`, post one comment beginning `codex-orchestrator blocked scoped execution for #<issueNumber>`, include reasons, changed files when safe to list, validation run so far, skipped checks, residual risks, and return status `blocked`.
  - [ ] Action: Implement `finishPromotionRequested`: remove `running`, add `blocked`, post one comment beginning `codex-orchestrator promotion requested for #<issueNumber>`, include promotion reason, criteria, evidence, and exact maintainer instruction `Review this evidence and replace agent:auto with agent:plan-auto when parent issue-tree orchestration is desired.` Return status `promotion-requested`.
  - [ ] Review report format must have these headings in order:
    - `codex-orchestrator review report for #<issueNumber>`
    - `Pull Request`
    - `Changes`
    - `Validation`
    - `Skipped Checks`
    - `Residual Risks`
  - [ ] Rule: A missing completion report is fatal before commit/push/PR because the runner cannot prove destructive database/cache, production deploy/release, secret-read, or agent-owned publication safety from git status alone.
  - [ ] Rule: A malformed completion report is fatal and uses `finishBlocked`.
  - [ ] Rule: Failed configured checks do not block the draft PR; they appear in `Validation` and add residual risk `One or more configured checks failed.`
  - [ ] Validation: `test/scoped-auto-command.test.ts` proves the happy path with a fake Codex executable writing a controlled source change and completion report in a temp git repo with local bare remote. It must verify branch name, worktree path, prompt file contents, fake command stdin/env, runner-created workspaces/reports/codex-home directories from an initially missing directory state, runner-owned commit author/message, pushed branch, one draft PR request, `Closes #<issueNumber>` in PR body, `running` removed, `review` added, review comment headings, validation lines, skipped checks, residual risks, and local run metadata removed after success.
- [ ] Target: `src/runner/scoped-auto-command.ts`
  - [ ] Validation: Add tests in `test/scoped-auto-command.test.ts` for:
    - ineligible issue with `agent:manual` throws before claim and makes no mutations;
    - missing workflow prompt throws before claim and makes no mutations;
    - fake Codex non-zero exit marks issue blocked and creates no commit, push, or PR;
    - fake Codex report `needs-promotion` marks issue blocked with promotion instructions and creates no commit, push, or PR;
    - fake Codex missing report blocks and creates no commit, push, or PR;
    - fake Codex `needs-promotion` without complete promotion reason/criteria/evidence blocks as malformed report;
    - fake Codex creates `.env.local`, runner blocks and creates no commit, push, or PR;
    - fake Codex makes its own git commit, runner blocks as `agent-owned-git-publication`;
    - malformed report blocks;
    - failed configured check still opens a draft PR and records residual risk.

#### Phase Exit Gate
- [ ] `npm run typecheck` and `npm test` pass after Phase 4.

#### Phase 5 - CLI, Public API, Docs, and Packaging Proof
- [ ] Objective: Expose scoped execution as a package command and document the safety/publication contract.
- [ ] Target: `src/cli.ts`
  - [ ] Action: Add help text for `codex-orchestrator run --target <path> --issue <number>`.
  - [ ] Action: Add parser support for command `run`.
  - [ ] Rule: Missing `--target` returns exit code `2` and stderr `run requires --target <path>`.
  - [ ] Rule: Missing `--issue` returns exit code `2` and stderr `run requires --issue <number>`.
  - [ ] Rule: Non-integer or less-than-1 issue values return exit code `2` and stderr `run requires --issue <number>`.
  - [ ] Rule: Unknown run flags return exit code `2` and stderr `Unknown run option: <flag>`.
  - [ ] Rule: On success, stdout is the `reportComment` followed by a newline and exit code `0`.
  - [ ] Rule: On thrown runtime error, stderr is the error message and exit code `1`.
  - [ ] Validation: `test/cli.test.ts` covers help, missing target, missing issue, invalid issue, unknown run option, and a run smoke using fake `gh`, fake Codex command, and temp git repo.
- [ ] Target: `src/index.ts`
  - [ ] Action: Export `runScopedAutoCommand`, `ScopedAutoCommandOptions`, `ScopedAutoCommandResult`, `GitHubPullRequestAdapter`, `InMemoryGitHubPullRequestAdapter`, `GitHubPullRequest`, `CreateDraftPullRequestInput`, `GitWorktreeManager`, `CodexCommandAdapter`, `buildScopedImplementationPrompt`, `readScopedCompletionReport`, safety types/functions needed by tests.
  - [ ] Validation: `test/public-api.test.ts` imports new exports from `../src/index.js`.
- [ ] Target: `README.md`
  - [ ] Action: Document `codex-orchestrator run --target <path> --issue <number>`.
  - [ ] Action: State that setup/status do not launch Codex, while `run` mutates GitHub labels/comments, creates a worktree/branch, runs the configured Codex command, commits/pushes runner-owned changes, and opens a draft PR.
  - [ ] Action: State safety boundaries exactly: runner rejects configured secret file changes, reported secret file reads/changes, reported destructive database/cache actions, reported production deploy/release actions, and Codex-owned git commits; runner never auto-merges.
  - [ ] Action: State automated tests use fake GitHub/fake Codex/temp git repositories and live GitHub validation is optional.
  - [ ] Validation: README command docs match CLI help.

#### Phase Exit Gate
- [ ] `npm run typecheck`, `npm run build`, `npm test`, and `npm pack --dry-run` pass after Phase 5.

### 4. Acceptance Criteria Mapping
| #155 Acceptance Criterion | Required Implementation Proof |
|---------------------------|-------------------------------|
| A scoped `agent:auto` issue can be claimed and moved to running state. | `runScopedAutoCommand` happy-path test verifies `claimIssue` mutation/comment before Codex execution. |
| Runner creates a dedicated branch and worktree for the issue. | `test/worktree-manager.test.ts` and happy-path scoped test verify `codex/issue-<n>` branch and `<workspaceRoot>/issue-<n>` worktree. |
| Configured Codex adapter command receives durable prompt containing issue context, project workflow, and completion contract. | `test/codex-command-adapter.test.ts` and `test/prompt-builder.test.ts` verify prompt file, stdin, env paths, issue body/comments, workflow text, and completion contract. |
| Runner refuses secret file changes, destructive database/cache actions, and production deploy/release actions. | `test/safety.test.ts` plus scoped blocked-path tests verify no commit/push/PR after matching secret changes or prohibited action reports. |
| Codex file changes are committed and published by runner, not by agent-owned publication. | Happy-path scoped test verifies runner commit author/message and PR adapter request; agent-owned commit test blocks before PR. |
| Runner opens one draft pull request linked to the issue. | Fake PR adapter test verifies exactly one `isDraft: true` request and PR body contains `Closes #<issueNumber>`. |
| Issue is marked `agent:review` with report of changes, validation, skipped checks, and residual risks. | Happy-path scoped test verifies `running` removed, `review` added, and report comment headings/content. |
| If task proves too large, runner can stop scoped execution and trigger documented promotion path. | `needs-promotion` report test verifies no commit/push/PR, issue blocked, and promotion instruction comment. |

### 5. Validation & Done Criteria
- [ ] **Lint/Format:** Not applicable; repository has no lint script.
- [ ] **Typecheck:** `npm run typecheck`
- [ ] **Build:** `npm run build`
- [ ] **Tests:** `npm test`
- [ ] **Package Check:** `npm pack --dry-run`
- [ ] **Architecture Check:** Not applicable; repository has no architecture script.
- [ ] **Live/Manual Validation:** Optional only: run against a non-destructive fixture issue after maintainer approval. Completion does not require live GitHub because fake adapters and temp git repos cover the contract.
- [ ] **Behavior Proof:** Fake Codex adapter writes a controlled change in a temp git repo; tests verify branch, worktree, runner commit, push to local bare remote, draft PR request, labels, review report, safety refusal, and promotion stop path.
- [ ] **Post-Implementation Review:** Because this is a medium/large runtime change, executor must run `$code-review`, then `$cleanup-review` in a dedicated subagent, then reconcile fixes before final response.
- [ ] **Final Reconciliation:** all unchecked work is unfinished, blocked with a note, or intentionally not applicable.

### Halt Conditions
- [ ] A required target file, symbol, command, fixture, or adapter differs from confirmed repo evidence.
- [ ] The implementation cannot prove the scoped happy path without live GitHub.
- [ ] The implementation would let Codex commit, push, open PRs, change labels/comments, auto-merge, publish, or deploy.
- [ ] The implementation would need to read secret files or inspect file contents only to detect configured secret changes.
- [ ] Safety violations cannot stop before runner commit/push/PR.
- [ ] The issue-tree promotion path requires implementing #156 or #157 behavior.
- [ ] Existing local state would need to store issue bodies, comments, labels, PR links, or GitHub snapshots.
- [ ] Existing branch/worktree conflicts would require destructive cleanup not approved by #155.

### Defect Closure Notes
- [ ] Implementation-spec-review initially rejected the spec because of an invalid Codex CLI flag, weak safety proof for missing reports, ambiguous Codex environment inheritance, incomplete promotion validation, and premature approval markers.
- [ ] Revised spec removed `--ask-for-approval`, made completion reports mandatory before commit/push/PR, defined a scrubbed Codex environment, required complete promotion evidence, and reset the review verdict pending re-review.
- [ ] Re-review found missing preflight directory creation; revised spec requires worktree parent, report parent, and isolated Codex home directory creation before use.

### 6. Final Action
After saving the file, respond in chat with exactly:

Spec Status: Ready
Saved Path: docs/implementation-specs/2026-05-08/1848-scoped-agent-auto-draft-pr-handoff.md
Execution Model: Single-Agent
Review Verdict: Approved
Validation Gates: Local / Tests
Blockers: None
