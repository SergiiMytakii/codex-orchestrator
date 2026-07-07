---
title: "Agent-authored acceptance proof plan"
created_at: "2026-07-07T15:25:19+03:00"
source_type: "plan"
source_plan: "/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-07/1517-agent-authored-proof-plan.md"
source_issues:
  - "#1210 diagnostic failure: runner acceptance proof selected mobile visual proof for non-visual self-improvement work"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_verdict: "Approved"
---

## 1. Execution Context
- **Goal:** Make child agents declare the proof mode they intend to provide, then make the runner validate that declaration before selecting adaptive, command, or non-visual proof handling.
- **Source Material:** Plan `/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-07/1517-agent-authored-proof-plan.md`; ADR `/Users/serhiimytakii/Projects/codex-orchestrator/docs/adr/0002-adaptive-acceptance-proof.md`; Acceptance Proof docs in `/Users/serhiimytakii/Projects/codex-orchestrator/docs/deep-dive.md`; current failure evidence from #1210 where generic `Acceptance criteria` text plus configured mobile proof command produced `Native Android visual proof expected Gradle wrapper at gradlew`.
- **Approved Scope:** Extend scoped/issue-tree completion-report contract with `proofPlan`; prompt agents to fill it; validate `proofPlan` in the acceptance proof planning path; prevent accepted non-visual plans from falling through to browser/mobile command proof; narrow local config triggers after the validator exists; add focused regression tests and docs.
- **Out of Scope:** Changing the final `AcceptanceProofReport` schema; removing `reviewGates.visualProof`; adding a generic proof-provider registry; changing GitHub publication authority; changing release/version files; running `npm run smoke:live`; fixing #1210 worktree contents directly.
- **Simplest Viable Path:** Add a small `ProofPlan` contract to `ScopedCompletionReport`, add a pure proof-plan validator in the runner acceptance-proof planning layer, thread the implementation report into `planAcceptanceProofAttempt()`, and only use `runnerVisualProofPolicy().commandTemplate` when the accepted plan requires browser/mobile proof. Accepted non-visual proof uses a new report-validation plan kind that validates completion-report evidence; it never dispatches browser/mobile command proof.
- **Primary Risk:** A missing or invalid `proofPlan` could silently fall back to the current mobile command behavior, preserving the bug under a new contract.

## 2. Preconditions And Evidence
- **Required Services / Env / Fixtures:** Local Node/npm only. No live GitHub writes, mobile device, browser, Android SDK, or credentials are required for the implementation spec. Do not read or edit `.env` or `.env.*`.
- **Blocking Unknowns:** None after user decision: no legacy completion-report support. Missing `proofPlan` is always invalid for scoped and issue-tree completion reports after this change.
- **Confirmed Targets:** `src/runner/completion-report.ts` owns `ScopedCompletionReport`, `ValidationItem`, artifacts, report parsing, and report schema assertions. `src/runner/prompt.ts` owns scoped and issue-tree child prompt schemas via `buildScopedImplementationPrompt()` and `buildIssueTreeChildPrompt()`. `src/runner/review-gate-policy.ts` owns prompt guidance and delegates proof routing to `acceptance-proof-loop.ts`. `src/runner/acceptance-proof-loop.ts` owns `planAcceptanceProofAttempt()`, `runAcceptanceProofLoopAttempt()`, `decideProofRouting()`, `acceptanceProofApplies()`, and `runnerVisualProofPolicy()`. `src/runner/proof-strategy.ts` owns explicit issue `Proof Strategy:` parsing. `.codex-orchestrator/config.json` currently contains broad acceptance proof issue text patterns and `codex-orchestrator visual-proof mobile --issue ${issueNumber}`. Tests already exist in `test/acceptance-proof-loop.test.ts`, `test/prompt-builder.test.ts`, `test/review-gates.test.ts`, `test/completion-report.test.ts`, `test/local-execution-session.test.ts`, and fixtures under `test/fixtures/`.
- **Confirmed Commands:** `npm run build && node --test dist/test/completion-report.test.js dist/test/prompt-builder.test.js dist/test/acceptance-proof-loop.test.js dist/test/review-gates.test.js`; `npm run typecheck`; `npm test`; `git diff --check`.
- **Protected Paths / Rejected Approaches:** Do not edit `.env` or `.env.*`. Do not add hardcoded exceptions for self-improvement, backend, runner files, or #1210. Do not add broader regex routing. Do not let an agent-declared `none` bypass observable proof when issue/files require proof. Do not let accepted non-visual proof run browser/mobile command fallback. Do not make visual/mobile proof optional for accepted visual/mobile plans.
- **Architecture Lens:** Source of truth for proof selection becomes a `ProofPlan` planning contract plus runner validator. `AcceptanceProofReport` remains the evidence contract. The new validator must be a deep module with a small public interface and behavior tested through `planAcceptanceProofAttempt()`/`decideProofRouting()` or a named exported validator, not through private helper details. Deletion test: deleting the validator would put mode selection back into issue regex and mobile command fallback.

## Contract Test Ledger

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| `ScopedCompletionReport.proofPlan` accepts only supported modes and required fields. | Agents return ambiguous or malformed proof intent that the runner cannot audit. | Add RED tests in `test/completion-report.test.ts` for valid `non-visual-smoke`, `cli`, `api`, `worker`, `browser-visual`, `mobile-visual`, `none`, and invalid mode/missing reason/malformed arrays. | green |
| Scoped and issue-tree prompts require a `proofPlan` in final JSON and explain that agent intent is validated by the runner. | Child agents keep omitting proof intent, so runner falls back to heuristics. | Add RED tests in `test/prompt-builder.test.ts` for `buildScopedImplementationPrompt()` and `buildIssueTreeChildPrompt()` schema text and mode guidance. | green |
| Explicit issue `Proof Strategy:` is an upper-bound contract. | Agent weakens a visual/mobile issue into non-visual proof. | Add RED tests in `test/acceptance-proof-loop.test.ts` for `Proof Strategy: mobile-visual` rejecting `proofPlan.mode: non-visual-smoke`, and `Proof Strategy: non-visual-smoke` accepting non-visual modes. | green |
| Accepted non-visual `proofPlan` prevents browser/mobile command fallback even when acceptance proof patterns match generic `Acceptance criteria` text. | #1210 failure repeats with `codex-orchestrator visual-proof mobile --issue ...`. | Add RED test in `test/acceptance-proof-loop.test.ts` using self-improvement changed files, issue body with `Acceptance criteria:`, configured mobile command, and `proofPlan.mode: non-visual-smoke`; expected plan is `kind: "report-validation"`, never `kind: "command"` with mobile command. | green |
| Obvious UI/mobile changed files cannot be downgraded to non-visual proof unless the issue explicitly declares non-visual strategy and files are not user-facing. | Visual regressions publish with only CLI/test evidence. | Add RED table tests in `test/acceptance-proof-loop.test.ts` for frontend/mobile paths rejecting non-visual plan and accepting browser/mobile plans. | green |
| Missing `proofPlan` is a report-contract failure, not silent mobile fallback. | Child agents fail to follow the contract and runner preserves old behavior. | Add RED completion-report and local-session or acceptance-loop tests proving reports without `proofPlan` are invalid/rework/block and never reach mobile command fallback. | green |
| Non-visual report-validation requires concrete evidence in the completion report. | Agent declares non-visual proof but provides no observable proof. | Add RED tests proving `non-visual-smoke`, `cli`, `api`, and `worker` require at least one passed matching `validationCommands` entry or one existing matching `requiredArtifacts` entry, plus non-empty `reviewHandoff.proofByAcceptanceCriteria`. | green |
| Config generic triggers are guardrails, not final command source for valid proof plans. | `acceptance`, `proof`, or `smoke` regexes continue to decide mobile proof after validator integration. | Add RED test in `test/review-gates.test.ts` or `test/acceptance-proof-loop.test.ts` where valid `cli`/`non-visual-smoke` plan plus generic text does not dispatch visual/mobile. | green |

## Risk Controls
- **Source of Truth:** `src/runner/completion-report.ts` owns the `ProofPlan` DTO and schema validation. `src/runner/acceptance-proof-loop.ts` owns proof-plan compatibility validation and final proof producer selection. `src/runner/proof-strategy.ts` remains the source for issue/config proof strategy parsing.
- **Safety Constraints:** The implementation agent can declare intent but cannot force pass. Runner still validates the proof report, artifacts, changed files, scope isolation, configured checks, review gates, and publication safety. A `proofPlan.mode: none` is valid only when acceptance proof is disabled/not applicable or issue strategy permits none.
- **Contract Constraints:** Do not change the final `AcceptanceProofReport` JSON schema in `src/runner/acceptance-proof.ts`. `ProofPlan` belongs to the child completion report and prompt/report contract only. Existing `ValidationItem` and `artifacts` semantics remain unchanged. Non-visual `report-validation` validates the child completion report; browser/mobile/adaptive command proof continues to validate `AcceptanceProofReport`.
- **Concurrency / State Constraints:** The validator must be pure and side-effect free. It must not run shell commands, read artifact contents, mutate GitHub, or inspect live state. Proof execution remains inside the existing bounded Acceptance Proof Loop and `maxIterations`.
- **Forbidden Scope:** No proof provider registry, no new adapter abstraction, no #1210-only path exception, no broad self-improvement special case, no live smoke execution by default, no release metadata changes.
- **Early Review Gate:** After Slice 3, run `$code-review` focused on proof-plan precedence, visual downgrade rejection, missing-plan behavior, no legacy proof compatibility, and whether any command fallback can still override accepted non-visual intent.
- **Final Handoff Requirements:** Final implementation response must include contract implemented, proof-plan modes supported, invariants proved, review findings/fixes, validation commands, skipped checks, residual risks, and files by role.

## Write Scope Summary
- `src/runner/completion-report.ts` - Update; add `ProofPlan` type/schema validation and required `proofPlan` to `ScopedCompletionReport`.
- `src/runner/prompt.ts` - Update; prompt scoped and issue-tree child agents to return `proofPlan` in final JSON.
- `.codex-orchestrator/prompts/workflows/scoped-implementation.md` - Update only if runtime prompt text depends on bundled workflow instructions beyond `prompt.ts`.
- `src/runner/acceptance-proof-loop.ts` - Update; add validator, add `report-validation` plan kind, and consume `implementationReport.proofPlan` before command fallback.
- `src/runner/review-gate-policy.ts` - Update proof guidance only if `prompt.ts` cannot make `Proof Strategy` and `proofPlan` ownership clear on its own.
- `.codex-orchestrator/config.json` - Update; remove or narrow broad acceptance proof trigger patterns only after validator tests are green.
- `docs/deep-dive.md` - Update; document Proof Plan ownership and runner validation.
- Tests named in the Contract Test Ledger - Update/add behavior-first coverage.

## 3. Execution Slices

### Progress Discipline
- [x] Update this checklist as work is completed.
- [x] Leave blocked work unchecked with a short `Blocked:` note.
- [x] Stop if repo reality contradicts a confirmed target, command, precondition, or scope boundary.
- [x] Keep each implementation phase as a vertical tracer-bullet slice, not a horizontal layer pass.
- [x] Start each behavior-changing slice with the named RED test/proof before implementation work.
- [x] Update the Contract Test Ledger status as each invariant moves planned -> red -> green or blocked.
- [x] Run the early `$code-review` checkpoint after Slice 3 before policy cleanup.

### Slice 1 - Completion Report ProofPlan Contract
- [x] Objective: Make proof intent a structured child report contract.
- [x] Test/Proof First: Add RED tests in `test/completion-report.test.ts` for valid and invalid `proofPlan` values. Valid initial shape:
  `proofPlan: { "mode": "none" | "non-visual-smoke" | "cli" | "api" | "worker" | "browser-visual" | "mobile-visual", "reason": string, "validationCommands": string[], "requiredArtifacts": string[], "visualTarget"?: "browser" | "mobile" }`.
- [x] Target: `src/runner/completion-report.ts`
  - [x] Action: Export `proofPlanModes`, `ProofPlanMode`, and `ProofPlan`.
  - [x] Action: Add required `proofPlan: ProofPlan` to `ScopedCompletionReport`.
  - [x] Action: Add `assertProofPlan()` and call it from `assertScopedCompletionReport()`.
  - [x] Action: Require non-empty `reason`; require string arrays for `validationCommands` and `requiredArtifacts`; require `visualTarget` only to be absent or `browser`/`mobile`.
  - [x] Action: Reject missing `proofPlan`; do not add any legacy compatibility branch.
  - [x] Validation: Completion report tests prove valid modes parse and invalid mode/missing reason/malformed arrays/missing proofPlan fail with deterministic errors.

### Slice Exit Gate
- [x] `npm run build && node --test dist/test/completion-report.test.js`

### Slice 2 - Prompt And Report Wiring
- [x] Objective: New scoped and issue-tree child prompts require the agent to declare proof intent.
- [x] Test/Proof First: Add RED tests in `test/prompt-builder.test.ts` proving `buildScopedImplementationPrompt()` and `buildIssueTreeChildPrompt()` include `proofPlan` in schema text, supported modes, and the rule that runner validates the plan.
- [x] Target: `src/runner/prompt.ts`
  - [x] Action: Update scoped and issue-tree completion report schema strings to include `proofPlan`.
  - [x] Action: Add concise prompt lines: choose the narrowest proof mode that proves the issue; do not choose non-visual for UI/mobile behavior; do not choose `none` when acceptance criteria need observable proof; runner may reject the plan.
  - [x] Action: Keep existing `buildVisualProofPromptLines()` output, but make it subordinate to the new proof-plan contract. Do not remove current explicit `Proof Strategy:` prompt lines.
  - [x] Validation: Prompt tests pass and existing explicit non-visual prompt tests still pass.
- [x] Target: `.codex-orchestrator/prompts/workflows/scoped-implementation.md`
  - [x] Action: Inspect whether it duplicates final JSON schema/proof instructions. If it does, update it consistently; if not, leave unchanged and note in final handoff.

### Slice Exit Gate
- [x] `npm run build && node --test dist/test/prompt-builder.test.js`

### Slice 3 - Runner ProofPlan Validator
- [x] Objective: Validate agent-declared proof mode against issue strategy, changed files, and existing visual routing signals before any proof producer is selected.
- [x] Test/Proof First: Add RED table tests in `test/acceptance-proof-loop.test.ts` for accepted non-visual CLI/API/worker modes, rejected non-visual visual/mobile downgrades, accepted browser/mobile visual plans, `Proof Strategy` upper-bound enforcement, explicit `none`, invalid missing-plan behavior through completion-report parsing, and #1210-style generic `Acceptance criteria` text with self-improvement files.
- [x] Target: `src/runner/acceptance-proof-loop.ts`
  - [x] Action: Change `AcceptanceProofPlanKind` to `'skip' | 'adaptive' | 'command' | 'report-validation' | 'blocked'`.
  - [x] Action: Extend `AcceptanceProofPlanInput` with required `implementationReport: ScopedCompletionReport`.
  - [x] Action: Add exported type `ProofPlanValidationResult = { ok: true; proofPlan: ProofPlan; proofMode: ProofPlanMode; dispatchTarget: VisualProofDispatchTarget; reason: string } | { ok: false; blocker: string; retryable: boolean }`.
  - [x] Action: Add exported function `validateProofPlan(input: { config: CodexOrchestratorConfig; issue: GitHubIssue; changedFiles: string[]; implementationReport: ScopedCompletionReport }): ProofPlanValidationResult`.
  - [x] Action: Validation precedence: explicit issue `Proof Strategy` > `proofPlan` > config default. The agent may choose an equal or stronger concrete mode, never weaker. `visual` must resolve to `browser-visual` or `mobile-visual` before execution.
  - [x] Action: Reject non-visual modes for changed paths that `proofStrategyDispatchTarget()` classifies as browser/mobile unless the issue explicitly says `Proof Strategy: non-visual-smoke` and changed files are not visual/mobile user-facing paths.
  - [x] Action: For accepted `none`, skip acceptance proof only when `acceptanceProofApplies()` is false or issue/config strategy permits `none`; otherwise return a blocker/rework reason.
  - [x] Action: Do not implement legacy missing-plan compatibility. Missing `proofPlan` is rejected in `completion-report.ts` before acceptance proof planning.
  - [x] Action: `decideProofRouting()` must stop calling `planAcceptanceProofAttempt()` because prompt/review routing does not have an implementation report. It should compute non-execution applicability/desirability directly from strategy, issue, changed files, and config.
  - [x] Validation: Focused acceptance-loop tests prove validator decisions without shell/browser/mobile execution.

### Slice Exit Gate
- [x] `npm run build && node --test dist/test/acceptance-proof-loop.test.js`

### Review Checkpoint
- [x] Run `$code-review` on Slice 1-3 diff before policy cleanup.
- [x] Review Focus: proof-plan source-of-truth ownership; precedence with issue `Proof Strategy`; non-visual downgrade rejection; missing-plan behavior; absence of any legacy missing-plan fallback; command fallback cannot override accepted non-visual plan; no new adapter abstraction.

### Slice 4 - Acceptance Loop Integration
- [x] Objective: Use the accepted proof plan to choose actual proof execution and block/rework invalid plans with durable evidence.
- [x] Test/Proof First: Add RED tests in `test/local-execution-session.test.ts` proving publishability passes report `proofPlan` into `runAcceptanceProofLoopAttempt()` and that invalid/missing plan blocks before mobile command execution.
- [x] Target: `src/runner/local-execution-session.ts`
  - [x] Action: Pass `implementationReport: report` into `runAcceptanceProofLoopAttempt()` / `planAcceptanceProofAttempt()`.
  - [x] Action: Preserve existing acceptance proof evidence output, validation lines, residual risks, blockers, and `acceptanceProofAttempt` behavior.
- [x] Target: `src/runner/acceptance-proof-loop.ts`
  - [x] Action: In `planAcceptanceProofAttempt()`, evaluate valid `proofPlan` before `runnerVisualProofPolicy(input.config).commandTemplate`.
  - [x] Action: For accepted non-visual modes (`non-visual-smoke`, `cli`, `api`, `worker`), return `kind: "report-validation"` with reason `agent-authored non-visual proof plan accepted`.
  - [x] Action: Implement `evaluateReportValidationProof(input: { implementationReport: ScopedCompletionReport; proofPlan: ProofPlan; changedFiles: string[] }): AcceptanceProofLoopOutcome`. It returns `passed` only when: `proofPlan.validationCommands.length + proofPlan.requiredArtifacts.length > 0`; every `validationCommands` entry exactly matches a `report.validation[].command` with `status: "passed"`; every `requiredArtifacts` entry exactly matches a `report.artifacts[].path` or `report.artifacts[].url`; and `report.reviewHandoff?.proofByAcceptanceCriteria` is a non-empty string array. It returns `blocked` with validation command `acceptance proof plan report validation` otherwise.
  - [x] Action: `report-validation` outcome must not call `executeAdaptiveProof`, `executeCommandProof`, `createAcceptanceProofDiffCapture`, or `collectChangeSet`; it returns `changedFiles: input.initialChangedFiles`, `artifacts: implementationReport.artifacts`, and no `AcceptanceProofAttemptEvidence` unless an existing builder can represent it without changing `AcceptanceProofReport`.
  - [x] Action: For accepted browser/mobile modes, preserve existing adaptive-vs-command behavior and command template selection.
  - [x] Action: For invalid plan, return a plan kind/status that `runAcceptanceProofLoopAttempt()` converts into a blocked outcome with a clear blocker such as `Invalid proofPlan: non-visual proof cannot satisfy mobile visual strategy`.
  - [x] Validation: #1210-style regression cannot run mobile proof; existing command/adaptive proof tests still pass.

### Slice Exit Gate
- [x] `npm run build && node --test dist/test/acceptance-proof-loop.test.js`

### Slice 5 - Policy Cleanup And Docs
- [x] Objective: Make config text patterns guardrails rather than the final command router and document the new contract.
- [x] Test/Proof First: Add or update tests in `test/review-gates.test.ts` proving generic `Acceptance criteria` text alone no longer forces browser/mobile command dispatch when a valid non-visual plan exists.
- [x] Target: `.codex-orchestrator/config.json`
  - [x] Action: Remove exactly these broad `reviewGates.acceptanceProof.issueTextPatterns` entries after validator integration is green: `acceptance`, `proof`, and `smoke`. Keep the rest of the current array unchanged: `\\bUI\\b`, `frontend`, `responsive`, `layout`, `visual`, `screenshot`, `\\bAPI\\b`, `worker`, `\\bCLI\\b`, `скриншот`, `скріншот`, `viewport`, `dark theme`, `мобіл`, `mobile`.
- [x] Target: `src/runner/review-gate-policy.ts`
  - [x] Action: Update prompt messaging so `Proof Strategy:` and `proofPlan` roles are clear: issue strategy is the policy bound, proofPlan is the agent's selected proof mode, runner validation is final.
- [x] Target: `docs/deep-dive.md`
  - [x] Action: Add concise documentation that child agents declare `proofPlan`, runner validates it, non-visual plans must provide command/artifact evidence, and accepted non-visual plans do not dispatch browser/mobile proof.
  - [x] Validation: Docs match implemented modes and tests.

### Slice Exit Gate
- [x] `npm run build && node --test dist/test/review-gates.test.js dist/test/prompt-builder.test.js dist/test/acceptance-proof-loop.test.js`

### Slice 6 - Final Validation And Review
- [x] Objective: Prove the full runner contract and prepare implementation handoff.
- [x] Test/Proof First: No new behavior test; this is reconciliation.
- [x] Action: Run `npm run typecheck`.
- [x] Action: Run `npm test`.
- [x] Action: Run `git diff --check`.
- [x] Action: Run `$cleanup-review` and final `$code-review` because this changes runner contract and publication safety.
- [x] Review Fixes: Removed remaining `visualProof` -> `acceptanceProof` fallback behavior, prevented non-visual prompt routes from saying a visual command will run, and rejected blank proof evidence entries.
- [x] Action: Do not run `npm run smoke:live` or rerun daemon #1210 unless user explicitly requests live runner execution after local tests pass.

### Slice Exit Gate
- [x] Full validation and review gates pass or blocked/skipped checks are recorded with exact reasons.

## 4. Validation And Done Criteria
- [x] **Lint/Format:** `git diff --check`.
- [x] **Typecheck:** `npm run typecheck`.
- [x] **Tests:** focused built test commands per slice plus final `npm test`.
- [x] **Architecture Check:** No separate architecture-check script confirmed; used source docs plus cleanup/code-review gates.
- [x] **Live/Manual Validation:** Not applicable by default. Do not run `npm run smoke:live`; do not rerun daemon #1210 unless explicitly requested after local validation.
- [x] **Behavior Proof:** Contract Test Ledger rows green, especially the #1210-style regression where generic `Acceptance criteria` plus non-visual runner files cannot select mobile proof.
- [x] **Final Reconciliation:** all unchecked work is finished or intentionally not applicable.
- [x] **Final Handoff Requirements:** final response must include contract implemented, proof-plan modes supported, high-risk checkpoint result, main invariants proved, cleanup/code-review findings and fixes, validation commands, skipped checks, residual risks, and files by role.

## 5. Final Action
After saving the file, respond in chat with exactly:

Spec Status: Ready / Blocked
Saved Path: docs/implementation-specs/2026-07-07/1525-agent-authored-acceptance-proof-plan.md
Execution Model: Single-Agent
Review Verdict: <implementation-spec-review verdict>
Validation Gates: Local Tests
Blockers: <unresolved blockers or None>
