---
title: "Retry stale scoped runs with missing completion reports"
created_at: "2026-07-02T13:33:59Z"
source_type: "plan"
source_plan: "/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-02/1626-retry-stale-missing-completion-report.md"
source_issues:
  - "Local user request after M-Ivonin/tipsterBro#159 missing completion report recovery block"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_verdict: "Approved"
---

## 1. Execution Context
- **Goal:** Stale scoped runs with a missing completion report retry once within configured rework budget when recovery proves there are no unvalidated changes, instead of immediately posting an `agent:blocked` handoff.
- **Source Material:** Approved plan at `/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-02/1626-retry-stale-missing-completion-report.md`.
- **Approved Scope:** Update recovery/scoped execution routing, rework reason ownership, focused tests, and recovery docs for missing completion report retry.
- **Out of Scope:** Infinite retry, branch reset, retry over unreported changes, retry for invalid or promotion reports, retry for cross-host/unknown/active runs, target-repo changes, live smoke, release publishing.
- **Simplest Viable Path:** Add one canonical missing-report reason, add a recovery-aware scoped execution option/helper that bypasses normal eligibility/claim only after `recoverScopedRun` has proven stale same-host ownership, and call it only when `collectSessionChangeSet` proves no changes since recovered `beforeHead`.
- **Primary Risk:** Accidentally letting recovery retry publish or build on unvalidated stale-attempt changes, or exposing a broad bypass around `agent:running` eligibility.

## 2. Preconditions And Evidence
- **Required Services / Env / Fixtures:** None for unit tests. Git CLI is required by existing `test/scoped-recovery.test.ts` temp repo helpers.
- **Current Dirty State Precondition:** `git status --short --branch` currently shows existing dirty files before this implementation: `docs/deep-dive.md`, `src/runner/auto-visual-proof-command.ts`, `src/runner/plan-auto-command.ts`, `src/runner/scoped-auto-command.ts`, `src/runner/scoped-recovery.ts`, `test/auto-visual-proof-command.test.ts`, `test/visual-proof-runner.test.ts`, untracked `src/runner/runner-handoff-decision.ts`, `test/runner-handoff-decision.test.ts`, and plan/spec docs under `docs/plans/2026-07-02/` and `docs/implementation-specs/2026-07-02/`. Before Slice 1, inspect diffs for planned target files and preserve unrelated existing work. If planned target diffs make the retry fix impossible to apply safely, stop and ask the user.
- **Blocking Unknowns:** None after the current dirty state is inspected and preserved as above.
- **Confirmed Targets:** `src/runner/scoped-recovery.ts` owns recovery classification and blocked handoff. `src/runner/scoped-auto-command.ts` owns scoped attempts, claim, prompts, runner state, publishability, and handoff. `src/runner/rework-policy.ts` owns retryable blocker matching. `src/runner/local-execution-session.ts` currently emits the missing-report reason. `src/git/worktree.ts` exposes `collectSessionChangeSet`. `test/scoped-recovery.test.ts` already covers stale recovery paths with temp repos and in-memory GitHub adapters. `docs/deep-dive.md` documents recovery states.
- **Confirmed Commands:** `npm run build --silent && node --test dist/test/scoped-recovery.test.js`; `npm run typecheck`; `npm test` for final behavior-changing runner policy validation.
- **Protected Paths / Rejected Approaches:** Do not read or edit `.env` or `.env.*`. Do not run `npm run smoke:live`. Do not reset the issue branch to `beforeHead`. Do not create a new CLI command or public bypass for arbitrary running issues. Do not duplicate scoped attempt setup in recovery.
- **Architecture Lens:** Reuse the existing scoped execution module as the deep owner of attempts. Recovery remains a narrow router. New helper/options must fail the deletion test only if they are pass-through; they are allowed only to parameterize the existing scoped execution owner for proven recovery.
- **Contract Test Ledger:**
  - Invariant: missing-report recovery retries only when configured and budget remains. First RED test: `test/scoped-recovery.test.ts` recovery retry invokes scoped Codex at `retryCount + 1` and posts no blocked handoff.
  - Invariant: retry never resets budget. First RED test: exhausted `retryCount` blocks and does not invoke Codex.
  - Invariant: retry never runs over unvalidated changes. First RED tests: staged, unstaged, untracked, and committed changes detected by `collectSessionChangeSet({ worktreePath: run.workspacePath, baseHead: scoped.beforeHead })` block retry.
  - Invariant: recovery bypasses `agent:running` eligibility only inside proven recovery. First RED test: recovery retry succeeds while issue has `agent:running` and does not post a duplicate claim comment.

## Risk Controls
- **Source of Truth:** `src/runner/rework-policy.ts` must export `MISSING_COMPLETION_REPORT_REASON`; `local-execution-session.ts` and `scoped-recovery.ts` must use that constant instead of separate strings.
- **Safety Constraints:** `recoverScopedRun` may retry missing reports only after current classification already has `canMutate === true`, `beforeHead` is present, `reportState === "missing"`, same recovery ownership gates have passed, and `git.collectSessionChangeSet({ worktreePath: run.workspacePath, baseHead: scoped.beforeHead }).hasChanges === false`.
- **Contract Constraints:** Recovery retry is attempt `run.retryCount + 1`. The initial prompt rework payload must be `{ attempt: run.retryCount + 1, blockedReasons: [MISSING_COMPLETION_REPORT_REASON] }`.
- **Concurrency / State Constraints:** No retry for active, unknown, cross-host daemon, legacy missing-report, invalid-report, or needs-promotion states. No duplicate claim comment during recovery retry. Fresh scoped attempt must write a new session id and runner-state row with `retryCount` equal to the retry attempt through existing scoped execution state logic.
- **Forbidden Scope:** No reset/checkout/revert. No direct GitHub label or comment mutation before the fresh attempt reaches existing scoped result handling. No second recovery-specific attempt loop.
- **Early Review Gate:** After Slice 2, run a focused self-check of `scoped-recovery.ts`, `scoped-auto-command.ts`, and tests for retry/idempotency/state drift before docs/final validation. Final `$code-review` is still required because this changes runner retry/state behavior.
- **Final Handoff Requirements:** Final response must include contract implemented, high-risk checkpoint result, main invariants proved, code-review findings/fixes, validation, skipped checks, residual risks, and files by role.

## 3. Execution Slices

### Progress Discipline
- [x] Update this checklist as work is completed.
- [x] Leave blocked work unchecked with a short `Blocked:` note.
- [x] Stop if repo reality contradicts a confirmed target, command, precondition, or scope boundary.
- [x] Keep each implementation phase as a vertical tracer-bullet slice, not a horizontal layer pass.
- [x] For behavior changes, start each slice with a behavior-first test/proof before implementation work.
- [x] For contract-heavy changes, update the Contract Test Ledger status as each invariant moves planned -> red -> green or blocked.
- [x] Run required review checkpoints before continuing past risky retry/state work.
- [x] Before Slice 1, run `git status --short --branch` and inspect current diffs in `src/runner/scoped-auto-command.ts`, `src/runner/scoped-recovery.ts`, `src/runner/rework-policy.ts`, `src/runner/local-execution-session.ts`, `test/scoped-recovery.test.ts`, and `docs/deep-dive.md` where present. Preserve unrelated existing changes.

### Slice 1 - Retry Missing Report Through Recovery-Aware Scoped Execution
- [x] Objective: A stale same-host missing-report run with no changes since `beforeHead` starts the next scoped attempt instead of blocking.
- [x] Test/Proof First: Add a failing test in `test/scoped-recovery.test.ts` that sets `retryCount: 0`, missing `reportPath`, no changes according to `collectSessionChangeSet({ worktreePath: run.workspacePath, baseHead: scoped.beforeHead })`, issue labels `[agent:running, agent:auto]`, and a fake `codexAdapter` that writes a valid completed report plus a file. Assert result is `review-ready`, Codex was invoked once with phase `scoped-issue`, the new run attempt uses `retryCount: 1`, no recovery blocked comment was posted, and no duplicate claim comment was posted.
- [x] Target: `src/runner/rework-policy.ts`
  - [x] Action: Export `MISSING_COMPLETION_REPORT_REASON = "Codex did not write CODEX_ORCHESTRATOR_REPORT_FILE; runner cannot prove safety contract."` and use it in `retryableBlockerPatterns`.
  - [x] Validation: Existing rework-policy tests and new recovery test still match `missing-completion-report`.
- [x] Target: `src/runner/local-execution-session.ts`
  - [x] Action: Replace the hard-coded missing report string with `MISSING_COMPLETION_REPORT_REASON`.
  - [x] Validation: `test/scoped-auto-command.test.ts` and `test/rework-policy.test.ts` continue to pass under final `npm test`.
- [x] Target: `src/runner/scoped-auto-command.ts`
  - [x] Action: Add a narrow internal option/helper for recovery retry: skip normal `discoverIssueWork` eligibility and `claimIssue` only when passed an already-fetched `GitHubIssue`, `startAttempt`, and `initialRework`. The normal exported `runScopedAutoCommand` path must keep existing eligibility and claim behavior.
  - [x] Validation: The new recovery test proves running-label issue can retry without duplicate claim.
- [x] Target: `src/runner/scoped-recovery.ts`
  - [x] Action: For `failed-pending-block` with `reportState === "missing"`, compute `startAttempt = run.retryCount + 1`; if policy and budget allow, and `collectSessionChangeSet(...).hasChanges === false`, call the recovery-aware scoped execution path with `initialRework`.
  - [x] Validation: The new recovery test passes.

### Slice 1 Exit Gate
- [x] `npm run build --silent && node --test dist/test/scoped-recovery.test.js` passes for the new retry happy path.

### Slice 2 - Preserve Blocked Fallbacks And Safety Guards
- [x] Objective: Missing-report recovery does not retry when retry would be unsafe or outside policy.
- [x] Test/Proof First: Add failing tests in `test/scoped-recovery.test.ts` for: exhausted retry budget (`retryCount >= loopPolicy.rework.maxAttempts`); config without `missing-completion-report`; staged/unstaged/untracked changes detected by `collectSessionChangeSet`; committed change since `scoped.beforeHead` with clean `git status`. Assert Codex is not invoked, blocked handoff is posted once with stable marker, and state `lastRecoveredAt` updates.
- [x] Target: `src/runner/scoped-recovery.ts`
  - [x] Action: Keep existing `blockRecoveredRun` fallback for exhausted budget, policy-disabled, dirty/unvalidated changes, invalid report, promotion report, and non-missing report states.
  - [x] Validation: New guard tests pass and existing duplicate-comment test remains valid.

### Slice 2 Exit Gate
- [x] `npm run build --silent && node --test dist/test/scoped-recovery.test.js` passes all recovery tests.
- [x] Manual code checkpoint: inspect `src/runner/scoped-recovery.ts`, `src/runner/scoped-auto-command.ts`, and `src/runner/rework-policy.ts` for public bypass, duplicate retry loop, retry over changes, and string drift before docs.

### Slice 3 - Docs And Final Validation
- [x] Objective: Docs and validation reflect the new bounded retry recovery contract.
- [x] Test/Proof First: No new behavior test; docs change is verified by diff review and final commands.
- [x] Target: `docs/deep-dive.md`
  - [x] Action: Update recovery section so `failed-pending-block` explains missing report may retry first when configured, budget remains, same-host stale ownership is proven, and no changes since base exist.
  - [x] Validation: Diff review confirms no live-smoke instruction was added.
- [x] Target: `docs/implementation-specs/2026-07-02/1633-retry-stale-missing-completion-report.md`
  - [x] Action: Update checklist status during execution.
  - [x] Validation: Final reconciliation has completed or intentionally unchecked items only.

### Slice 3 Exit Gate
- [x] `npm run build --silent && node --test dist/test/scoped-recovery.test.js`
- [x] `npm run typecheck`
- [x] `npm test`

### Review Checkpoints
- [x] After Slice 2, complete the manual code checkpoint listed in Slice 2 Exit Gate.
- [x] After Slice 3 validation, run `$cleanup-review` then `$code-review` on the final diff because repo policy treats runner retry/state changes as medium runtime work.

### Review Focus
- Retry/idempotency: no infinite loop, no retry budget reset, no duplicate claim/block comments.
- State safety: no retry over committed, staged, unstaged, or untracked unreported changes.
- Boundary safety: recovery-aware bypass cannot be used by normal CLI/daemon issue selection except through proven recovery.
- Source of truth: one canonical missing completion report reason feeds publishability, recovery, and rework policy matching.

## 4. Validation And Done Criteria
- [x] **Lint/Format:** Not applicable; no lint script is configured.
- [x] **Typecheck:** `npm run typecheck`
- [x] **Tests:** `npm run build --silent && node --test dist/test/scoped-recovery.test.js`; `npm test`
- [x] **Architecture Check:** Use `docs/agents/execution-routing.md` preflight; no dedicated architecture script exists.
- [x] **Live/Manual Validation:** Not applicable; do not run `npm run smoke:live` unless explicitly requested.
- [x] **Behavior Proof:** Recovery retry test proves missing report retries before blocking; guard tests prove unsafe cases block.
- [x] **Final Reconciliation:** all unchecked work is unfinished, blocked with a note, or intentionally not applicable.
- [x] **Final Handoff Requirements:** Final response must include Contract implemented, High-risk checkpoints, Main invariants proved, Code-review findings, Fixes after review, Validation, Skipped checks, Residual risks, and Files by role.
