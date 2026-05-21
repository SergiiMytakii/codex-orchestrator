---
title: "Package-owned browser proof runtime"
created_at: "2026-05-21T13:49:03Z"
source_type: "issue"
source_plan: "None"
source_issues:
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/882"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/883"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/884"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/885"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/886"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/887"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/888"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/889"
status: "ready"
execution_model: "single-agent"
spec_mode: "compact"
review_verdict: "Approved"
---

## 1. Execution Context
- **Goal:** Establish the package-owned browser proof runtime, wire it into Acceptance Proof, and make browser/mobile proof dispatch automatic for web vs mobile work.
- **Source Material:** Parent PRD #882 and child issues #883-#889.
- **Approved Scope:** Add the versioned scenario contract, validation, Playwright runtime availability contract, browser proof report assembly, `visual-proof browser`, `visual-proof auto`, runner Acceptance Proof integration, setup defaults, prompt/docs updates, and regression coverage.
- **Out of Scope:** Live GitHub smoke, product-specific UI flow authoring, reading `.env` or `.env.*`, replacing Acceptance Proof evaluation, and raw CDP-first behavior.
- **Simplest Viable Path:** Add one browser proof contract module, reuse existing Acceptance Proof report/UI Evidence types, and keep dispatch classification owned by existing review-gate policy.
- **Primary Risk:** Accidentally creating a second pass/fail evaluator instead of producing reports for the existing Acceptance Proof evaluator.

### Wave Expansion Note

This spec started as the approved #883 foundation slice. After the foundation was green, the same wave executed #884-#889 because the parent issue requested all children together and the later slices depended directly on the shared contract.

## 2. Preconditions And Evidence
- **Required Services / Env / Fixtures:** None; this slice uses deterministic in-repo fixtures only.
- **Blocking Unknowns:** None.
- **Confirmed Targets:** `src/runner/acceptance-proof.ts` owns report schema/evaluation; `src/runner/visual-proof-runner.ts` already passes proof/report/profile/cache/changed-files env to configured proof commands; `src/setup/project-config.ts` owns default proof commands; `src/runner/review-gate-policy.ts` owns proof gate policy and must own future auto dispatch classification; `test/acceptance-proof.test.ts`, `test/visual-proof-runner.test.ts`, and `test/review-gates.test.ts` are current proof contract seams.
- **Confirmed Commands:** `npm test`; `npm run typecheck`.
- **Protected Paths / Rejected Approaches:** Do not read secret files; do not implement raw CDP-first behavior; do not start product dev servers; do not change GitHub publication behavior; do not add a browser-specific final evaluator.
- **Architecture Lens:** New module `src/runner/browser-proof-contract.ts` is a deep module: small interface for scenario validation, Playwright provisioning classification, shared browser runtime env constants, and Acceptance Proof Report assembly. Deletion test: without it, later CLI/runtime/setup slices would duplicate schema, artifact mapping, and runtime blocked-report behavior. Dispatch classification belongs in `src/runner/review-gate-policy.ts`.
- **Contract Test Ledger:**
  - Scenario version/base URL/viewports/steps/assertions/checkpoints/auth/criteria mapping -> first RED test in `test/browser-proof-contract.test.ts`.
  - Malformed scenario rejection before browser launch -> first RED test in `test/browser-proof-contract.test.ts`.
  - Browser evidence maps to existing Acceptance Proof Report/UI Evidence -> first RED test in `test/browser-proof-contract.test.ts` that passes the assembled report through `evaluateAcceptanceProofReport`.
  - Shared auto dispatch policy owner -> GREEN in `test/review-gates.test.ts`.

## 3. Execution Slices

### Progress Discipline
- [ ] Update this checklist as work is completed.
- [ ] Leave blocked work unchecked with a short `Blocked:` note.
- [ ] Stop if repo reality contradicts a confirmed target, command, precondition, or scope boundary.
- [ ] Keep each implementation phase as a vertical tracer-bullet slice, not a horizontal layer pass.
- [ ] For behavior changes, start each slice with a behavior-first test/proof before implementation work.
- [ ] For contract-heavy changes, update the Contract Test Ledger status as each invariant moves planned -> red -> green or blocked.

### Slice 1 - Scenario Contract Validation
- [ ] Objective: Valid and malformed browser proof scenarios are classified deterministically before any browser launch.
- [ ] Test/Proof First: Add failing `test/browser-proof-contract.test.ts` cases for a valid scenario and for missing version, invalid base URL, invalid viewport dimensions, unknown action, missing selector/text, unmapped criteria, and invalid auth metadata.
- [ ] Target: `src/runner/browser-proof-contract.ts`
  - [ ] Action: Add exported scenario types and `validateBrowserProofScenario(input)` returning `{ ok: true; scenario }` or `{ ok: false; errors }`.
  - [ ] Action: Support scenario version `1`, base URL string or env reference metadata, viewports, ordered steps, assertions, artifact checkpoints, criteria mapping, auth metadata, and proof-owned relative artifact paths.
  - [ ] Validation: `npm run typecheck`; focused tests through `npm test`.

### Slice 2 - Report Assembly Contract
- [ ] Objective: Browser evidence is converted into a valid Acceptance Proof Report without bypassing `evaluateAcceptanceProofReport`.
- [ ] Test/Proof First: Add a failing test that assembles a successful browser proof report with screenshot, DOM snapshot, console log, network log, run summary, criteria refs, and complete `uiEvidence`, then verifies `evaluateAcceptanceProofReport(...).ok === true`.
- [ ] Target: `src/runner/browser-proof-contract.ts`
  - [ ] Action: Add `assembleBrowserProofReport(input)` that maps screenshots to `screenshot`, DOM snapshots to `ui-dump`, console/network/run summary to `log` or `other`, fills `uiEvidence`, and sets `proofPhaseDiff.allowedProofPaths` under the proof directory.
  - [ ] Action: Add helper paths that keep artifact refs proof-owned and relative to the worktree.
  - [ ] Action: Reject absolute paths, `..` traversal, product/worktree paths outside `${artifactDir}/issue-${issueNumber}/`, and artifact paths under Playwright profile/cache directories.
  - [ ] Validation: `npm run typecheck`; focused tests through `npm test`.

### Slice 3 - Runtime And Dispatch Contracts
- [ ] Objective: Later slices have one shared contract for Playwright availability/cache/profile ownership and one shared policy owner for web-vs-mobile dispatch.
- [ ] Test/Proof First: Add failing tests proving each runtime blocker creates the exact blocked report below, then add `test/review-gates.test.ts` cases proving web paths dispatch to browser while Android/iOS/Flutter/mobile app paths dispatch to mobile.
- [ ] Target: `src/runner/browser-proof-contract.ts`
  - [ ] Action: Add exported runtime availability result types plus `assembleBlockedBrowserProofReport(input)`. Do not install or launch browsers in this slice.
  - [ ] Action: Exact runtime blocker kinds are `invalidScenario`, `playwrightPackage`, `browserBinary`, `cacheDir`, and `profileDir`.
  - [ ] Action: Exact blocked report shape: `status: "blocked"`; one `log` artifact at `${artifactDir}/issue-${issueNumber}/browser-proof-diagnostics.json`; scenario criteria when available or one `browser-proof-runtime` criterion; blocked criteria have `status: "unknown"`, `confidence: "low"`, and the diagnostic artifact ref; `reworkRequest.summary` starts `Browser proof blocked before launch:`; `requiredChanges` contains actionable diagnostics; `proofPhaseDiff.allowedProofPaths` contains only the diagnostic path; `forbiddenProductPaths: []`; omit `uiEvidence` unless screenshot/ui-dump artifacts exist.
  - [ ] Action: Export shared browser proof runtime env constants for `CODEX_ORCHESTRATOR_PROOF_DIR`, `CODEX_ORCHESTRATOR_PROOF_REPORT_PATH`, `CODEX_ORCHESTRATOR_PLAYWRIGHT_PROFILE_DIR`, and `PLAYWRIGHT_BROWSERS_PATH`.
  - [ ] Target: `src/runner/review-gate-policy.ts`
  - [ ] Action: Add `classifyVisualProofDispatchTarget(input: { config, issue, changedFiles }): "browser" | "mobile" | "none"` as the single dispatch policy owner for CLI/setup use. Slice 1 kept CLI/setup defaults unchanged; #884/#887 wire the executable browser and auto commands after the contract is green.
  - [ ] Action: Dispatch precedence: mobile wins when any changed path is native Android, native iOS, Flutter app, or mobile app path; browser wins for web/frontend paths when no mobile path matched; issue text can make Flutter `lib/main.dart` mobile only when it contains mobile/Flutter/Android/iOS terms; backend-only paths return `none`.
  - [ ] Action: Required dispatch fixtures: `src/frontend/App.tsx -> browser`, `app/page.tsx -> browser`, `android/app/build.gradle -> mobile`, `ios/App.xcodeproj/project.pbxproj -> mobile`, `lib/main.dart` with Flutter/mobile issue text -> mobile`, mixed `src/frontend/App.tsx + android/app/build.gradle -> mobile`, `src/server.ts -> none`.
  - [ ] Validation: `npm run typecheck`; focused tests through `npm test`.

### Slice Exit Gate
- [x] Focused build and contract tests: `npm run build && node --test dist/test/browser-proof-contract.test.js dist/test/review-gates.test.js --test-name-pattern 'browser proof|visual proof dispatch'`
- [x] `npm run typecheck`
- [x] `npm test`
- [x] #883 acceptance criteria mapped to tests and code.
- [x] #884-#889 browser command, diagnostics, runner integration, setup migration, docs/prompts, and regression acceptance criteria mapped to tests and code.

## 4. Validation And Done Criteria
- [ ] **Lint/Format:** Not configured in `package.json`; skip with reason `no lint script`.
- [x] **Typecheck:** `npm run typecheck`
- [x] **Tests:** `npm test`
- [ ] **Architecture Check:** No dedicated architecture-check script is configured; use source-of-truth docs plus `npm run typecheck`/`npm test`.
- [ ] **Live/Manual Validation:** Not applicable; no live GitHub smoke for #883.
- [ ] **Behavior Proof:** RED -> GREEN evidence for `test/browser-proof-contract.test.ts`.
- [x] **Final Reconciliation:** All #883-#889 acceptance criteria are either green, blocked with a note, or intentionally not applicable.

## 5. Final Action
After implementation, report:

Spec Status: Ready
Saved Path: docs/implementation-specs/2026-05-21/1649-browser-proof-contract.md
Execution Model: Single-Agent
Review Verdict: Pending implementation-spec-review
Validation Gates: Local / Tests
Blockers: None
