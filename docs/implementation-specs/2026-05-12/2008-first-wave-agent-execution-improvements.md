---
title: "Wave 1 agent execution improvements"
created_at: "2026-05-12T20:08:08+03:00"
source_type: "wave"
source_plan: "None"
source_issues:
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/11"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/12"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/15"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/16"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_verdict: "Approved"
---

## 1. Execution Context
- **Goal:** Implement the first wave of #11 by adding one full session change-set source of truth, durable Codex stream logs with idle timeout, and centralized structured completion/prompt-safety validation.
- **Source Material:** Parent PRD #11 and child issues #12, #15, #16 with owner comments; current repository at `/Users/serhiimytakii/Projects/codex-orchestrator`; `AGENTS.md`; `package.json`; `README.md`; current `src/**` and `test/**` evidence inspected before this spec.
- **Approved Scope:** #12 session change-set collection across committed paths plus staged, unstaged, and untracked paths; #15 durable per-run logs, Codex JSON-line rendering fallback, activity-based idle timeout, log path metadata/reporting; #16 structured completion report validation errors and inert handling of issue title/body/comment prompt data.
- **Out of Scope:** Sandcastle dependency; external sandbox providers; reusable multi-phase execution sessions; letting agents push, open PRs, merge, publish, deploy, or mutate GitHub issues/labels/comments; auto-merge; release publishing; broad host environment inheritance; live GitHub-only tests; changing planning mode to allow file mutation or commits.
- **Simplest Viable Path:** Add small owner modules for session change sets, stream logs, idle timeout, and completion validation, then route existing scoped and tree-child runner flows through those owners without changing GitHub publication ownership.
- **Primary Risk:** Current runner blocks changed `HEAD` before file validation, while #12 needs committed paths to be collectable. The executor must separate "collect the full local change set" from "allow local commits to publish"; this wave can collect committed paths and validate them, but must not give agents external publication authority.

## 2. Preconditions And Evidence
- **Required Services / Env / Fixtures:** Node.js `>=18`; npm dependencies installed; `git` CLI available; tests use temp git repositories, local bare remotes, fake Codex/process adapters, and in-memory GitHub adapters only. No new external auth or live GitHub calls are required.
- **Blocking Unknowns:** None.
- **Confirmed Commands:**
  - `npm run typecheck`
  - `npm run build`
  - `npm test`
  - Focused test examples after build: `node --test dist/test/worktree-manager.test.js`, `node --test dist/test/process-command.test.js`, `node --test dist/test/codex-command-adapter.test.js`, `node --test dist/test/prompt-builder.test.js`, `node --test dist/test/scoped-auto-command.test.js`, `node --test dist/test/plan-auto-command.test.js`
- **Confirmed Targets:**
  - Git status/worktree owner today: `src/git/worktree.ts`; tests in `test/worktree-manager.test.ts`.
  - Process execution owner today: `src/process/command.ts`; tests in `test/process-command.test.ts`.
  - Codex CLI adapter today: `src/codex/command-adapter.ts`; tests in `test/codex-command-adapter.test.ts`.
  - Prompt and report parsing owner today: `src/runner/prompt.ts`; tests in `test/prompt-builder.test.ts`.
  - Safety validation today: `src/runner/safety.ts`; tests in `test/safety.test.ts`.
  - Scoped runner flow today: `src/runner/scoped-auto-command.ts`; tests in `test/scoped-auto-command.test.ts`.
  - Tree-child runner flow today: `src/runner/plan-auto-command.ts`; tests in `test/plan-auto-command.test.ts`.
  - Run metadata today: `src/runner/local-state.ts`; tests in `test/local-state.test.ts`.
  - Config schema/defaults today: `src/config/schema.ts`, `src/setup/project-config.ts`, `test/config-schema.test.ts`, `test/setup-command.test.ts`, `test/fixtures/config.ts`.
  - Public package exports: `src/index.ts`, `test/public-api.test.ts`.
- **Protected Paths / Rejected Approaches:** Do not read `.env` or `.env.*`; do not add Sandcastle; do not inherit Sandcastle broad host environment behavior; do not parse git status independently in multiple runner files; do not add shell expansion for issue text; do not use real sleeps for idle-timeout tests; do not let planning sessions mutate files or commits; do not run `npm publish`.

## Risk Controls
- **Source of Truth:** `src/git/worktree.ts` owns git-derived session change-set collection. `src/runner/completion-report.ts` owns completion report validation. `src/runner/run-log.ts` owns durable run log writing and stream-event formatting. `src/process/command.ts` owns activity timeout mechanics.
- **Safety Constraints:** Runner remains the only actor that pushes branches, creates draft PRs, changes labels/comments, merges child branches into parent integration branches, publishes, or deploys. Agent local commits are data for the local change-set view, not publication proof.
- **Contract Constraints:** Completion report errors must name the missing/invalid field. Codex JSON-line event parsing must gracefully preserve raw output when parsing or recognition fails. Issue title/body/comments are untrusted data and must only enter prompts as inert text.
- **Concurrency / State Constraints:** This wave is single-agent because scoped/tree-child runners, Codex adapter, report validation, and local state metadata are shared contracts. Do not split across concurrent agents unless write scopes are re-specified later.
- **Forbidden Scope:** No trusted prompt expansion feature in this wave. No config migration that silently changes local commit policy. No compatibility branch that keeps old ad hoc changed-file parsing beside the new collector.

| Behavior / Data | Owner | Readers / Projections | Non-Owners |
|-----------------|-------|-----------------------|------------|
| Session changed paths and commit metadata | `src/git/worktree.ts` | `src/runner/scoped-auto-command.ts`, `src/runner/plan-auto-command.ts`, `src/runner/safety.ts`, reports | Prompt text, GitHub adapters |
| Durable log path and stream rendering | `src/runner/run-log.ts` | Codex adapter, local state, blocked/review reports | GitHub issue state machine |
| Activity-based idle timeout | `src/process/command.ts` | `src/codex/command-adapter.ts` | Runner label transitions |
| Completion report shape | `src/runner/completion-report.ts` | Scoped runner, tree-child runner, prompt tests | Ad hoc JSON parsing in runner files |
| Prompt argument safety | `src/codex/command-adapter.ts` and `src/runner/prompt.ts` | Codex process execution, prompt-builder tests | Shell/check executor |

## Write Scope Summary
- `src/git/worktree.ts` - Update; add full session change-set collection from base commit to `HEAD` plus porcelain working-tree status; include commit metadata.
- `src/process/command.ts` - Update; add output callbacks and activity-based idle timeout without breaking existing wall-clock timeout behavior.
- `src/codex/command-adapter.ts` - Update; pass log path, stream callbacks, idle timeout options, and inert arg rendering; expose log path/idle timeout in result.
- `src/runner/run-log.ts` - Create; durable log writer and Codex JSON-line stream rendering with raw fallback.
- `src/runner/completion-report.ts` - Create; central scoped and plan report readers/validators, then re-export or replace existing prompt-local report readers.
- `src/runner/prompt.ts` - Update; keep prompt builders and path helpers, remove duplicated report validation ownership, preserve issue text as literal prompt data.
- `src/runner/safety.ts` - Update; validate denied paths from combined change-set paths.
- `src/runner/scoped-auto-command.ts` - Update; collect full change set, include log path/change-set evidence in block/review reports, use centralized report validation.
- `src/runner/plan-auto-command.ts` - Update; keep planning mutation block strict, use centralized report validation, collect full child change sets, include child log paths where available.
- `src/runner/local-state.ts` - Update; allow `logPath` and reject any unapproved state keys.
- `src/config/schema.ts` - Update; add optional positive integer `codex.idleTimeoutMs`.
- `src/setup/project-config.ts` - Update; add generated default `codex.idleTimeoutMs: 300000` while preserving restrictive env defaults.
- `src/index.ts` - Update exports only for public helper contracts that tests/adopters need.
- `test/worktree-manager.test.ts` - Update; temp git repo behavior tests for committed-only and mixed change sets.
- `test/safety.test.ts` - Update; denied path validation against combined paths.
- `test/process-command.test.ts` - Update; stream callbacks and idle timeout with controlled timing, not real sleeps.
- `test/codex-command-adapter.test.ts` - Update; log path, idle timeout, JSON-line/raw stream behavior, inert arg rendering.
- `test/completion-report.test.ts` - Create; centralized scoped and plan completion validation behavior.
- `test/prompt-builder.test.ts` - Update; completion validation errors and prompt inertness.
- `test/scoped-auto-command.test.ts` - Update; block/review reports include log path, invalid structured output blocks before push/PR, no-change still blocks.
- `test/plan-auto-command.test.ts` - Update; planning remains structured-output only and child runs use full change-set/report validation.
- `test/local-state.test.ts` - Update; `logPath` accepted and forbidden keys still rejected.
- `test/config-schema.test.ts`, `test/setup-command.test.ts`, `test/fixtures/config.ts` - Update; config/default coverage for `codex.idleTimeoutMs`.

## 3. Execution Slices

### Progress Discipline
- [ ] Update this checklist as work is completed.
- [ ] Leave blocked work unchecked with a short `Blocked:` note.
- [ ] Stop if repo reality contradicts a confirmed target, command, precondition, or scope boundary.
- [ ] Keep each implementation phase as a vertical tracer-bullet slice, not a horizontal layer pass.
- [ ] For behavior changes, start each slice with one behavior-first test/proof before implementation work.
- [ ] Do not write all tests first. Use RED -> GREEN -> refactor per slice.

### Slice 1 - #12 Committed-Only Session Change Set
- [ ] Objective: A session with only agent-created commits is observable as changed files through one git-facing public API.
- [ ] Test/Proof First: Add one failing test in `test/worktree-manager.test.ts`: create a temp repo and worktree, record `baseHead`, write `committed.txt`, commit it, leave working tree clean, call `GitWorktreeManager.collectSessionChangeSet({ worktreePath, baseHead })`, and assert `changedPaths` includes `committed.txt`, `commits.length === 1`, and `hasChanges === true`.
- [ ] Target: `src/git/worktree.ts`
  - [ ] Action: Add exported interfaces `CollectSessionChangeSetInput`, `SessionCommitInfo`, and `SessionChangeSet`.
  - [ ] Action: Add `collectSessionChangeSet(input)` that runs `git -C ${worktreePath} diff --name-only -z ${baseHead}..HEAD`, `git -C ${worktreePath} log --format=%H%x00%s%x00%an%x00%ae%x00%ct%x00 ${baseHead}..HEAD`, and existing porcelain status collection.
  - [ ] Action: Normalize and dedupe paths in stable lexical order.
  - [ ] Validation: Run `npm run build && node --test dist/test/worktree-manager.test.js`.
- [ ] Slice Exit Gate: The focused test fails before implementation and passes after implementation.

### Slice 2 - #12 Mixed Working Tree and Denied Path Validation
- [ ] Objective: Staged, unstaged, untracked, and committed paths are reported together and denied path validation can consume the combined list.
- [ ] Test/Proof First: Add one failing test in `test/worktree-manager.test.ts`: before `baseHead`, create and commit `tracked.txt`; after `baseHead`, commit `committed.txt`, stage `staged.txt`, modify `tracked.txt` without staging, leave `untracked.txt`, collect the session change set, and assert `changedPaths` is exactly `['committed.txt', 'staged.txt', 'tracked.txt', 'untracked.txt']`.
- [ ] Target: `src/git/worktree.ts`
  - [ ] Action: Reuse existing porcelain parser for staged/unstaged/untracked status.
  - [ ] Action: For rename/copy porcelain records, include both source and destination paths.
  - [ ] Validation: Run `npm run build && node --test dist/test/worktree-manager.test.js`.
- [ ] Test/Proof First: Add one failing test in `test/safety.test.ts` passing the collected `changedPaths` to `validateChangedPaths` with `additionalPathGlobs: ['secrets/**']`; assert a committed `secrets/committed.txt` and untracked `secrets/untracked.txt` both produce `secret-file-change`.
- [ ] Target: `src/runner/safety.ts`
  - [ ] Action: Keep `validateChangedPaths(paths, config)` as the single denied-path entrypoint; do not add a separate committed-path validator.
  - [ ] Validation: Run `npm run build && node --test dist/test/safety.test.js`.
- [ ] Slice Exit Gate: Focused worktree and safety tests pass, and no second git status/diff parser is introduced outside `src/git/worktree.ts`.

### Slice 3 - #12 Runner Uses the Change-Set Owner Without Publishing Agent Commits
- [ ] Objective: Scoped and tree-child flows consume the new change-set view for no-change, safety, review-gate, and reporting inputs while publication remains runner-owned.
- [ ] Test/Proof First: Add one failing scoped runner behavior test in `test/scoped-auto-command.test.ts`: fake Codex exits `0`, writes a valid report, writes no files and no commits; assert result status is `blocked`, no PR is created, and report contains `Codex completed without file changes`.
- [ ] Target: `src/runner/scoped-auto-command.ts`
  - [ ] Action: Replace direct `git.listChangedFiles(worktreePath)` use with `git.collectSessionChangeSet({ worktreePath, baseHead: beforeHead })` after Codex exits and after runner visual proof adds artifacts.
  - [ ] Action: Use `changeSet.changedPaths` for no-change, safety validation, review gates, PR body, and issue report.
  - [ ] Action: Keep `validateNoAgentOwnedGitPublication(beforeHead, afterHead)` behavior unless a later issue explicitly changes local commit policy.
  - [ ] Validation: Run `npm run build && node --test dist/test/scoped-auto-command.test.js`.
- [ ] Test/Proof First: Add one new tree-child behavior test in `test/plan-auto-command.test.ts` proving a child with no committed or uncommitted changes still blocks before merge/push/PR.
- [ ] Target: `src/runner/plan-auto-command.ts`
  - [ ] Action: Keep planning parent strict: changed `HEAD` or changed files still block planning as structured-output-only.
  - [ ] Action: For tree-child implementation, replace `git.listChangedFiles(worktreePath)` with `git.collectSessionChangeSet({ worktreePath, baseHead: beforeHead })` and use `changedPaths`.
  - [ ] Validation: Run `npm run build && node --test dist/test/plan-auto-command.test.js`.
- [ ] Slice Exit Gate: No-change behavior still blocks; committed paths are collectable through the owner; agent commits still do not grant push/PR authority in this wave.

### Slice 4 - #15 Durable Run Log Tracer
- [ ] Objective: Codex output is streamed to a durable per-run log path and the path is recorded in local state and reports.
- [ ] Test/Proof First: Add one failing test in `test/codex-command-adapter.test.ts`: fake process executor calls stdout/stderr callbacks with `hello` and `warn`, adapter returns result with `logPath`, and the log file contains both chunks.
- [ ] Target: `src/runner/run-log.ts`
  - [ ] Action: Create `sessionLogPath({ targetRoot, config, issueNumber, sessionId })` returning `${targetRoot}/${config.runner.stateDir}/logs/issue-${issueNumber}-${sessionId}.log`.
  - [ ] Action: Create `RunLogWriter` with `appendStdout`, `appendStderr`, `appendLifecycle`, and `close` methods that create parent directories and append UTF-8 lines.
  - [ ] Validation: Covered by adapter and local-state tests; no standalone filesystem test required unless adapter test becomes too broad.
- [ ] Target: `src/process/command.ts`
  - [ ] Action: Extend `ProcessCommandOptions` with `onStdoutChunk?: (chunk: string) => void | Promise<void>` and `onStderrChunk?: (chunk: string) => void | Promise<void>`.
  - [ ] Action: Invoke callbacks when child stdout/stderr data arrives while still accumulating `stdout` and `stderr`.
  - [ ] Validation: Run `npm run build && node --test dist/test/process-command.test.js`.
- [ ] Target: `src/codex/command-adapter.ts`
  - [ ] Action: Add `logPath` to `CodexCommandRunInput` and `CodexCommandRunResult`.
  - [ ] Action: Open a `RunLogWriter` for `input.logPath`; wire process output callbacks; close writer in `finally`.
  - [ ] Validation: Run `npm run build && node --test dist/test/codex-command-adapter.test.js`.
- [ ] Target: `src/runner/local-state.ts`
  - [ ] Action: Add optional `logPath` to `RunnerProcessMetadata` and allowed run keys.
  - [ ] Validation: Run `npm run build && node --test dist/test/local-state.test.js`.
- [ ] Target: `src/runner/scoped-auto-command.ts`, `src/runner/plan-auto-command.ts`
  - [ ] Action: Compute `logPath` with `sessionLogPath`, pass it into Codex run input, store it in run metadata, and include it in blocked/review reports when available.
  - [ ] Validation: Run focused scoped and plan-auto tests.
- [ ] Slice Exit Gate: The focused adapter test fails before implementation and passes after implementation; blocked or review report tests show the durable log path.

### Slice 5 - #15 Codex Stream Events and Raw Fallback
- [ ] Objective: Supported Codex JSON-line events become readable log entries while malformed/unrecognized output is preserved.
- [ ] Test/Proof First: Add one failing test in `test/codex-command-adapter.test.ts`: feed stdout chunks containing a recognized JSON line, malformed JSON text, and plain raw output; assert the log contains a readable event line and the raw diagnostics.
- [ ] Target: `src/runner/run-log.ts`
  - [ ] Action: Add exported function `renderCodexStreamChunk(chunk: string, stream: 'stdout' | 'stderr'): string[]`.
  - [ ] Action: Recognize only confirmed local JSON-line shapes by defensive fields such as `type`, `event`, `message`, or `delta`; format known text/tool/progress events as readable lines.
  - [ ] Action: Preserve every unrecognized or malformed line as raw `stdout`/`stderr` content.
  - [ ] Validation: Run `npm run build && node --test dist/test/codex-command-adapter.test.js`.
- [ ] Target: `src/codex/command-adapter.ts`
  - [ ] Action: Route stdout/stderr chunks through the formatter before appending to log; keep accumulated `stdout`/`stderr` unchanged.
- [ ] Slice Exit Gate: Logs are more readable for recognized events and never lose raw output.

### Slice 6 - #15 Activity-Based Idle Timeout
- [ ] Objective: A silent/hung command fails with an idle-timeout result, and output activity resets the idle timer.
- [ ] Test/Proof First: Add one failing test in `test/process-command.test.ts` using controlled fake timing or Node test mock timers, not real sleeps: a command with `idleTimeoutMs: 50` and no output resolves with `exitCode === 124` and stderr mentioning `Command idle timed out after 50ms`.
- [ ] Target: `src/process/command.ts`
  - [ ] Action: Extend `ProcessCommandOptions` with `idleTimeoutMs?: number`.
  - [ ] Action: Start an idle timer when process starts; reset it on stdout/stderr data; on expiry write a clear idle timeout message, terminate with `SIGTERM`, then `SIGKILL` after the existing grace period if still running.
  - [ ] Action: Preserve existing `timeoutMs` wall-clock timeout behavior and error message.
  - [ ] Validation: Run `npm run build && node --test dist/test/process-command.test.js`.
- [ ] Test/Proof First: Add one failing test in `test/process-command.test.ts`: emit output before idle expiry and assert the process is not killed until a later idle interval.
- [ ] Target: `src/codex/command-adapter.ts`
  - [ ] Action: Pass `config.codex.idleTimeoutMs` to the process executor.
- [ ] Target: `src/config/schema.ts`, `src/setup/project-config.ts`, `test/config-schema.test.ts`, `test/setup-command.test.ts`, `test/fixtures/config.ts`
  - [ ] Action: Add optional positive integer `codex.idleTimeoutMs` to the schema and default generated config to `300000`.
- [ ] Slice Exit Gate: Idle timeout tests pass without real-time sleeps and existing wall-clock timeout test still passes.

### Slice 7 - #16 Central Completion Validation
- [ ] Objective: Missing required report fields, invalid JSON, and schema failures produce clear errors and block before push/PR.
- [ ] Test/Proof First: Create `test/completion-report.test.ts` with one failing test: write `{ "status": "completed" }` to a scoped report file and assert validation rejects with `Invalid scoped completion report: changes must be a string array`.
- [ ] Target: `src/runner/completion-report.ts`
  - [ ] Action: Move or recreate scoped and plan report validators from `src/runner/prompt.ts` into this file.
  - [ ] Action: Export `readScopedCompletionReport`, `readPlanAutoCompletionReport`, `ScopedCompletionReport`, and `PlanAutoCompletionReport` from the new owner.
  - [ ] Action: Preserve current accepted report behavior, including optional migration for missing `artifacts` if current tests rely on it.
  - [ ] Validation: Run `npm run build && node --test dist/test/completion-report.test.js`.
- [ ] Target: `src/runner/prompt.ts`
  - [ ] Action: Keep prompt builders/path helpers; re-export completion report types/functions from `completion-report.ts` so existing imports keep compiling during this wave.
- [ ] Target: `src/runner/scoped-auto-command.ts`, `src/runner/plan-auto-command.ts`
  - [ ] Action: Import report readers/types from `completion-report.ts`.
  - [ ] Action: Keep existing block-before-push/PR behavior for invalid scoped, child, and plan reports.
- [ ] Test/Proof First: Add one failing scoped runner behavior test in `test/scoped-auto-command.test.ts`: fake Codex writes invalid JSON or schema-invalid output, assert result status is `blocked`, `pullRequestAdapter.createdPullRequests.length === 0`, and report comment includes the validation error.
- [ ] Slice Exit Gate: Invalid output blocks before publication in focused runner tests.

### Slice 8 - #16 Inert Prompt Data and Trusted Args Boundary
- [ ] Objective: Issue title/body/comment text containing shell-like syntax remains plain prompt data and cannot alter Codex command args or shell execution.
- [ ] Test/Proof First: Add one failing test in `test/prompt-builder.test.ts`: build scoped and issue-tree child prompts with issue body/comment text like `$(touch /tmp/owned)`, `` `touch /tmp/owned` ``, `${reportPath}`, and `; gh pr create`; assert these strings appear literally in the prompt.
- [ ] Target: `src/runner/prompt.ts`
  - [ ] Action: Do not run issue title/body/comments through placeholder rendering or shell command construction.
  - [ ] Action: If escaping is added for readability, it must preserve literal content and tests must assert the exact escaped representation.
  - [ ] Validation: Run `npm run build && node --test dist/test/prompt-builder.test.js`.
- [ ] Test/Proof First: Add one failing test in `test/codex-command-adapter.test.ts`: include malicious-looking issue text in `promptText`, run adapter with fake executor, and assert rendered `args` are derived only from `config.codex.args` placeholders and never include issue text.
- [ ] Target: `src/codex/command-adapter.ts`
  - [ ] Action: Keep `renderCodexArg` limited to project-owned config args and runner-owned values: `targetRoot`, `stateDir`, `worktreePath`, `promptFile`, `promptPath`, `reportFile`, `reportPath`, `issueNumber`, `sessionId`, `branchName`.
  - [ ] Action: Do not add user-controlled issue text as an arg placeholder.
  - [ ] Validation: Run `npm run build && node --test dist/test/codex-command-adapter.test.js`.
- [ ] Slice Exit Gate: Prompt-safety tests prove malicious-looking issue content is inert data.

### Slice 9 - Documentation, Exports, and Reconciliation
- [ ] Objective: Public docs and exports match the new behavior without implying unsupported publication authority.
- [ ] Test/Proof First: Update `test/public-api.test.ts` to assert any new exports deliberately added in `src/index.ts`; if no exports are added, assert the current public API test remains unchanged.
- [ ] Target: `src/index.ts`
  - [ ] Action: Export only stable public contracts required by existing package consumers. Do not export internals solely for tests.
  - [ ] Validation: Run `npm run build && node --test dist/test/public-api.test.js`.
- [ ] Target: `README.md`
  - [ ] Action: Leave unchanged when the implemented behavior matches the current README sections "Full Change-Set Awareness", "Durable Logs and Recovery", and "PR-First by Design".
  - [ ] Action: If implementation intentionally differs from those sections, stop and record the exact mismatch before editing README.
- [ ] Target: `docs/implementation-specs/2026-05-12/2008-first-wave-agent-execution-improvements.md`
  - [ ] Action: During implementation, update checklist items as completed or blocked.
- [ ] Slice Exit Gate: Documentation does not claim reusable sessions, external sandbox providers, auto-merge, or agent-owned GitHub publication.

## Acceptance Criteria Mapping
- **#12 AC: committed-only changes reported:** Slice 1 focused temp-git test.
- **#12 AC: staged, unstaged, untracked alongside committed:** Slice 2 mixed temp-git test.
- **#12 AC: denied path validation on combined set:** Slice 2 safety test using `changeSet.changedPaths`.
- **#12 AC: no-change still blocks:** Slice 3 scoped/tree-child runner tests.
- **#12 AC: public runner/git interfaces:** Slices 1-3 use `GitWorktreeManager`, runner commands, temp git repos, and fake adapters.
- **#15 AC: durable per-run log:** Slice 4 adapter/runner report tests.
- **#15 AC: readable Codex stream events with raw diagnostics:** Slice 5 log formatter tests.
- **#15 AC: idle timeout resets on output:** Slice 6 process tests.
- **#15 AC: silent/hung agent fails clearly:** Slice 6 process/Codex result tests.
- **#15 AC: metadata and reports include log path:** Slice 4 local-state and runner report tests.
- **#16 AC: missing fields/sections clear:** Slice 7 completion validation tests.
- **#16 AC: invalid JSON blocks publication:** Slice 7 scoped runner test.
- **#16 AC: issue text cannot introduce executable expansion:** Slice 8 prompt and adapter tests.
- **#16 AC: shell-like input inert:** Slice 8 prompt and adapter tests.
- **#16 AC: existing report-file behavior remains supported:** Slice 7 preserves `CODEX_ORCHESTRATOR_REPORT_FILE` readers and current compatible report tests.

## Halt Conditions
- [ ] Stop if implementation requires permitting agent-created commits to push or PR in this wave; that belongs to a separate local commit policy/publication issue.
- [ ] Stop if full session changed paths cannot be collected with git commands available in temp repositories.
- [ ] Stop if idle timeout tests require real sleeps long enough to make the test suite flaky.
- [ ] Stop if Codex stream JSON-line shape cannot be confirmed locally; keep only raw durable logging and mark readable event rendering blocked.
- [ ] Stop if completion validation cannot be centralized without breaking existing plan/scoped report compatibility; record the exact conflicting import or behavior.
- [ ] Stop if any proposed prompt convenience feature would evaluate user-controlled issue title/body/comment text.

## 4. Validation And Done Criteria
- [ ] **Lint/Format:** Not applicable; no lint script is defined in `package.json`.
- [ ] **Typecheck:** `npm run typecheck`
- [ ] **Build:** `npm run build`
- [ ] **Focused Tests:** Run these focused checks as their slices become relevant:
  - `npm run build && node --test dist/test/worktree-manager.test.js`
  - `npm run build && node --test dist/test/safety.test.js`
  - `npm run build && node --test dist/test/process-command.test.js`
  - `npm run build && node --test dist/test/codex-command-adapter.test.js`
  - `npm run build && node --test dist/test/completion-report.test.js`
  - `npm run build && node --test dist/test/prompt-builder.test.js`
  - `npm run build && node --test dist/test/scoped-auto-command.test.js`
  - `npm run build && node --test dist/test/plan-auto-command.test.js`
  - `npm run build && node --test dist/test/local-state.test.js`
  - `npm run build && node --test dist/test/config-schema.test.js`
  - `npm run build && node --test dist/test/setup-command.test.js`
  - `npm run build && node --test dist/test/public-api.test.js`
- [ ] **Full Tests:** `npm test`
- [ ] **Architecture Check:** Search for duplicated git/session parsing and ad hoc report parsing:
  - `rg -n "status --porcelain|diff --name-only|readScopedCompletionReport|JSON\\.parse\\(content\\)|listChangedFiles\\(" src test`
  - Acceptable remaining occurrences: owner modules, tests, and compatibility re-exports only.
- [ ] **Live/Manual Validation:** Not required.
- [ ] **Behavior Proof:** Tests must show RED -> GREEN evidence in completion report validation lines if this work is later run through the orchestrator.
- [ ] **Post-Implementation Signoff:** Because this changes runtime behavior across shared contracts, run `$cleanup-review` after implementation and relevant validation, integrate only high-confidence cleanup, rerun relevant checks, then run final `$code-review`.
- [ ] **Final Reconciliation:** All unchecked work is unfinished, blocked with a note, or intentionally not applicable.

## 5. Final Action
After saving the file, respond in chat with exactly:

Spec Status: Ready
Saved Path: docs/implementation-specs/2026-05-12/2008-first-wave-agent-execution-improvements.md
Execution Model: Single-Agent
Review Verdict: Approved
Validation Gates: Local / Tests
Blockers: None
