---
title: "Retry incomplete scoped Agent attempts after safe local progress"
created_at: "2026-07-07T12:20:00+03:00"
source_type: "plan"
source_plan: "/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-07/1206-incomplete-agent-progress-retry.md"
source_issues:
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/1210"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_verdict: "Approved"
---

## 1. Execution Context
- **Goal:** Make scoped issue execution retry an Agent attempt only when exact idle timeout happened after runner-verifiable safe local progress and the completion report is missing.
- **Source Material:** Source plan above; #1210 is diagnostic evidence only, not implementation scope.
- **Approved Scope:** Runner policy/config/docs/tests for `incomplete-after-progress` retry in scoped issue publishability and rework.
- **Out of Scope:** plan-auto/tree recovery, stale dirty worktree recovery, timeout increase as solution, blanket exitCode 124 retry, live smoke execution, package version/release files, finishing #1210 worktree, Agent-owned GitHub mutation.
- **Simplest Viable Path:** Add one sentinel reason and retryable blocker key, make `runImplementationPublishabilityCheck()` classify exact-idle-timeout + missing report + safe non-empty changed files before generic nonzero block, and reuse existing `agent-attempt` rework loop.
- **Primary Risk:** Accidentally turning unknown/unsafe Agent exits into retryable work and bypassing publication/safety gates.

## 2. Preconditions And Evidence
- **Required Services / Env / Fixtures:** None beyond local repo tests. Do not run `npm run smoke:live` unless the user explicitly requests it.
- **Blocking Unknowns:** None.
- **Confirmed Targets:** `src/runner/local-execution-session.ts` (`runImplementationPublishabilityCheck`, `blocked`, `formatCodexExitReason`); `src/runner/rework-policy.ts` (`ReworkBlockerKey`, `blockerPatterns`, `hardBlockerKeys`, `decideImplementationRework`); `src/config/schema.ts` (`RetryableReworkBlocker`, `expectRetryableBlockers`); `src/setup/project-config.ts` (`buildProjectConfig` default retryableBlockers); `.codex-orchestrator/config.json` repo-local retryableBlockers; tests named above; `docs/deep-dive.md` Loop Policy/Rework section.
- **Confirmed Commands:** `npm run typecheck`; `npm test`; `git diff --check`. Focused tests may be run with `npm test` after build or `npm run build && node --test dist/test/<name>.test.js`.
- **Protected Paths / Rejected Approaches:** Do not edit package version, `CHANGELOG.md`, release workflow, live-smoke scripts, #1210 worktree, or unrelated `.codex-orchestrator/local/self-improvement/*` files. Do not parse raw timeout text inside `rework-policy`; do not infer prohibited/destructive actions from transcript scraping; do not accept dirty worktree without report as publish-ready.
- **Architecture Lens:** Reuse existing publishability and rework policy modules. A private helper `isIdleTimeoutResult()` inside `local-execution-session.ts` is allowed and passes deletion test because inlining it would preserve the same design. No new module, adapter, or recovery subsystem.
- **Contract Test Ledger:**
  - Invariant A: GREEN. Only runner-owned sentinel `INCOMPLETE_AFTER_PROGRESS_REASON` maps to `incomplete-after-progress`; raw `Codex exited with code 124...` remains `unknown` unless publishability has produced the sentinel. First RED: `test/rework-policy.test.ts`.
  - Invariant B: GREEN. Exact idle timeout plus missing report, non-empty allowed diff, no publication violation, no denied paths, and scope pass returns blocked evidence with sentinel reason and collected `changedFiles`. First RED: `test/local-execution-session.test.ts`.
  - Invariant C: GREEN. Scoped auto flow retries the safe-progress blocker through existing rework loop and can become review-ready on second attempt. First RED: `test/scoped-auto-command.test.ts`.
  - Invariant D: GREEN. Generic command timeout, arbitrary exitCode 124, denied path, scope violation, publication violation, invalid report, required Figma MCP failure, and exhausted budget do not become publish-ready; exhausted/blocked evidence keeps collected `changedFiles` where applicable. First RED: `test/local-execution-session.test.ts` and/or `test/scoped-auto-command.test.ts`.
  - Invariant E: GREEN. Default setup config and repo-local config allow/configure `incomplete-after-progress`. First RED: `test/config-schema.test.ts` and `test/setup-command.test.ts`.

## Risk Controls
- **Source of Truth:** `local-execution-session.ts` proves safe incomplete progress from process result, report state, diff, and safety checks. `rework-policy.ts` only maps stable runner-owned reasons to blocker keys and retry decisions.
- **Safety Constraints:** Publication violation (`beforeHead !== afterHead` when local commits disallowed), denied changed paths, and scope isolation blockers must return existing hard-block reasons, not the sentinel.
- **Contract Constraints:** Exact idle predicate is `exitCode === 124` plus stderr/stdout line matching `Command idle timed out after <positive integer>ms.`. `Command timed out after ...`, arbitrary exit 124, and other nonzero exits remain generic nonzero blocks.
- **Concurrency / State Constraints:** Reuse the existing attempt loop and same worktree. Retry count and durable rework evidence must increment normally. Terminal blocked/exhausted summaries must preserve collected `changedFiles`.
- **Forbidden Scope:** No plan-auto changes, no stale recovery changes, no live smoke, no new retry budget config, no transcript scraping, no new abstraction layer.
- **Early Review Gate:** After Slice 2 or Slice 3, run `$code-review` focused on `src/runner/local-execution-session.ts`, `src/runner/rework-policy.ts`, and touched tests. Continue only after high-confidence findings about retry safety, reason taxonomy, changedFiles evidence, or publication boundary are fixed or explicitly blocked.
- **Final Handoff Requirements:** Final response must include contract implemented, early review checkpoint result, invariants proved, cleanup/code-review findings and fixes, validation commands, skipped checks, residual risks, and files by role.

## 3. Execution Slices

### Progress Discipline
- [x] Update this checklist as work is completed.
- [x] Leave blocked work unchecked with a short `Blocked:` note.
- [x] Stop if repo reality contradicts a confirmed target, command, precondition, or scope boundary.
- [x] Keep each implementation phase as a vertical tracer-bullet slice, not a horizontal layer pass.
- [x] Start each behavior-changing slice with the named RED test/proof before implementation work.
- [x] Update the Contract Test Ledger status as each invariant moves planned -> red -> green or blocked.
- [x] Run the early `$code-review` checkpoint before docs/final cleanup.

### Slice 1 - Rework Policy Sentinel And Config Contract
- [x] Objective: Make `incomplete-after-progress` a valid retryable blocker only when represented by a stable runner-owned sentinel.
- [x] Test/Proof First: Add RED tests in `test/rework-policy.test.ts` proving `INCOMPLETE_AFTER_PROGRESS_REASON` is retryable when configured, raw `Codex exited with code 124: Command idle timed out after 300000ms.` remains `unknown`/hard-block, and exhausted budget returns `exhausted` for the sentinel.
- [x] Target: `src/runner/rework-policy.ts`
  - [x] Action: Export `INCOMPLETE_AFTER_PROGRESS_REASON` with a stable string such as `Codex idle timed out after safe local progress; runner will retry completion from existing worktree.`
  - [x] Action: Add `incomplete-after-progress` to `ReworkBlockerKey` and `blockerPatterns` using an escaped exact sentinel pattern.
  - [x] Action: Do not add `incomplete-after-progress` to `hardBlockerKeys`.
  - [x] Validation: RED tests become GREEN.
- [x] Target: `src/config/schema.ts`
  - [x] Action: Add `incomplete-after-progress` to `RetryableReworkBlocker` and `expectRetryableBlockers()` valid list/error text.
  - [x] Validation: `test/config-schema.test.ts` RED/GREEN for valid and invalid retryable blocker list.
- [x] Target: `src/setup/project-config.ts` and `.codex-orchestrator/config.json`
  - [x] Action: Add `incomplete-after-progress` to default and repo-local `loopPolicy.rework.retryableBlockers` after `missing-completion-report` or near retryable completion blockers.
  - [x] Validation: `test/setup-command.test.ts` expectations updated and GREEN.

### Slice Exit Gate
- [x] `npm run build && node --test dist/test/rework-policy.test.js dist/test/config-schema.test.js dist/test/setup-command.test.js`

### Slice 2 - Publishability Safe-Progress Classification
- [x] Objective: Make publishability classify exact idle timeout with missing report and safe non-empty diff as retryable evidence, while preserving normal/hard-block paths.
- [x] Test/Proof First: Add RED tests in `test/local-execution-session.test.ts` for:
  - [x] exact idle timeout + missing report + allowed changed file -> `status: blocked`, reasons include `INCOMPLETE_AFTER_PROGRESS_REASON`, `changedFiles` contains the file, commits from change set are preserved.
  - [x] exact idle timeout + valid completion report + allowed changed file -> normal report-based publishability can return `publish-ready`.
  - [x] generic `Command timed out after ...` or arbitrary `exitCode: 124` without exact idle text -> generic nonzero block, no sentinel.
  - [x] exact idle timeout + invalid/unreadable report -> existing invalid-completion-report behavior, not sentinel.
  - [x] exact idle timeout + denied path/scope blocker/publication violation -> existing hard-block reason, not sentinel.
- [x] Target: `src/runner/local-execution-session.ts`
  - [x] Action: Import `INCOMPLETE_AFTER_PROGRESS_REASON` from `rework-policy.ts`.
  - [x] Action: Add local helper `isIdleTimeoutResult(result: CodexCommandRunResult): boolean` matching `exitCode === 124` and a trimmed stdout/stderr line `Command idle timed out after <positive integer>ms.`.
  - [x] Action: Keep publication violation check first.
  - [x] Action: Before generic `input.codexResult.exitCode !== 0` block, branch only for `isIdleTimeoutResult(input.codexResult)`.
  - [x] Action: In the idle branch, call `readScopedCompletionReport(input.reportPath)`. If report is present and valid, continue through the normal report-based path despite nonzero exit; do not classify as incomplete progress. If report is invalid, return the existing invalid report blocker. If report is missing, collect `git.collectSessionChangeSet({ worktreePath, baseHead: beforeHead })`.
  - [x] Action: For missing report and no changed files, return existing missing/no-progress behavior without sentinel.
  - [x] Action: For missing report with changed files, run `validateChangedPaths(changedFiles, input.config)` and `evaluateScopeIsolation({ config, issue, changedFiles })`. If either returns violations/blockers, return those reasons with collected `changedFiles`.
  - [x] Action: For missing report with safe changed files, return blocked evidence with `reasons: [INCOMPLETE_AFTER_PROGRESS_REASON]`, collected `changedFiles`, empty validation/skipped/residual risks, and collected commits.
  - [x] Action: Do not call `validateCompletionReportSafety()` without a report and do not scrape transcript output for prohibited actions.
  - [x] Validation: RED tests become GREEN.

### Slice Exit Gate
- [x] `npm run build && node --test dist/test/local-execution-session.test.js`

### Review Checkpoint
- [x] Run `$code-review` on Slice 1-2 diff before continuing. Review Focus: exact idle predicate, report-state branching, no transcript scraping, no raw timeout parsing in `rework-policy`, safety gate ordering, changedFiles evidence preservation, publication boundary. Continue only if no high-confidence findings remain.
  - Fixed: preserved existing Figma MCP failure taxonomy before idle safe-progress retry; added focused regression test for required Figma MCP failure.

### Slice 3 - Scoped Auto Rework Loop Behavior
- [x] Objective: Prove the safe-progress sentinel flows through existing `agent-attempt` rework and terminal summaries without special publication logic.
- [x] Test/Proof First: Add RED tests in `test/scoped-auto-command.test.ts` for:
  - [x] first Codex attempt writes `src/feature.ts`, does not write report, returns exact idle timeout; second attempt sees rework prompt, writes valid report/validation, and command returns `review-ready`.
  - [x] rework prompt contains automatic rework marker, `INCOMPLETE_AFTER_PROGRESS_REASON`, and enough current-worktree instruction from existing prompt text (`Continue from the current worktree state; do not start over.`). If it does not include changed files and the test proves that context is necessary, extend prompt input minimally.
  - [x] with `maxAttempts: 0` or exhausted budget, terminal blocked report/durable summary includes changedFiles from the idle-timeout attempt.
- [x] Target: `src/runner/agent-attempt.ts`
  - [x] Action: Prefer no edit. Reuse existing rework loop and evidence. Edit only if tests prove changedFiles cannot be surfaced to prompt/summary through existing structures.
- [x] Target: `src/runner/prompt.ts`
  - [x] Action: Prefer no edit because current rework text already says to continue from the current worktree. If changed-file context is required, add it to `ScopedPromptInput.rework` and `buildScopedImplementationPrompt()` with exact tests; do not create a new prompt subsystem.
- [x] Target: `src/runner/scoped-auto-command.ts`, `src/runner/durable-run-summary.ts`, `src/runner/handoff-evidence.ts`
  - [x] Action: Prefer no edit. Only adjust if tests show collected `changedFiles` are lost on retry exhaustion/blocking.
  - [x] Validation: scoped auto tests become GREEN.

### Slice Exit Gate
- [x] `npm run build && node --test dist/test/scoped-auto-command.test.js`

### Slice 4 - Hard-Block Edge Coverage And Docs
- [x] Objective: Lock the hard-block boundary and document the new retryable state.
- [x] Test/Proof First: Add or update tests proving `incomplete-after-progress` is included in config defaults and repo-local config validation, and that invalid retryable blocker lists still reject `unknown`.
- [x] Target: `docs/deep-dive.md`
  - [x] Action: Update Loop Policy/Rework section to state that unknown Codex exits remain hard-block, but runner-classified `incomplete-after-progress` is retryable only after exact idle timeout, missing report, safe non-empty diff, no publication violation, no denied path, scope isolation pass, and remaining rework budget.
  - [x] Action: State exhausted terminal summaries/comments must include collected changedFiles.
  - [x] Validation: docs describe same predicates as tests; no live smoke.
- [x] Target: `test/config-schema.test.ts`, `test/setup-command.test.ts`, and `.codex-orchestrator/config.json`
  - [x] Action: Ensure expected default retryable blocker order includes `incomplete-after-progress` and validation error text includes it.
  - [x] Validation: config/setup tests GREEN.

### Slice Exit Gate
- [x] `npm run build && node --test dist/test/config-schema.test.js dist/test/setup-command.test.js dist/test/rework-policy.test.js dist/test/local-execution-session.test.js dist/test/scoped-auto-command.test.js`

### Review Checkpoints
- [x] After Slice 2, run `$code-review` as described above.
- [x] After all slices, run `$cleanup-review` then final `$code-review` on the full diff because this changes runner retry/state behavior and publication safety.
  - Cleanup-review: one doc drift fix applied; no runtime cleanup debt found.
  - Final code-review: no high/critical findings remaining.

### Review Focus
- Exact timeout predicate; no broad retry for code 124; sentinel ownership; safety gate ordering; missing vs invalid vs valid report branching; changedFiles evidence retention; retry budget behavior; no Agent-owned publication; no transcript scraping; no plan-auto/stale recovery drift.

## 4. Validation And Done Criteria
- [x] **Lint/Format:** No dedicated lint script configured; run `git diff --check`.
- [x] **Typecheck:** `npm run typecheck`.
- [x] **Tests:** `npm test`.
- [x] **Architecture Check:** No dedicated architecture script configured; use docs preflight plus required `$code-review`/`$cleanup-review` gates.
- [x] **Live/Manual Validation:** User explicitly requested live smoke coverage. Added and ran `npm run smoke:live -- --scenario incomplete-progress-rework`; report `/var/folders/vl/r4rjhh8j3kzgnw16w8c27zm40000gn/T/codex-orchestrator-live-smoke-20260707093559-4RloE5/live-smoke-report.md`.
- [x] **Behavior Proof:** Focused tests prove sentinel retry, hard-block edges, scoped rework success, exhausted changedFiles evidence, and config/default support.
- [x] **Final Reconciliation:** all unchecked work is unfinished, blocked with a note, or intentionally not applicable.
- [x] **Final Handoff Requirements:** final response must include contract implemented, early review checkpoint result, main invariants proved, cleanup/code-review findings and fixes, validation commands, skipped checks, residual risks, and files by role.

## 5. Final Action
After saving the file, respond in chat with exactly:

Spec Status: Ready / Blocked
Saved Path: docs/implementation-specs/2026-07-07/1220-incomplete-agent-progress-retry.md
Execution Model: Single-Agent
Review Verdict: <implementation-spec-review verdict>
Validation Gates: Local Tests
Blockers: <unresolved blockers or None>
