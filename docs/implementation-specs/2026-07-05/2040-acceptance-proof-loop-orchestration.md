---
title: "Acceptance Proof Loop orchestration implementation"
created_at: "2026-07-05T20:40:40+03:00"
source_type: "plan"
source_plan: "/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-05/2025-acceptance-proof-loop-orchestration.md"
source_issues:
  - "None"
status: "implemented"
execution_model: "single-agent"
spec_mode: "full"
review_verdict: "Approved"
---

## 1. Execution Context
- **Goal:** Implement a single Acceptance Proof Loop application module that owns one-attempt proof routing, adapter choice, proof diff capture, post-proof scope inputs, Proof Report evaluation outcome assembly, and `AcceptanceProofAttemptEvidence` construction.
- **Source Material:** Approved user direction plus plan at `/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-05/2025-acceptance-proof-loop-orchestration.md`.
- **Approved Scope:** Add `src/runner/acceptance-proof-loop.ts`; preserve `src/runner/acceptance-proof.ts` as pure domain/evaluation; adjust `src/runner/acceptance-proof-runner.ts`, `src/runner/visual-proof-runner.ts`, `src/runner/local-execution-session.ts`, and `src/runner/review-gate-policy.ts` so proof routing, diff/scope handling, and evidence assembly are centralized; add/update focused tests.
- **Out of Scope:** GitHub publication authority changes; live smoke execution; Proof Report JSON schema changes unless a test proves a missing field; new UI proof tooling; multi-iteration retry implementation; removal of `reviewGates.visualProof`; unrelated cleanup; release/package workflow changes.
- **Simplest Viable Path:** Create `acceptance-proof-loop.ts` as a thin application/use-case owner around existing pure helpers and adapter callbacks. Move decisions out of `local-execution-session.ts` and routing wrappers out of `review-gate-policy.ts` without moving shell/Codex execution into the pure domain module.
- **Primary Risk:** Creating a second source of truth for proof evidence, diff classification, or routing, or introducing an import cycle between the new loop module and legacy command/runner wrappers.

## 2. Preconditions And Evidence
- **Required Services / Env / Fixtures:** None for unit tests. Node/npm and Git are required by existing test helpers. Do not require live GitHub credentials, browser/device tooling, or `npm run smoke:live`.
- **Current Dirty State Precondition:** Before implementation, run `git status --short` and preserve unrelated work. At spec creation time the relevant known untracked file is `docs/plans/2026-07-05/2025-acceptance-proof-loop-orchestration.md`; the executor must not stage or rewrite unrelated user work without explicit request.
- **Blocking Unknowns:** None.
- **Confirmed Targets:**
  - `src/runner/acceptance-proof.ts` owns pure report schema/evaluation/diff helpers and exports `AcceptanceProofAttemptEvidence`, `createAcceptanceProofDiffCapture`, `classifyAcceptanceProofDiff`, `buildAcceptanceProofReportOutcome`, `buildBlockedAcceptanceProofOutcome`, and `buildForbiddenAcceptanceProofDiffEvidence`.
  - `src/runner/acceptance-proof-runner.ts` currently runs adaptive proof Codex sessions and must keep prompt/session execution details.
  - `src/runner/visual-proof-runner.ts` currently runs runner-owned command proof and must keep shell execution, env setup, and screenshot freshness detection.
  - `src/runner/local-execution-session.ts` currently owns proof branching, runner proof diff capture, forbidden proof diff blocking, and post-proof scope isolation.
  - `src/runner/review-gate-policy.ts` currently exports `decideProofRouting`, `shouldApplyVisualProofGate`, `classifyVisualProofDispatchTarget`, and `runnerVisualProofPolicy`.
  - `src/runner/scope-isolation-policy.ts` exports `evaluateScopeIsolation`; `src/runner/proof-strategy.ts` exports `resolveAcceptanceProofStrategy`.
- **Confirmed Commands:**
  - Focused after build as needed: `npm run build --silent && node --test dist/test/acceptance-proof-loop.test.js`
  - Existing focused tests as needed: `npm run build --silent && node --test dist/test/review-gates.test.js dist/test/visual-proof-runner.test.js dist/test/local-execution-session.test.js dist/test/acceptance-proof.test.js`
  - Final: `npm run typecheck`
  - Final: `npm test`
  - Final: `git diff --check`
- **Protected Paths / Rejected Approaches:** Do not read or edit `.env` or `.env.*`. Do not run `npm run smoke:live` unless the user explicitly requests it. Do not make `acceptance-proof.ts` import adapters, shell/git, `review-gate-policy.ts`, or `local-execution-session.ts`. Do not allow proof agents/adapters to mutate GitHub labels/comments/PRs/branches. Do not allow screenshot-only pass or product-code proof repair acceptance. Do not use legacy `visualProof` policy to expand proof-owned mutation paths. Do not remove legacy config before compatibility tests pass.
- **Architecture Lens:** New module: `acceptance-proof-loop.ts`. Interface: exactly `planAcceptanceProofAttempt` and `runAcceptanceProofLoopAttempt`. Seam: two concrete current adapters exist, adaptive proof and runner-owned command proof; use the raw adapter result interfaces below, not a factory framework. Deletion test: deleting the loop module would re-scatter routing, diff capture, report evaluation, forbidden diff handling, and scope isolation back into existing callers.
- **Loop API Contract:** `src/runner/acceptance-proof-loop.ts` must export these names exactly:

```ts
export type AcceptanceProofPlanKind = 'skip' | 'adaptive' | 'command';

export interface AcceptanceProofPlan {
  kind: AcceptanceProofPlanKind;
  applies: boolean;
  reason: string;
  commandTemplate?: string;
}

export interface AcceptanceProofPlanInput {
  config: CodexOrchestratorConfig;
  issue: GitHubIssue;
  changedFiles: string[];
  adaptiveAdapterAvailable: boolean;
}

export interface AcceptanceProofAdapterResult {
  adapterKind: 'adaptive' | 'command';
  command: string;
  exitCode: number;
  outputSummary: string;
  promptPath?: string;
  reportPath: string;
  artifactDir: string;
  artifactPaths: string[];
  preliminaryArtifacts: ScopedCompletionReport['artifacts'];
  residualRisks: string[];
}

export interface AcceptanceProofLoopOutcome {
  status: 'passed' | 'blocked' | 'skipped';
  changedFiles: string[];
  validation: RunnerValidationLine[];
  artifacts: ScopedCompletionReport['artifacts'];
  residualRisks: string[];
  blockers: string[];
  scopeBlockers: string[];
  evidence?: AcceptanceProofAttemptEvidence;
  proofReportPath?: string;
  proofArtifactDir?: string;
}
```

- **Plan Semantics:** `planAcceptanceProofAttempt(input)` must return `skip` when acceptance proof does not apply. If acceptance proof applies and `adaptiveAdapterAvailable` is true and either an `acceptance-proof` Codex profile exists or no runner command template is configured, return `adaptive`. Else if acceptance proof applies and a runner command template exists, return `command`. Else return `skip` with a validation-ready reason that proof applies but no adaptive adapter or runner command is available; existing review gates may convert that lack of proof into warning/block according to policy.
- **Run Semantics:** `runAcceptanceProofLoopAttempt` must accept callbacks for `executeAdaptiveProof`, `executeCommandProof`, `collectChangeSet`, `evaluateScope`, and `artifactExists`. It must call `planAcceptanceProofAttempt`, create the proof diff baseline before executing the selected adapter, execute exactly one selected adapter, collect final changed files once after adapter execution using provided `beforeHead`, evaluate the Proof Report via `acceptance-proof.ts`, classify proof-phase diff via `reviewGates.acceptanceProof.proofOwnedPathGlobs`, run scope evaluation on full final changed files, and build the only final `AcceptanceProofAttemptEvidence` for the attempt.
- **Contract Test Ledger:**

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| `acceptance-proof.ts` remains pure and never imports adapters/policy/local-session infrastructure. | Domain/evaluation module becomes a god module or import-cycle source. | `npm run typecheck` plus code-review import audit after Slice 2. | green |
| `planAcceptanceProofAttempt` is the only source for adaptive/command/skip/non-visual routing decisions; legacy wrappers delegate. | `review-gate-policy.ts` and local session disagree about proof applicability. | RED test in `test/acceptance-proof-loop.test.ts` for adaptive, command, skip, non-visual; regression in `test/review-gates.test.ts` wrapper delegation. | green |
| `runAcceptanceProofLoopAttempt` owns before/after diff capture and final change-set recollection using provided `beforeHead`; adapters cannot classify forbidden product diffs. | Product-code proof mutations pass or block inconsistently depending on adapter path. | RED loop-interface test in `test/acceptance-proof-loop.test.ts` for proof-owned artifact diff vs forbidden product diff. | green |
| Post-proof scope isolation evaluates full final changed paths, while forbidden proof diff evaluates proof-phase changed paths. | Stale or partial changed-file sets skip scope blockers or misclassify initial implementation changes as proof mutations. | RED loop-interface test with distinct `initialChangedFiles`, proof-phase changed files, and injected scope blocker. | green |
| Adaptive proof and command proof produce the same `AcceptanceProofAttemptEvidence` vocabulary for missing, invalid, needs-rework, blocked, and passed outcomes. | Handoff output and rework routing depend on which proof adapter ran. | RED parity tests in `test/acceptance-proof-loop.test.ts` using raw adapter results for both adapter kinds. | green |
| `reviewGates.acceptanceProof.proofOwnedPathGlobs` is the only allowlist for proof-owned mutations during migration. | Legacy `visualProof` compatibility silently permits product-code proof edits. | RED compatibility test where legacy visual command is selected but only acceptanceProof proof-owned paths are allowed. | green |

## Risk Controls
- **Source of Truth:** `src/runner/acceptance-proof-loop.ts` owns proof attempt orchestration and final `AcceptanceProofAttemptEvidence` assembly. `src/runner/acceptance-proof.ts` owns only pure domain/evaluation helpers. `reviewGates.acceptanceProof` owns proof-owned mutation paths.
- **Safety Constraints:** Keep runner-owned publication boundaries intact; proof adapters may produce local evidence and artifacts only. No GitHub write authority, branch/PR mutation, labels, comments, package publication, or live smoke is introduced.
- **Contract Constraints:** Raw adapter result shape is exactly `AcceptanceProofAdapterResult` above. Final evidence construction happens only in `acceptance-proof-loop.ts`.
- **Concurrency / State Constraints:** `runAcceptanceProofLoopAttempt` must create the proof baseline before adapter execution, collect final changed files once after adapter execution using `beforeHead`, classify proof-phase diff from the baseline, and run scope evaluation against full final changed paths.
- **Forbidden Scope:** No abstract adapter factory beyond the two concrete current adapters. No schema migration. No compatibility branch that preserves independent routing logic. No import cycle between `visual-proof-runner.ts` and `acceptance-proof-loop.ts`.
- **Early Review Gate:** After Slice 2, run `$code-review` on `src/runner/acceptance-proof-loop.ts`, `src/runner/acceptance-proof.ts`, adapter changes, and new loop tests before local-session integration. Review must focus on import cycles, one evidence owner, proof diff vs full change-set separation, and legacy visual proof allowlist leakage.
- **Final Handoff Requirements:** Executor's implementation completion response must include contract implemented, early review checkpoint result, main invariants proved, cleanup/code-review findings and fixes, validation commands, skipped checks, residual risks, and files by role.

## Write Scope Summary
- `src/runner/acceptance-proof-loop.ts` - Create; application/use-case owner for planning/running one proof attempt; reuse helpers from `acceptance-proof.ts`, `proof-strategy.ts`, `scope-isolation-policy.ts`, and adapter callbacks.
- `src/runner/acceptance-proof.ts` - Update only for pure helper/types needed by the loop; no adapter/policy/local-session imports.
- `src/runner/acceptance-proof-runner.ts` - Update to expose/return `AcceptanceProofAdapterResult` for adaptive proof and keep Codex prompt/session execution.
- `src/runner/visual-proof-runner.ts` - Update to expose/return `AcceptanceProofAdapterResult` for command proof while keeping shell/env/screenshot behavior and public compatibility behavior.
- `src/runner/local-execution-session.ts` - Update to call the loop once and remove duplicated proof branching/diff/scope outcome logic.
- `src/runner/review-gate-policy.ts` - Move routing logic to the loop planning API or make wrappers delegate without local fallback branches; keep prompt and runner visual policy helpers only where needed.
- `test/acceptance-proof-loop.test.ts` - Create focused contract tests for planning, adapter outcome normalization, diff/scope ownership, and parity.
- `test/review-gates.test.ts`, `test/visual-proof-runner.test.ts`, `test/local-execution-session.test.ts`, `test/acceptance-proof.test.ts` - Update only as needed to preserve public behavior and wrapper delegation.
- `docs/implementation-specs/2026-07-05/2040-acceptance-proof-loop-orchestration.md` - Update checklist during implementation.

## 3. Execution Slices

### Progress Discipline
- [x] Update this checklist as work is completed.
- [x] Leave blocked work unchecked with a short `Blocked:` note.
- [x] Stop if repo reality contradicts a confirmed target, command, precondition, or scope boundary.
- [x] Keep each implementation phase as a vertical tracer-bullet slice, not a horizontal layer pass.
- [x] Start each behavior-changing slice with a behavior-first RED test/proof before implementation work.
- [x] Update the Contract Test Ledger status as each invariant moves planned -> red -> green or blocked.
- [x] Run the Early Review Gate after Slice 2 before local-session integration.
- [x] Before Slice 1, run `git status --short` and inspect diffs for planned target files if present. Preserve unrelated existing work.

### Slice 1 - Boundary Planning API
- [x] Objective: A public loop planning API becomes the single source for proof applicability and adapter choice while preserving legacy routing wrapper behavior.
- [x] Test/Proof First: Add failing tests in `test/acceptance-proof-loop.test.ts` for `planAcceptanceProofAttempt` covering adaptive proof when `adaptiveAdapterAvailable: true` and an `acceptance-proof` Codex profile exists, adaptive proof when `adaptiveAdapterAvailable: true` and no runner command is configured, command proof when `reviewGates.acceptanceProof.runnerValidationCommand` is configured and adaptive is not selected, skip for non-applicable issues, skip for applicable proof with no command and `adaptiveAdapterAvailable: false`, and non-visual behavior for `Proof Strategy: non-visual-smoke`. Add/update one `test/review-gates.test.ts` assertion proving `decideProofRouting` or `shouldApplyVisualProofGate` delegates to the new planning API without independent strategy branches.
- [x] Target: `src/runner/acceptance-proof-loop.ts`
  - [x] Action: Create the module with `planAcceptanceProofAttempt`, `AcceptanceProofPlanInput`, `AcceptanceProofPlan`, `AcceptanceProofAdapterResult`, and `AcceptanceProofLoopOutcome` exactly as named above.
  - [x] Validation: New planning tests fail before implementation and pass after.
- [x] Target: `src/runner/review-gate-policy.ts`
  - [x] Action: Move routing ownership to the loop or leave `decideProofRouting`, `shouldApplyVisualProofGate`, and `classifyVisualProofDispatchTarget` as thin delegating wrappers; keep prompt and `runnerVisualProofPolicy` helpers only if still needed.
  - [x] Validation: Existing `test/review-gates.test.ts` routing cases still pass.

### Slice 1 Exit Gate
- [x] `npm run build --silent && node --test dist/test/acceptance-proof-loop.test.js dist/test/review-gates.test.js`

### Slice 2 - Loop-Owned Adapter Outcome, Diff, And Scope Contract
- [x] Objective: The loop owns raw adapter result normalization, Proof Report evaluation, before/after diff capture, forbidden proof diff blocking, and post-proof scope blockers for command proof.
- [x] Test/Proof First: Add focused failing tests in `test/acceptance-proof-loop.test.ts` for command proof raw results: valid report passes; missing report or screenshot-only output blocks; nonzero exit with otherwise passing report blocks; proof-owned artifact mutation is allowed; product-code proof mutation blocks; injected scope blocker from final changed paths blocks and appears as `scopeBlockers`.
- [x] Target: `src/runner/acceptance-proof-loop.ts`
  - [x] Action: Add `runAcceptanceProofLoopAttempt` using the exact plan/run semantics above. It must accept callbacks for `executeAdaptiveProof`, `executeCommandProof`, `collectChangeSet`, `evaluateScope`, and `artifactExists`.
  - [x] Validation: New command outcome/diff/scope tests pass.
- [x] Target: `src/runner/visual-proof-runner.ts`
  - [x] Action: Split raw command proof execution/result production from compatibility evidence assembly if needed. Keep shell command env setup, package CLI resolution, screenshot artifact detection, and public behavior. Avoid importing the loop from a file the loop imports.
  - [x] Validation: `test/visual-proof-runner.test.ts` still passes or is updated only to assert same public behavior through the loop.
- [x] Target: `src/runner/acceptance-proof.ts`
  - [x] Action: Add only pure helper/type extractions required by the loop. Do not import adapters, review policy, git, shell, or local-session code.
  - [x] Validation: `test/acceptance-proof.test.ts` still passes.

### Slice 2 Exit Gate
- [x] `npm run build --silent && node --test dist/test/acceptance-proof-loop.test.js dist/test/visual-proof-runner.test.js dist/test/acceptance-proof.test.js`
- [x] Run Early Review Gate: `$code-review` on the Slice 1-2 diff with the Review Focus below. Continue only after high-confidence findings are fixed or explicitly blocked.
  - Review result: blocked once for scope-blocked proof attempts returning passed proof evidence; fixed by adding scope failed validation and folding scope blockers into final `AcceptanceProofAttemptEvidence`.

### Review Focus
- Import direction and cycles: `acceptance-proof.ts` stays pure; loop can depend on adapters only through callbacks or raw functions without cycles.
- Evidence ownership: exactly one place builds final `AcceptanceProofAttemptEvidence` for proof-loop outcomes.
- Diff correctness: proof-phase diff and full final changed files are separate, and product-code proof mutations cannot pass.
- Scope correctness: post-proof scope isolation uses full final changed paths, not adapter artifact paths.
- Migration safety: legacy `visualProof` compatibility cannot expand proof-owned mutation allowlists or reintroduce independent routing.

### Slice 3 - Local Session Integration
- [x] Objective: Publishability uses one proof-loop call and no longer duplicates adaptive-vs-command branching, runner proof diff classification, or post-proof scope outcome logic.
- [x] Test/Proof First: Add/update failing tests in `test/local-execution-session.test.ts` proving `runImplementationPublishabilityCheck` blocks/proceeds from the loop outcome, preserves artifacts/residual risks/changed files, blocks product-code proof changes with proof evidence, and no longer needs local duplicate proof-diff classification.
- [x] Target: `src/runner/local-execution-session.ts`
  - [x] Action: Replace local adaptive proof selection, runner visual proof fallback, `createAcceptanceProofDiffCapture`, `classifyAcceptanceProofDiff`, and `buildForbiddenAcceptanceProofDiffEvidence` orchestration with a single `runAcceptanceProofLoopAttempt` call when proof applies. Keep configured checks, safety, review gates, commit behavior, and final publish-ready/block routing unchanged.
  - [x] Validation: Local execution focused tests pass.

### Slice 3 Exit Gate
- [x] `npm run build --silent && node --test dist/test/local-execution-session.test.js dist/test/acceptance-proof-loop.test.js`

### Slice 4 - Adaptive Parity And Compatibility Cleanup
- [x] Objective: Adaptive proof and runner-owned command proof share the same evidence vocabulary, and legacy visual-proof config remains compatible without independent ownership.
- [x] Test/Proof First: Add focused loop tests for adaptive raw results covering missing report, invalid report, needs-rework, blocked, and passed. Add compatibility tests proving `reviewGates.acceptanceProof` is canonical and legacy `visualProof.runnerValidationCommand` still reaches command proof without expanding proof-owned mutation paths.
- [x] Target: `src/runner/acceptance-proof-runner.ts`
  - [x] Action: Return `AcceptanceProofAdapterResult` for adaptive proof while keeping existing prompt construction, isolated home lifecycle, Codex adapter invocation, and event wiring behavior.
  - [x] Validation: Adaptive parity tests pass; no prompt contract regression.
- [x] Target: `src/runner/review-gate-policy.ts` and `src/runner/visual-proof-runner.ts`
  - [x] Action: Remove or delegate any remaining independent strategy/evidence logic that would compete with the loop. Keep `runnerVisualProofPolicy` only for command/env compatibility if still required.
  - [x] Validation: Review-gate and visual-proof focused tests pass.

### Slice 4 Exit Gate
- [x] `npm run build --silent && node --test dist/test/acceptance-proof-loop.test.js dist/test/review-gates.test.js dist/test/visual-proof-runner.test.js dist/test/local-execution-session.test.js`

## Halt Conditions
- [ ] Stop if implementing the loop requires `acceptance-proof.ts` to import adapter, shell, git, review policy, or local-session modules.
- [ ] Stop if raw adapter extraction creates an import cycle between `acceptance-proof-loop.ts` and `visual-proof-runner.ts` or `acceptance-proof-runner.ts` that cannot be resolved by moving raw execution to a separate helper.
- [ ] Stop if existing dirty changes in a planned target file conflict with this spec's ownership and cannot be preserved safely.
- [ ] Stop if a test shows current public behavior requires `visualProof` to own proof mutation allowlists; ask for a scope decision instead of preserving that behavior.

## 4. Validation And Done Criteria
- [x] **Lint/Format:** Not applicable; `package.json` has no lint script. `git diff --check` passed.
- [x] **Typecheck:** `npm run typecheck` passed.
- [x] **Tests:** Focused slice commands above passed; final `npm test` passed with 436 tests.
- [x] **Architecture Check:** `docs/agents/execution-routing.md` preflight was read; no dedicated architecture script is configured.
- [x] **Live/Manual Validation:** Not applicable by default. `npm run smoke:live` was intentionally not run because the user did not request live smoke.
- [x] **Behavior Proof:** New loop-interface tests prove routing, adapter normalization, report outcome, proof diff ownership, scope isolation, adaptive/command parity, and visual-proof compatibility; existing public tests prove no user-visible proof behavior regressed.
- [x] **Cleanup Review:** Dedicated `$cleanup-review` subagent found cleanup needed; unused adaptive proof attempt wrapper and stale adaptive availability guard were removed/fixed. Legacy `runRunnerVisualProof` remains as covered compatibility wrapper outside publishability.
- [x] **Code Review:** Dedicated final `$code-review` subagent found no blocking findings after cleanup.
- [x] **Final Reconciliation:** All implementation checklist items are complete or intentionally not applicable.
- [x] **Executor Final Handoff Requirements:** Completion response after implementation must include Contract implemented, Early Review checkpoint, Main invariants proved, cleanup/code-review findings, fixes after review, validation, skipped checks, residual risks, and files by role.

## Defect Closure Notes
- [x] First `implementation-spec-review` returned Needs Work because final response requirements conflicted, adapter/result types were underspecified, adaptive availability was underspecified, and API names were flexible. This revision fixes those defects with exact executor handoff wording, exact exported names/interfaces, explicit `adaptiveAdapterAvailable`, and fixed API names.
- [x] Early `$code-review` checkpoint finding about scope-blocked attempts carrying passed evidence was fixed and revalidated with `npm run build --silent && node --test dist/test/acceptance-proof-loop.test.js dist/test/visual-proof-runner.test.js dist/test/acceptance-proof.test.js`, `npm run typecheck`, and `git diff --check`.
- [x] Cleanup review finding about duplicated adaptive proof outcome ownership was fixed by removing `runAcceptanceProofAttempt` / `shouldRunAcceptanceProofAttempt` from `acceptance-proof-runner.ts` and narrowing adaptive adapter inputs.
- [x] Final validation passed with `npm run typecheck && npm test && git diff --check`; `npm test` reported 436 passing tests.
