---
title: "Runner handoff evidence and review-gate policy alignment wave"
created_at: "2026-05-13T05:25:50Z"
source_type: "wave"
source_plan: "None"
source_issues:
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/136"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/137"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/138"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_verdict: "Approved"
---

## 1. Execution Context

- **Goal:** Implement the fixed-order wave that extracts runner handoff evidence ownership first, then aligns review-gate enforcement and prompt policy text to one shared policy owner.
- **Source Material:** Parent PRD #136, child #137, child #138, local repo evidence from `src/runner/*` and relevant tests.
- **Approved Scope:** #137 may create the runner handoff evidence module and shared evidence/proof TypeScript types, then migrate scoped and plan runner report/PR handoff rendering to it. #138 may consume #137 ownership and deepen review-gate policy so enforcement and prompt contract text come from one public policy owner.
- **Out of Scope:** GitHub delivery semantics, label state machine behavior, config schema changes, live smoke scenario semantics, release/publish flow, new validation owners, new artifact owners, new policy string owners, and unrelated cleanup.
- **Simplest Viable Path:** Add two narrow owners: `src/runner/handoff-evidence.ts` for validation/proof/commit handoff evidence rendering and shared evidence types, then `src/runner/review-gate-policy.ts` for config-derived review-gate policy lines/predicates consumed by prompts, review gates, and visual proof runner.
- **Primary Risk:** Duplicated string/policy ownership could drift between scoped runner, plan runner, review-gate evaluation, prompt guidance, and visual proof behavior.

## 2. Spec Review

- **Full mode required:** Issue wave with fixed ordering, shared ownership contracts, final integration responsibilities, and expected edits across more than three runtime files.
- **Spec-review verdict:** Approved after fixing ownership, integration regression, and public API blockers.
- **Review Scores:** Determinism 2/2, Evidence 2/2, Validation 2/2, Safety 2/2.

## 3. Preconditions And Evidence

- **Required Services / Env / Fixtures:** None for local implementation. Live smoke requires normal repo live-smoke prerequisites; if unavailable, production readiness must not be claimed.
- **Blocking Unknowns:** None.
- **Confirmed Targets:**
  - `src/runner/scoped-auto-command.ts` owns scoped review report, PR body, blocked report, promotion report, and scoped proof artifact string assembly.
  - `src/runner/plan-auto-command.ts` owns child/parent review reports, PR body, blocked comments, and local proof artifact string assembly.
  - `src/runner/command-utils.ts` owns `RunnerValidationLine`, `bulletList`, `renderCommitEvidence`, and `runConfiguredChecks`.
  - `src/runner/review-gates.ts` owns review-gate evaluation and `shouldApplyVisualProofGate`.
  - `src/runner/prompt.ts` owns `qualityGatePromptLines` and `visualProofPromptLines`.
  - `src/runner/visual-proof-runner.ts` consumes visual proof applicability and emits runner visual proof validation/artifacts.
  - Relevant tests: `test/scoped-auto-command.test.ts`, `test/plan-auto-command.test.ts`, `test/review-gates.test.ts`, `test/prompt-builder.test.ts`, `test/visual-proof-runner.test.ts`.
- **Confirmed Commands:** `npm run build`, `npm run typecheck`, `npm test`, `npm run smoke:live`.
- **Architecture Check:** No separate architecture-check script is present in `package.json`; run cleanup-review before final code-review.
- **Protected Paths / Rejected Approaches:** Do not change config schema, GitHub label transitions, PR creation/update semantics, child issue ordering, live smoke scenario intent, or add competing artifact/validation/policy renderers.

## 4. Risk Controls

- **Source of Truth:** `src/runner/handoff-evidence.ts` owns shared runner validation/proof evidence types and rendering after #137. `src/runner/review-gate-policy.ts` owns config-derived review-gate policy facts and prompt contract text after #138.
- **Safety Constraints:** Do not touch secrets, deploy/release commands, destructive database/cache actions, or publication behavior.
- **Contract Constraints:** Preserve completion report artifact shape, `RunnerValidationLine` shape, review report/PR body observable sections, label state-machine outcomes, and live smoke expectations.
- **Consumer Boundaries:** `review-gates.ts` should not directly know `runnerValidationCommand` or `envPassthrough`; those facts are consumed by `prompt.ts` and `visual-proof-runner.ts` through `review-gate-policy.ts`.
- **Concurrency / State Constraints:** Single-agent execution only. Fixed order: #137 first, #138 second, then parent integration validation.
- **Forbidden Scope:** No compatibility branch that leaves old string owners active, no alternate visual proof owner, no new validation status vocabulary, no config migration, no future-facing abstraction beyond the two approved owners.

## 5. Handoff Evidence Public Contract

`src/runner/handoff-evidence.ts` must expose the minimal contract needed by command modules and focused tests:

- `RunnerValidationLine`.
- `buildScopedReviewReport(input)`, `buildScopedPullRequestBody(input)`, `buildScopedBlockedReport(input)`, `buildPromotionRequestReport(input)`.
- `buildChildReviewReport(input)`, `buildIssueTreeReviewReport(input)`, `buildIssueTreePullRequestBody(input)`, `buildChildBlockedReport(input)`, `buildParentBlockedReport(input)`.
- `renderValidationEvidence(lines, options?)`, `renderCommitEvidence(commits, options?)`, `renderScopedProofArtifacts(input)`, `renderLocalProofArtifacts(input)` only where needed by consumers or focused tests.
- Scoped proof artifacts take config plus branch name to render raw GitHub URLs. Local/plan proof artifacts render `artifact.url ?? artifact.path ?? "missing-target"`.
- Keep raw GitHub URL construction, markdown alt escaping, and bullet-prefix stripping private unless a public test seam genuinely requires them.

## 6. Review Gate Policy Public Contract

`src/runner/review-gate-policy.ts` must split policy facts by consumer:

- **Enforcement facts/predicates for `review-gates.ts`:** runtime/test globs, TDD validation patterns, cleanup threshold and patterns, code-review patterns, visual issue text patterns, changed path globs, required validation patterns, skipped check block patterns, artifact directory, minimum screenshot artifacts, glob/regex matching, validation text helpers, and runner-visual evidence recognition.
- **Prompt contract lines for `prompt.ts`:** quality gate prompt lines and visual proof prompt lines, including runner validation command and env passthrough wording.
- **Runner visual proof facts for `visual-proof-runner.ts`:** applicability predicate, command template, timeout, artifact directory, and env passthrough.

## 7. Execution Slices

### Progress Discipline

- [ ] Update this checklist as work is completed.
- [ ] Leave blocked work unchecked with a short `Blocked:` note.
- [ ] Stop if repo reality contradicts a confirmed target, command, precondition, or scope boundary.
- [ ] Keep each implementation phase as a vertical tracer-bullet slice, not a horizontal layer pass.
- [ ] For behavior changes, use RED -> GREEN -> refactor one behavior at a time.

### Slice 1 - #137 Scoped Handoff Evidence Owner

- [ ] Objective: Scoped runner review report and PR body still include the same validation, proof artifact, log, local commit, skipped check, and residual risk evidence while rendering comes from a shared handoff evidence owner.
- [ ] Test/Proof First: Add or adjust one focused behavior test in `test/scoped-auto-command.test.ts` that fails before extraction and passes after, proving scoped review report and draft PR body render screenshot proof artifacts and validation through the moved public handoff path.
- [ ] Target: `src/runner/handoff-evidence.ts`
  - [ ] Action: Create the module and move shared evidence/proof types and renderers into it.
  - [ ] Validation: Focused scoped test fails before implementation and passes after.
- [ ] Target: `src/runner/command-utils.ts`
  - [ ] Action: Stop owning `RunnerValidationLine` and `renderCommitEvidence`; import or re-export only as needed to preserve existing consumers during the slice. Keep `bulletList`, `formatSessionTimestamp`, config reading/defaults, artifact merge, and `runConfiguredChecks`.
  - [ ] Validation: Typecheck confirms existing imports resolve.
- [ ] Target: `src/runner/scoped-auto-command.ts`
  - [ ] Action: Replace local validation/proof/commit string assembly paths with `handoff-evidence` helpers without changing section names or report/PR semantics.
  - [ ] Validation: `test/scoped-auto-command.test.ts` passes.

### Slice 2 - #137 Plan Runner Handoff Evidence Consumer

- [ ] Objective: Plan child review reports and parent issue-tree PR/review reports consume the same handoff evidence owner, including child-prefixed proof artifacts and final validation lines.
- [ ] Test/Proof First: Add or adjust one focused behavior test in `test/plan-auto-command.test.ts` that fails before plan runner consumes the shared handoff path and passes after, proving issue-tree review report or PR body includes validation and proof artifact evidence for child results.
- [ ] Target: `src/runner/plan-auto-command.ts`
  - [ ] Action: Replace local validation/proof/commit rendering with `handoff-evidence` helpers. Preserve child prefixes, parent final validation wording, blocked comments, merge summary, and PR body semantics.
  - [ ] Validation: `test/plan-auto-command.test.ts` passes.
- [ ] Target: `src/runner/local-execution-session.ts`, `src/runner/review-gates.ts`, `src/runner/visual-proof-runner.ts`
  - [ ] Action: Update `RunnerValidationLine` imports to the new owner only if required by Slice 1 movement.
  - [ ] Validation: Typecheck and focused tests pass.

### Slice 3 - #138 Review-Gate Policy Owner

- [ ] Objective: Review-gate enforcement and prompt policy guidance derive from the same public policy owner while preserving current quality and visual proof behavior.
- [ ] Test/Proof First: Add or adjust a focused test in `test/prompt-builder.test.ts` or `test/review-gates.test.ts` that fails before policy ownership is shared and passes after. The test must prove shared policy owner supplies runtime/test globs and cleanup/code-review/TDD contract to prompt and enforcement, while command/env/artifact runner facts are checked only through prompt plus visual-proof-runner behavior.
- [ ] Target: `src/runner/review-gate-policy.ts`
  - [ ] Action: Create a public policy owner for config-derived review-gate policy. It must not duplicate validation, artifact, or handoff evidence rendering from `handoff-evidence.ts`.
  - [ ] Validation: Focused prompt/review-gate tests fail before implementation and pass after.
- [ ] Target: `src/runner/prompt.ts`
  - [ ] Action: Replace `qualityGatePromptLines` and `visualProofPromptLines` private ownership with calls into `review-gate-policy.ts`. Preserve current prompt contract wording unless a minimal wording adjustment is already covered by tests.
  - [ ] Validation: `test/prompt-builder.test.ts` passes.
- [ ] Target: `src/runner/review-gates.ts`
  - [ ] Action: Consume shared policy predicates/facts for quality and visual proof applicability. Preserve existing positive and negative decisions.
  - [ ] Validation: `test/review-gates.test.ts` passes.
- [ ] Target: `src/runner/visual-proof-runner.ts`
  - [ ] Action: Consume shared visual proof applicability/policy facts without taking ownership of policy strings or validation rendering.
  - [ ] Validation: `test/visual-proof-runner.test.ts` passes.

### Slice 4 - Parent Integration Regression

- [ ] Objective: Prove #137 and #138 work together without changing GitHub delivery semantics, label state machine behavior, config schema, live smoke scenarios, or existing behavior.
- [ ] Test/Proof First: Add or adjust the mandatory combined regression in `test/scoped-auto-command.test.ts`.
- [ ] Regression fixture:
  - Config override includes custom `reviewGates.quality.runtimeChangedPathGlobs`, `reviewGates.quality.testChangedPathGlobs`, cleanup threshold, `reviewGates.visualProof.runnerValidationCommand`, artifact directory, and `envPassthrough`.
  - `codexAdapter` captures `promptText` and returns a completed report with UI/runtime changed files, proof script/artifact, TDD red-green validation, and code-review validation.
  - Assertions: `promptText` contains quality gate lines generated from config and runner visual proof env/command lines; result report comment and created PR body contain validation lines and screenshot proof artifact from `handoff-evidence`; result status is `review-ready`, proving review gates accepted the same policy/evidence path.
- [ ] Plan child/parent body remains covered by focused plan tests from Slice 2.

## 8. Validation And Done Criteria

- [ ] **Lint/Format:** Not applicable; no lint/format script is present in `package.json`.
- [ ] **Typecheck:** `npm run typecheck`.
- [ ] **Build:** `npm run build`.
- [ ] **Tests:** focused tests for `test/scoped-auto-command.test.ts`, `test/plan-auto-command.test.ts`, `test/review-gates.test.ts`, `test/prompt-builder.test.ts`, `test/visual-proof-runner.test.ts`, then `npm test`.
- [ ] **Architecture Check:** No package script available; run cleanup-review before final code-review because this wave touches multiple runtime files.
- [ ] **Live/Manual Validation:** `npm run smoke:live` if production readiness is claimed; otherwise state it was skipped with exact reason and risk.
- [ ] **Behavior Proof:** Scoped and plan handoff reports/PR bodies render evidence from `handoff-evidence.ts`; prompt and review-gate enforcement derive policy from `review-gate-policy.ts`; visual proof runner still emits runner visual proof validation/artifacts.
- [ ] **Final Review Gates:** Run cleanup-review first, apply high-confidence cleanup fixes, then run final code-review and fix critical, medium, or high-confidence findings.
- [ ] **Final Reconciliation:** all unchecked work is unfinished, blocked with a note, or intentionally not applicable.

## 9. Final Action

Spec Status: Ready
Saved Path: docs/implementation-specs/2026-05-13/0525-runner-handoff-evidence-review-gate-policy-wave.md
Execution Model: Single-Agent
Review Verdict: Approved
Validation Gates: Local / Live / Tests
Blockers: None
