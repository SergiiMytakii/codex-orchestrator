---
title: "Retry stale scoped runs with missing completion reports"
created_at: "2026-07-02T13:26:59Z"
complexity: "medium"
status: "approved"
---

## 1. Executive Summary
- **Goal:** Make interrupted scoped runs that end with a stale lease and missing completion report retry automatically within the existing bounded rework policy before blocking the issue.
- **Scope:** Change `codex-orchestrator` recovery behavior for proven same-host stale scoped runs with missing completion reports. Keep existing completed-report handoff, invalid-report blocking, promotion behavior, GitHub publication ownership, and non-retryable safety rules unchanged.
- **Chosen Option:** Option 2, delegated by the user and recommended: reuse the existing scoped execution attempt loop through a recovery-aware scoped execution mode when recovery proves `missing-completion-report` is retryable, `retryCount + 1` is still within `loopPolicy.rework.maxAttempts`, and `collectSessionChangeSet({ baseHead: beforeHead }).hasChanges === false` proves the stale attempt left no unvalidated changes.
- **Why This Approach:** It uses the already configured retry policy instead of adding a second retry counter or an infinite loop, and it keeps recovery publication safety conservative.

## 2. Current Understanding
- **Confirmed:** `loopPolicy.rework.retryableBlockers` already includes `missing-completion-report` in `.codex-orchestrator/config.json`. `runScopedAutoCommand` already loops attempts based on `shouldRequestImplementationRework` and `maxReworkAttemptsForReasons`. `runScopedAutoCommand` currently rejects `agent:running` issues through `discoverIssueWork`, while recovery requires the issue to be open with `agent:running`. `recoverScopedRun` currently classifies stale non-completed reports as `failed-pending-block` and calls blocked handoff directly. `readScopedCompletionReport` returns `{ kind: "missing" }` for absent reports. `GitWorktreeManager` exposes `collectSessionChangeSet`, which includes committed paths from `baseHead..HEAD` plus working-tree changes. Recovery docs describe `failed-pending-block` as the stale run path that cannot satisfy publication preconditions.
- **Assumptions:** If the stale worktree has no committed, staged, unstaged, or untracked changes since recovery `beforeHead` and the prior report is missing, a fresh scoped retry can safely reuse the existing issue worktree path with `GitWorktreeManager.ensureIssueWorktree(... allowResume: true)`. Existing scoped-run logic will preserve runner-owned publication boundaries and state updates for the new attempt.
- **Open Decisions:** None. The user asked to implement the recommended bounded retry path.

## 3. Architectural Design
- **Component Flow:** `recoverScopedRun` classifies a stale same-host missing-PID run. If the report is completed, it continues existing recovered handoff. If the report is missing, `collectSessionChangeSet({ worktreePath, baseHead: scoped.beforeHead }).hasChanges === false`, policy allows `missing-completion-report`, and `run.retryCount + 1 <= loopPolicy.rework.maxAttempts`, recovery delegates to a recovery-aware scoped execution entrypoint for the next attempt. If the retry budget is exhausted, policy does not allow the blocker, or the prior attempt left any unvalidated changes, recovery keeps the current blocked handoff.
- **Simplest Viable Path:** Add a recovery-side retry decision for `reportState === "missing"` using one exported canonical missing-report blocker reason, then call an internal scoped execution entrypoint with `skipEligibilityClaim: true`, `startAttempt: run.retryCount + 1`, and `initialRework: { attempt: run.retryCount + 1, blockedReasons: [MISSING_COMPLETION_REPORT_REASON] }`. This avoids duplicating prompt/worktree/report/check setup in recovery while avoiding the normal `agent:running` eligibility rejection.
- **Why Not Simpler:** Just changing the blocked reason string to match `Codex did not write CODEX_ORCHESTRATOR_REPORT_FILE` would make policy checks recognizable but would not create a fresh scoped attempt from recovery.
- **Architecture Lens:** Reuse the existing scoped execution module as the deep owner of attempts, prompts, worktrees, report paths, state updates, checks, and handoff. Recovery remains a classifier/router. No new adapter or pass-through module is needed.
- **Clean Architecture Map:** Domain policy lives in `rework-policy.ts`; application routing lives in `scoped-recovery.ts`; infrastructure adapters remain `GitWorktreeManager`, `CodexCommandAdapter`, GitHub adapters, and shell executor; presentation remains lifecycle events and handoff comments.
- **Reuse Strategy:** Reuse `shouldRequestImplementationRework`, `maxReworkAttemptsForReasons`, and the scoped execution implementation behind `runScopedAutoCommand` rather than adding a separate retry loop inside recovery.
- **Rejected Paths:** Do not add infinite retry. Do not retry invalid reports, needs-promotion reports, denied paths, publication-boundary violations, cross-host/unknown ownership, missing base evidence, or active runs. Do not mutate GitHub labels/comments before the fresh attempt reaches its normal publishability decision.

## 4. Constraints And Edge Cases
- **Data And Scale:** No large data path. State reads and writes are single issue-run metadata entries.
- **Errors And Fallbacks:** If the fresh attempt also misses the report and the retry budget is exhausted, existing blocked handoff should run with durable evidence. If config excludes `missing-completion-report`, recovery must block as today. If the stale branch contains any committed or working-tree changes since `beforeHead`, recovery must block rather than reset or execute on top of unreported changes.
- **Concurrency And State:** Retry only after same-host missing PID and stale lease proof. Keep bounded by `run.retryCount + 1 <= loopPolicy.rework.maxAttempts`. Treat recovery retry as the next attempt, not a new attempt 0. The fresh scoped attempt must update runner state with a new session id and incremented retry count through existing scoped execution logic. Recovery retry should not post another claim comment because the issue is already claimed and `agent:running`.

## 5. Impacted Areas
- `src/runner/scoped-recovery.ts` - route eligible stale missing-report recovery to a fresh scoped attempt, after no-prior-changes and retry-budget checks.
- `src/runner/scoped-auto-command.ts` - add a recovery-aware internal execution path that bypasses normal eligibility/claim only when recovery passes it an already-validated running issue and start attempt.
- `src/runner/rework-policy.ts` - expose one canonical missing completion report blocker reason whose text matches the existing `missing-completion-report` policy.
- `test/scoped-recovery.test.ts` - prove stale missing-report recovery retries before blocking and still blocks when attempts are exhausted or policy disallows retry.
- `docs/deep-dive.md` - update recovery behavior docs if runtime semantics change.

## 6. Execution Slices And Multi-Agent Model
- **Slices:** Slice 1 proves and implements policy routing for stale missing-report retry through a recovery-aware scoped execution entrypoint. Slice 2 proves and preserves exhausted, policy-disabled, and prior-unvalidated-changes blocking behavior. Slice 3 updates docs and runs focused validation.
- **Per-Slice Test/Proof:** Slice 1 starts with a failing `test/scoped-recovery.test.ts` behavior test where `recoverScopedRun` sees a stale missing report with retry budget available and no change set since `beforeHead`, then invokes a fresh scoped attempt at `retryCount + 1` instead of posting a blocked comment, without a duplicate claim comment. Slice 2 starts with tests for exhausted retry count, retryableBlockers excluding `missing-completion-report`, uncommitted dirty worktree changes, and a clean-status branch with committed changes since `baseSha`. Slice 3 runs targeted test and typecheck/architecture check required by repo policy.
- **Exit Gates:** `node --test test/scoped-recovery.test.ts`; `npm run typecheck`; architecture preflight from `docs/agents/execution-routing.md` if module exports or cross-module wiring change.
- **Agent Matrix:** Single agent. Review subagents are used only for plan/spec review gates.
- **Parallelization Limits:** Do not run implementation in parallel with spec review. Do not split `scoped-recovery.ts` and `scoped-auto-command.ts` edits across agents because both own the retry routing seam.

## 7. Implementation Handoff Contract
- **approval_state:** approved
- **approved_scope:** Implement bounded automatic retry for stale scoped runs with missing completion reports using existing loop policy and scoped execution attempt owner.
- **do_not_touch:** Secret files such as `.env` and `.env.*`; unrelated target repositories; publishing/release workflow.
- **architecture_rules:** Recovery classifies and routes; scoped auto owns fresh attempts and publication handoff; rework policy owns retryable blocker mapping and canonical reason text; retry budget must be finite, config-driven, and counted from the stale attempt's `retryCount`; absence of prior unvalidated changes must use the same change-set concept that publishability uses, not only `git status`.
- **rejected_paths:** Infinite loops; resetting recovery retry to attempt 0; resetting the branch to `beforeHead`; unconditional retry regardless of ownership/base evidence; retrying on any unreported committed or working-tree changes; duplicated scoped attempt setup in recovery; retrying invalid/promotion reports; duplicate claim comments; changing GitHub labels before a fresh attempt completes through normal scoped logic.
- **required_docs:** Update `docs/deep-dive.md` recovery section if behavior changes.
- **preconditions:** Clean or understood git worktree; no external services required for unit tests.
- **phase_boundaries:** Plan review; implementation spec review; RED test for missing-report retry; GREEN implementation; RED/GREEN guard tests for exhausted, policy-disabled, dirty-worktree, and committed-unreported-change paths; docs; validation; final review if risk remains medium.
- **validation_gates:** `node --test test/scoped-recovery.test.ts`; `npm run typecheck`; targeted architecture/preflight check if exports/imports change.
- **blocking_assumptions:** None.
