---
title: "Deepen Agent Attempt Lifecycle"
created_at: "2026-07-05T08:38:57Z"
complexity: "medium"
status: "approved"
---

## 1. Executive Summary
- **Goal:** Concentrate the duplicated implementation attempt and Rework Loop mechanics for scoped issues and tree children behind one deep Module, without changing user-facing runner behavior or Runner-Owned Publication Boundary authority.
- **Scope:** In scope: add the domain term **Agent Attempt** to `CONTEXT.md`; introduce `src/runner/agent-attempt.ts`; route `runScopedAutoCommandInternal` and `executeChild` through it; preserve scoped recovery by keeping `runScopedRecoveryRetry` on the scoped adapter path; add or strengthen public behavior tests only where coverage is missing. Out of scope: terminal Draft PR Handoff refactor, Acceptance Proof Loop refactor, recovery policy changes, live smoke changes, release changes, GitHub publication behavior changes, and generated `dist/` changes.
- **Chosen Option:** Delegated Option 2, Recommended: extract the full Agent Attempt lifecycle with scoped issue and tree-child adapters.
- **Why This Approach:** It is the smallest refactor that removes current duplication while preserving existing command ownership. Path-only helpers are too shallow; a broader Runner execution engine would cross into parent batching and terminal handoff scope.

## 2. Current Understanding
- **Confirmed:** Required module-boundary preflight was performed: read `docs/deep-dive.md`, `docs/adr/0001-runner-owned-loop-policy.md`, `docs/adr/0002-adaptive-acceptance-proof.md`, `.codex-orchestrator/config.json`, `package.json`, and `tsconfig.json`; no `docs/INDEX.md` exists; `docs/agents/review-gates.md` is absent. `CONTEXT.md` distinguishes Runner, Agent, Rework Loop, and Runner-Owned Publication Boundary. `src/runner/scoped-auto-command.ts` and `src/runner/plan-auto-command.ts` both create attempt session artifacts, Runner state, Codex invocations, publishability checks, rework decisions, and lifecycle events. `src/runner/local-execution-session.ts` owns publishability. Existing tests cover scoped retry prompts, tree-child retry paths/events, and scoped missing-report recovery retry.
- **Assumptions:** The refactor is behavior-preserving except for adding tests and docs terminology. Existing command-level tests should remain the primary regression net.
- **Open Decisions:** None; the user selected candidate 1 and delegated plan plus implementation.

## 3. Architectural Design
- **Component Flow:** Command adapter prepares issue/worktree context -> `runAgentAttemptLoop` owns per-attempt session setup, prompt persistence, context snapshot, Runner state, Codex run/cleanup, publishability call, rework decision, and started/needs-rework/blocked lifecycle evidence -> command adapter handles promotion/blocked/review-ready terminal handoff exactly as today.
- **Simplest Viable Path:** Add one Application-layer Module, `agent-attempt.ts`, with this minimal Interface: `runAgentAttemptLoop(input) -> { publishability, sessionId, promptPath, reportPath, logPath, snapshotPath, reworkAttempts, lastAttemptStartedAt }`. Acceptance Proof evidence remains inside `publishability.acceptanceProofAttempt`; the Module does not interpret proof policy. Input includes mode-specific fields (`mode`, `phase`, optional `parentIssueNumber`, `baseBranch`, `createdAt`, `firstAttempt`, initial `rework`, `buildPrompt`, `buildSnapshotDecision`, `commitMessage`, optional `acceptanceProof`, and optional local phases for scoped). The Module calls `runImplementationPublishabilityCheck` and `decideImplementationRework`; it does not own terminal handoff.
- **Why Not Simpler:** Extracting only session-path or rework-prompt helpers would leave lifecycle ordering, Runner state, Codex cleanup, and retry decisions duplicated. The current two real adapters make this a real seam.
- **Architecture Lens:** Module: **Agent Attempt**. Interface: run one bounded Agent implementation attempt loop from an already prepared worktree and issue context to a publishability outcome plus exact attempt evidence. Seam: command modules call into the Agent Attempt Module after claim/worktree setup and before terminal handoff. Adapters: scoped issue command and tree-child command. Deletion test: deleting the Module would re-spread the same session/rework/publishability lifecycle across both command paths, so the Module earns Depth, Leverage, and Locality.
- **Clean Architecture Map:** Domain: `CONTEXT.md` term and Rework Loop vocabulary. Application/Use Case: `agent-attempt.ts`, `scoped-auto-command.ts`, `plan-auto-command.ts`, `local-execution-session.ts`. Infrastructure: Codex adapter, GitWorktreeManager, RunnerStateStore, RunnerLifecycleEventStore, filesystem paths. Presentation: CLI command results, GitHub comments, PR bodies remain unchanged.
- **Reuse Strategy:** Reuse `formatSessionTimestamp`, `sessionPromptPath`, `sessionReportPath`, `sessionLogPath`, `writeDurablePrompt`, `writeContextSnapshot`, `sessionCodexHomePath`, `cleanupSessionCodexHome`, `runImplementationPublishabilityCheck`, `decideImplementationRework`, `RunnerStateStore`, `RunnerLifecycleEventStore`, and the existing proof event append patterns. Move `sessionArtifacts` to the new Module or export a shared equivalent only if needed by both commands.
- **Rejected Paths:** Do not move issue claiming, label/comment mutation, PR creation, parent batching, child merging, Fresh-Context Review, or terminal handoff into Agent Attempt. Do not introduce generic factories, a speculative adapter registry, or proof-policy interpretation in the new Module. Do not change Acceptance Proof policy.

## 4. Constraints And Edge Cases
- **Data And Scale:** Attempts remain bounded by `max(loopPolicy.rework.maxAttempts, acceptanceProof.maxIterations - 1)`. No pagination or large payload changes. Prompt/report/log strings are existing bounded file paths.
- **Errors And Fallbacks:** Codex non-zero, missing completion report, invalid report, no changes, failed checks, and proof blockers must still flow through `runImplementationPublishabilityCheck` and `decideImplementationRework`. Isolated Codex home cleanup must happen in `finally` on every attempt. If no publishability result exists after the loop, preserve the current command-specific internal error.
- **Concurrency And State:** Parallel child execution still uses one attempt loop per child worktree. Runner state writes must preserve `parentIssueNumber` for tree-child and host/PID/lease fields for scoped issue. `createdAt` must stay the original command start time, while `updatedAt`, `attemptStartedAt`, and `lastAttemptStartedAt` use per-attempt timestamps. Rework retries must continue from the existing worktree and must not reset work.

## 5. Impacted Areas
- `CONTEXT.md`: add **Agent Attempt** term and relationship to Agent/Rework Loop.
- `src/runner/agent-attempt.ts`: new deep Module for attempt loop.
- `src/runner/scoped-auto-command.ts`: replace local attempt loop with scoped adapter call while keeping claim and terminal handoff.
- `src/runner/plan-auto-command.ts`: replace `executeChild` attempt loop internals with tree-child adapter call while keeping parent orchestration, batching, merging, and child terminal handling.
- `test/scoped-auto-command.test.ts`, `test/plan-auto-command.test.ts`, `test/scoped-recovery.test.ts`: preserve and, only if necessary, strengthen behavior tests for retry prompts, lifecycle events, state evidence, and recovery retry.

## 6. Execution Slices And Multi-Agent Model
- **Slices:** 0. Preflight (done for planning; re-check if files drift): source-of-truth reads from `execution-routing.md` before module ownership changes. 1. Domain/test tracer: add **Agent Attempt** to `CONTEXT.md`; identify the smallest public behavior gap. If existing scoped/tree-child tests already fail on drift, do not add redundant tests. 2. Scoped adapter: add `agent-attempt.ts` and route scoped issue attempts through it, preserving scoped recovery through `runScopedRecoveryRetry`. 3. Tree-child adapter: route `executeChild` through the same Module, preserving tree-child `parentIssueNumber`, lifecycle event status mapping, and retry prompt behavior. 4. Reconciliation: remove duplicated private helpers/imports made obsolete by the new Module; run validation.
- **Per-Slice Test/Proof:** Slice 1 proof: existing scoped rework and tree-child rework tests are the baseline public behavior; add a test only if state/lifecycle evidence is not currently asserted. Slice 2 proof: `npm run build && node --test dist/test/scoped-auto-command.test.js dist/test/scoped-recovery.test.js`. Slice 3 proof: `npm run build && node --test dist/test/plan-auto-command.test.js`. Slice 4 proof: `npm run typecheck`, `npm test`, `git diff --check`. No UI proof required.
- **Exit Gates:** Each behavior slice must build and pass its focused command tests before the next slice. Final gates: `npm run typecheck`, `npm test`, `git diff --check`. Skip live smoke because the user did not request it and it mutates real GitHub state.
- **Agent Matrix:** Phase | Owner | Input | Output | Dependencies
  | Plan/review | Main agent | selected candidate and source evidence | reviewed saved plan | none |
  | Scoped slice | Main agent | saved plan | scoped adapter using Agent Attempt | plan approved |
  | Tree-child slice | Main agent | scoped Module | tree-child adapter using Agent Attempt | scoped slice green |
  | Validation | Main agent | final diff | local test evidence | implementation complete |
- **Parallelization Limits:** Do not parallelize scoped and tree-child edits because both depend on the new Module Interface and shared imports. Do not run live smoke in parallel with local tests.

## 7. Implementation Handoff Contract
- **approval_state:** approved
- **approved_scope:** Behavior-preserving refactor of implementation attempt lifecycle for scoped issue and tree-child paths, plus minimal domain docs and tests.
- **do_not_touch:** Release files, package version, live-smoke scenarios, GitHub adapters, issue selection policy, Acceptance Proof policy, terminal handoff semantics, generated `dist/`, unless build output is created transiently by validation and left unstaged.
- **architecture_rules:** Agent Attempt owns attempt lifecycle state and events; command modules own issue/worktree setup and terminal handoff; `runImplementationPublishabilityCheck` remains the only publishability/proof-decision owner; `decideImplementationRework` remains the only Rework Loop classifier; Runner-Owned Publication Boundary stays in command/runner code and never moves to Agent; tests must cross public command behavior or the Agent Attempt Interface, not private helpers.
- **rejected_paths:** No broad execution engine, no adapter registry, no proof-policy refactor, no recovery-policy refactor, no publication changes, no live-smoke mutation.
- **required_docs:** Add **Agent Attempt** to `CONTEXT.md`; no ADR required because this refines ADR-0001 rather than changing it.
- **preconditions:** Existing local Node/npm install; no external services; no GitHub writes; repository can be locally divergent but changes must remain scoped.
- **phase_boundaries:** Preflight -> domain/test tracer -> scoped adapter -> tree-child adapter -> cleanup/reconciliation -> validation. Pause only if existing tests reveal behavior drift or repo state blocks local validation.
- **validation_gates:** `npm run build && node --test dist/test/scoped-auto-command.test.js dist/test/scoped-recovery.test.js`; `npm run build && node --test dist/test/plan-auto-command.test.js`; final `npm run typecheck`, `npm test`, `git diff --check`.
- **blocking_assumptions:** none
