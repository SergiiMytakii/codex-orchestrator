---
title: "Issue #17 reusable local execution session slice"
created_at: "2026-05-12T20:55:59+03:00"
source_type: "issue"
source_plan: "None"
source_issues:
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/17"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/11"
status: "ready"
execution_model: "single-agent"
spec_mode: "compact"
review_verdict: "Amended after review"
---

## 1. Execution Context
- **Goal:** Add one reusable local execution-session module that can run multiple runner-owned local phases on the same worktree, aggregate phase evidence, and block scoped publication when any phase fails.
- **Source Material:** GitHub issue #17 and parent #11; implemented local context from #12/#15/#16/#13/#14 visible in `src/git/worktree.ts`, `src/runner/scoped-auto-command.ts`, `src/runner/completion-report.ts`, `src/runner/run-log.ts`, `src/runner/review-gates.ts`, `test/scoped-auto-command.test.ts`, and `package.json`.
- **Approved Scope:** Create a small execution-session abstraction for local phases; prove multiple fake phases share one worktree; aggregate validation/log evidence/residual risks; make scoped publication stop before push/PR when a local phase fails; preserve existing single-phase scoped execution behavior.
- **Out of Scope:** Tree-child reusable sessions, cleanup-review/code-review real phase wiring, new config schema, external sandbox providers, Sandcastle dependency, agent-owned push/PR/label/comment/merge/publish/deploy, release publishing, or changes to parent planning behavior.
- **Simplest Viable Path:** Add `src/runner/local-execution-session.ts` as the owner for local phase sequencing and evidence aggregation, then keep it publication-free; future runner wiring may consume it after collecting full change-set evidence for blocked reports.
- **Primary Risk:** A later cleanup/code-review/fix phase could fail after implementation but still allow runner-owned push/PR unless all local phase results are aggregated and checked before publication.

## 2. Preconditions And Evidence
- **Required Services / Env / Fixtures:** Node.js `>=18`; npm dependencies installed; `git` CLI available for scoped tests. Unit tests use fake local phase executors. Scoped tests use temp git repositories, fake Codex adapters, fake shell executors, and in-memory GitHub issue/PR adapters. No live GitHub or external credentials.
- **Blocking Unknowns:** None.
- **Confirmed Targets:** `src/runner/scoped-auto-command.ts` owns scoped publication order and already blocks before `git.pushBranch`/`createDraftPullRequest` on failed Codex, malformed/missing report, safety, configured checks, visual proof, or review gates; `src/runner/completion-report.ts` owns `ScopedCompletionReport` validation; `src/runner/run-log.ts` owns durable log paths and log writing; `src/git/worktree.ts` owns `collectSessionChangeSet`; `test/scoped-auto-command.test.ts` already proves single-phase scoped behavior through the public runner command.
- **Confirmed Commands:**
  - `npm run build`
  - `npm run typecheck`
  - `npm test`
  - `npm run build && node --test dist/test/local-execution-session.test.js`
  - `npm run build && node --test dist/test/scoped-auto-command.test.js`
- **Protected Paths / Rejected Approaches:** Do not read `.env` or `.env.*`; do not run `npm publish`; do not add Sandcastle or a sandbox provider; do not move GitHub publication into the session module; do not make phase evidence agent-authored only; do not change the existing completion report schema for this slice; do not require existing scoped callers to opt into a new API for the current single-phase behavior.

## 3. Execution Slices

### Progress Discipline
- [ ] Update this checklist as work is completed.
- [ ] Leave blocked work unchecked with a short `Blocked:` note.
- [ ] Stop if repo reality contradicts a confirmed target, command, precondition, or scope boundary.
- [ ] Keep each implementation phase as a vertical tracer-bullet slice, not a horizontal layer pass.
- [ ] For behavior changes, start each slice with one behavior-first test/proof before implementation work.
- [ ] Use RED -> GREEN -> refactor per slice; do not batch all tests first.

### Slice 1 - Session Module Runs Multiple Local Phases On One Worktree
- [ ] Objective: A reusable session can run more than one local phase against the same worktree and preserve phase-specific evidence.
- [ ] Test/Proof First: Add `test/local-execution-session.test.ts` with one failing behavior test: create a temp directory as `worktreePath`, run `runLocalExecutionSession` with two fake phases, assert both phase inputs receive the exact same `worktreePath` and `sessionId`, assert the aggregate result is `status === 'passed'`, and assert phase records preserve `name`, `status`, `validation`, `logPath`, `artifacts`, `skippedChecks`, and `residualRisks`.
- [ ] Target: `src/runner/local-execution-session.ts`
  - [ ] Action: Create exported types `LocalPhaseStatus = 'passed' | 'failed' | 'skipped'`, `LocalPhaseValidationLine`, `LocalPhaseArtifact`, `LocalPhaseResult`, `LocalExecutionPhaseInput`, `LocalExecutionPhase`, and `LocalExecutionSessionResult`.
  - [ ] Action: Create `runLocalExecutionSession(input)` that receives `targetRoot`, `worktreePath`, `sessionId`, `issueNumber`, `logPath`, and ordered `phases`; calls each phase with the same local session input; records each phase result in order; aggregates validation, artifacts, skipped checks, residual risks, and failed phase names.
  - [ ] Action: Keep the module local-only: no git push, no PR creation, no label/comment mutation, no config reads, and no GitHub adapter imports.
  - [ ] Validation: `npm run build && node --test dist/test/local-execution-session.test.js`.
- [ ] Slice Exit Gate: The first execution-session test fails before implementation and passes after the module can run two fake phases on one worktree.

### Slice 2 - Failed Phase Stops Later Phases And Produces Blocking Evidence
- [ ] Objective: A failed phase prevents subsequent local phases and exposes deterministic evidence for the caller to block publication.
- [ ] Test/Proof First: In `test/local-execution-session.test.ts`, add one failing behavior test with phases `implementation`, `cleanup-review`, and `code-review`; make `cleanup-review` return `status: 'failed'`, one failed validation line, one log artifact/path, and one residual risk; assert `code-review` is not called, aggregate `status === 'failed'`, `failedPhases` is `['cleanup-review']`, and aggregate evidence includes the failed validation, log evidence, and residual risk.
- [ ] Target: `src/runner/local-execution-session.ts`
  - [ ] Action: Stop phase execution after the first `failed` result.
  - [ ] Action: Treat `skipped` as non-failing evidence and keep running later phases unless the phase result also reports `status: 'failed'`.
  - [ ] Action: Validate fakeable phase result shape at runtime enough to produce clear errors for missing `name`, invalid `status`, malformed validation lines, malformed artifacts, or non-string residual risks.
  - [ ] Validation: `npm run build && node --test dist/test/local-execution-session.test.js`.
- [ ] Slice Exit Gate: Failed phase behavior is proven without Codex, GitHub, or real process execution.

### Slice 3 - Scoped Runner Blocks Publication On Failed Local Phase
- [ ] Objective: Scoped execution consumes session results before runner-owned publication, so any failed local phase blocks push and draft PR creation while preserving evidence.
- [ ] Test/Proof First: In `test/scoped-auto-command.test.ts`, add one failing test using a new optional fakeable local phase input on `runScopedAutoCommand`: fake Codex writes a valid completion report and changes `feature.txt`; a second local phase named `cleanup-review` returns `failed` with validation `cleanup-review: failed`, `logPath`, and residual risk `cleanup follow-up needed`; assert result is `blocked`, draft PR count is `0`, no remote `codex/issue-155` branch exists, and the blocked report includes `cleanup-review`, failed validation, the log path, changed file evidence, and the residual risk.
- [ ] Target: `src/runner/scoped-auto-command.ts`
  - [ ] Action: Add an optional fakeable phase extension to `ScopedAutoCommandOptions`, for example `localPhases?: LocalExecutionPhase[]`, without requiring existing callers to pass it.
  - [ ] Action: Wrap the existing Codex implementation work as the first local phase inside `runLocalExecutionSession`; that phase must still create the prompt/report/log paths, run Codex, clean up isolated home, read and validate `ScopedCompletionReport`, and return phase evidence from the report validation/artifacts/skipped checks/residual risks.
  - [ ] Action: If future runner wiring runs optional extra local phases and one fails, collect the full session change set before blocked reporting, configured checks, visual proof, review gates, `git.commitAll`, `git.pushBranch`, and draft PR creation.
  - [ ] Action: If the session aggregate is `failed`, call the existing blocked-report path with phase failure reasons and aggregated evidence; do not push, create a PR, move to review, or remove inspectable worktree/log evidence.
  - [ ] Validation: `npm run build && node --test dist/test/scoped-auto-command.test.js`.
- [ ] Slice Exit Gate: The new scoped failure test proves a failed local phase blocks publication before push/PR and preserves evidence.

### Slice 4 - Existing Single-Phase Scoped Execution Remains Compatible
- [ ] Objective: Current scoped behavior works without opting into reusable sessions.
- [ ] Test/Proof First: Run existing `test/scoped-auto-command.test.ts` unchanged and keep `scoped auto command creates worktree, runner commit, draft PR, review report, and cleans state` passing without `localPhases`.
- [ ] Target: `src/runner/scoped-auto-command.ts`
  - [ ] Action: Preserve the existing public `runScopedAutoCommand(options)` call shape; `localPhases` must be optional and default to no extra phases.
  - [ ] Action: Preserve existing ordering for single-phase runs: claim issue, ensure worktree, write prompt/state, run Codex, validate report, collect change set, safety checks, configured checks, visual proof, review gates, runner commit if needed, push, draft PR, review label/comment, remove local run state.
  - [ ] Action: Preserve existing blocked behavior for missing report, invalid report, Codex non-zero exit, no file changes, denied paths, failed configured checks/review gates, and post-PR label/comment errors.
  - [ ] Validation: `npm run build && node --test dist/test/scoped-auto-command.test.js`.
- [ ] Slice Exit Gate: Existing scoped tests pass, and the new optional phase support has no required config or caller migration.

## 4. Validation And Done Criteria
- [ ] **Lint/Format:** Not applicable; no lint script is defined in `package.json`.
- [ ] **Typecheck:** `npm run typecheck`
- [ ] **Build:** `npm run build`
- [ ] **Tests:** `npm run build && node --test dist/test/local-execution-session.test.js`; `npm run build && node --test dist/test/scoped-auto-command.test.js`; `npm test`
- [ ] **Architecture Check:** `rg "createDraftPullRequest|pushBranch|addLabels|removeLabels|postComment|mergeBranch" src/runner/local-execution-session.ts` must return no matches; `rg "runLocalExecutionSession|LocalExecutionPhase" src/runner src/index.ts test` should show the session module, scoped runner integration, and tests only unless implementation deliberately exports public types.
- [ ] **Live/Manual Validation:** Not applicable.
- [ ] **Behavior Proof:** Tests prove multiple fake phases share one worktree, per-phase evidence is recorded, failed phase stops later phases, failed phase returns publishReady=false, and existing single-phase scoped execution remains compatible.
- [ ] **Acceptance Criteria:** reusable session runs multiple local phases on one worktree; each phase records result validation/log evidence/residual risks; external publication remains outside the module and runner-owned; failed phase blocks publication and preserves inspectable evidence; existing single-phase scoped execution works without opting into reusable sessions.
- [ ] **Stop Conditions:** Stop if the session module needs GitHub adapters, push/PR/label/comment calls, config schema changes, real cleanup-review/code-review implementation, report schema changes, or tree-child flow changes to satisfy this slice. Stop if scoped publication can occur before checking aggregate local phase status. Stop if existing scoped tests require caller migration.
- [ ] **Final Reconciliation:** all unchecked work is unfinished, blocked with a note, or intentionally not applicable.

## 5. Final Action
After saving the file, respond in chat with exactly:

Spec Status: Ready
Saved Path: docs/implementation-specs/2026-05-12/2055-issue-17-reusable-local-execution-session.md
Execution Model: Single-Agent
Review Verdict: Amended after review
Validation Gates: Local / Tests
Blockers: None
