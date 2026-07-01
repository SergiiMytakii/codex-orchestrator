---
title: "Risk Routing Enforcement For Review Gates"
created_at: "2026-07-01T18:48:03Z"
source_type: "plan"
source_plan: "/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-01/2134-risk-routing-enforcement-review-gates.md"
source_issues:
  - "None"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_verdict: "Approved"
---

## 1. Execution Context
- **Goal:** Add deterministic runner-owned enforcement for declared risk-routing metadata so scoped and parent `plan-auto` flows expose warn-mode findings and opt-in block-mode findings without weakening existing gates.
- **Source Material:** `/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-01/2134-risk-routing-enforcement-review-gates.md`; repo routing in `/Users/serhiimytakii/Projects/codex-orchestrator/AGENTS.md`; quality preflight in `/Users/serhiimytakii/Projects/codex-orchestrator/docs/agents/execution-routing.md`.
- **Planned Scope:** Add backward-compatible `reviewGates.riskRouting` config, scoped risk-routing evaluation, parent `plan-auto` metadata gate, warn/block rendering, scoped retryable blocker wiring, focused tests, one focused risk-routing live smoke scenario, docs, and required validation. Implementation still requires the user or orchestrator to select this spec for execution; this file is not itself implementation approval.
- **Out of Scope:** LLM risk inference, new GitHub labels outside the controlled live-smoke scenario, parent planning rework loop, prompt sync behavior, external services beyond the required live smoke run, weakening existing quality gates by default, and edits to `docs/agents/memory/lessons.md`.
- **Simplest Viable Path:** Reuse existing config/schema/defaults, `evaluateReviewGates`, `ReviewGateResult`, completion-report metadata, `hasPassedValidation`, `globMatches`/path classification, parent handoff rendering, and `rework-policy.ts`; add only small deterministic helpers for scoped and parent risk-routing findings.
- **Primary Risk:** The runner could either block old repositories unexpectedly or let high-risk declared metadata bypass proof/review expectations; tests must prove default warn-mode compatibility and block-mode stop points.

## 2. Preconditions And Evidence
- **Required Services / Env / Fixtures:** Local Node/npm repo dependencies already installed or installable by normal repo workflow; live smoke requires the repo's existing GitHub access used by `npm run smoke:live` and must run only after local validation passes.
- **Blocking Unknowns:** None.
- **Confirmed Targets:** `src/config/schema.ts`; `src/setup/project-config.ts`; `.codex-orchestrator/config.json`; `test/fixtures/config.ts`; `src/runner/review-gates.ts`; `src/runner/review-gate-policy.ts` only if shared validation/glob helpers need export changes; `src/runner/plan-auto-command.ts`; `src/runner/rework-policy.ts`; `src/runner/handoff-evidence.ts`; `scripts/live-smoke.mjs`; `docs/live-smoke-checklist.md`; `docs/deep-dive.md`; tests: `test/config-schema.test.ts`, `test/setup-command.test.ts`, `test/rework-policy.test.ts`, `test/review-gates.test.ts`, `test/scoped-auto-command.test.ts`, `test/plan-auto-command.test.ts`.
- **Confirmed Commands:** `npm run typecheck`; `npm test`; `git diff --check`; `npm run smoke:live`. No repo lint or architecture-check script is configured.
- **Protected Paths / Rejected Approaches:** Do not read, print, or edit `.env` or `.env.*`; do not edit `docs/agents/memory/lessons.md`; do not add prompt-only enforcement, LLM risk inference, GitHub-label source of truth, hard default block mode, duplicated code-review parsing, parent planning retry, or a new adapter abstraction.
- **Architecture Lens:** Module: runner review policy. Interface: `evaluateReviewGates(input): ReviewGateResult` for scoped work and a parent helper returning the same `{ ok, reasons, warnings }` shape. Seam: config-driven policy inside runner review gates, not an adapter. Deletion-test result: deleting the new risk-routing helpers and config removes only this policy family while preserving quality, acceptance, visual proof, and publication behavior.
- **Contract Test Ledger:**
  - `reviewGates.riskRouting` missing in existing configs -> GREEN: `npm run build && node --test dist/test/command-utils.test.js dist/test/review-gates.test.js dist/test/rework-policy.test.js dist/test/config-schema.test.js dist/test/setup-command.test.js` passes; merge/setup/runtime config loading default to enabled warn-mode without breaking stale configs.
  - Scoped findings in `mode: "warn"` -> GREEN: `npm run build && node --test dist/test/review-gates.test.js` passes; findings append to `warnings` while `ok` remains controlled by non-risk blockers.
  - Scoped findings in `mode: "block"` -> GREEN: `npm run build && node --test dist/test/review-gates.test.js dist/test/rework-policy.test.js` passes; findings append to `reasons` with stable `Risk routing gate requires...` text.
  - Scoped risk-routing blocker retry -> GREEN: `npm run build && node --test dist/test/review-gates.test.js dist/test/rework-policy.test.js` passes; `shouldRequestImplementationRework` returns true only when `risk-routing-policy` is configured and the reason matches scoped risk-routing text.
  - Parent warn findings -> GREEN: `npm run build && node --test dist/test/review-gates.test.js dist/test/plan-auto-command.test.js` passes; `Risk routing warnings` renders in parent outputs and child execution/PR flow can continue.
  - Parent block findings -> GREEN: `npm run build && node --test dist/test/plan-auto-command.test.js` passes; block happens after report read and before parent `updateIssue`, child creation/execution, draft PR creation, or final parent review comment.

## Risk Controls
- **Source of Truth:** `.codex-orchestrator/config.json` and merged `CodexOrchestratorConfig.reviewGates.riskRouting` own policy; completion reports provide untrusted evidence; existing quality/acceptance/visual gates remain independent blockers.
- **Safety Constraints:** Parent block-mode may happen after claim/running-label setup only; it must not create child issues, draft PRs, parent content updates, or final parent review comments before passing. Live smoke may create/update controlled GitHub artifacts only through the existing live-smoke harness.
- **Contract Constraints:** Config fields are exactly: `enabled`, `mode`, `requireScopedReviewHandoff`, `requireParentSizeRisk`, `requireParentReviewHandoff`, `riskyChangedPathGlobs`, `highRiskRequiresCodeReview`, `allowedLowRiskFlows`. `mode` accepts only `warn` or `block`. `allowedLowRiskFlows` uses the existing `ReviewHandoffFlow` values from completion reports.
- **Concurrency / State Constraints:** Risk gate helpers must be pure over config, changed paths, validation, and completion-report data. Parent findings are non-retryable in this slice; scoped findings are retryable only through `risk-routing-policy` in configured retryable blockers.
- **Forbidden Scope:** No parent planning rework loop, no schema/DTO migration beyond config defaults, no GitHub label policy expansion, no production deploy/release changes, no unrelated cleanup.
- **Early Review Gate:** After Slice 3 proves scoped block/rework behavior, run `$code-review` against the partial change set before continuing to parent/block/live-smoke work.
- **Final Handoff Requirements:** Executor final response must include contract implemented, high-risk checkpoint outcome, main invariants proved, code-review and cleanup-review findings/fixes, validation commands and results, live smoke result or concrete blocker, skipped checks, residual risks, and files by role.

## Write Scope Summary
- `src/config/schema.ts` - Update config types/validation and retryable blocker enum; reuse existing validators and union helpers; docs target `docs/deep-dive.md`.
- `src/setup/project-config.ts` - Update defaults and merge/migration for stale configs; reuse existing default/merge style.
- `.codex-orchestrator/config.json` - Update repo-local policy with default/warn risk-routing config.
- `test/fixtures/config.ts` - Update valid fixture config.
- `src/runner/review-gates.ts` - Add scoped risk-routing evaluation and expose parent helper if colocated; reuse `ReviewGateResult`, `classifyChangedPaths`, `globMatches`, and `hasPassedValidation`.
- `src/runner/review-gate-policy.ts` - Export/reuse helper only if needed; avoid duplicating validation regex matching.
- `src/runner/plan-auto-command.ts` - Run parent gate immediately after successful `readPlanReport` and before parent content/child/PR/comment mutations; carry warn findings to an explicit `PlanAutoCommandResult` warning field and parent output builders.
- `src/runner/handoff-evidence.ts` - Render scoped/parent risk-routing warnings in existing report/PR surfaces.
- `src/runner/rework-policy.ts` - Add scoped `risk-routing-policy` retry matching.
- `scripts/live-smoke.mjs` - Add focused risk-routing live smoke scenario.
- `docs/live-smoke-checklist.md` and `docs/deep-dive.md` - Document smoke coverage and warn/block semantics.
- `test/*.test.ts` listed above - Add focused red/green coverage for each slice.

## Halt Conditions
- [x] Not triggered: repo reality confirmed `reviewHandoff`, `sizeRisk`, and `parentReviewHandoff` are available completion-report fields.
- [x] Not triggered: parent block-mode was inserted before `updateIssue`/child creation without broader parent workflow redesign.
- [x] Not triggered: stale configs without `reviewGates.riskRouting` are valid through setup/runtime defaults.
- [x] Not triggered: live-smoke prerequisites were available and live smoke passed.

## 3. Execution Slices

### Progress Discipline
- [x] Update this checklist as work is completed.
- [x] No blocked work remains unchecked.
- [x] Not triggered: repo reality did not contradict a confirmed target, command, precondition, or scope boundary.
- [x] Each implementation phase was completed as a vertical tracer-bullet slice.
- [x] For behavior changes, start each slice with a behavior-first test/proof before implementation work.
- [x] Contract Test Ledger status was tracked in this implementation spec's slice proofs and validation notes.
- [x] Required Review Checkpoint ran before continuing past scoped block/rework behavior.

### Slice 1 - Config Compatibility And Policy Shape
- [x] Objective: Existing and generated configs support `reviewGates.riskRouting` without breaking stale repositories.
- [x] Test/Proof First: Add failing tests in `test/config-schema.test.ts` and/or `test/setup-command.test.ts` proving a config without `riskRouting` is migrated/defaulted, invalid `mode` is rejected, invalid `allowedLowRiskFlows` is rejected, and `risk-routing-policy` is accepted as a retryable blocker.
- [x] Target: `src/config/schema.ts`
  - [x] Action: Add `RiskRoutingMode`, reuse/export existing review handoff flow type or define a compatible type from completion-report flow values, add `riskRouting` under `CodexOrchestratorConfig.reviewGates`, validate booleans/strings/string arrays/enum arrays, and add `risk-routing-policy` to `RetryableReworkBlocker` validation.
  - [x] Validation: Focused schema tests fail before implementation and pass after.
- [x] Target: `src/setup/project-config.ts`
  - [x] Action: Add default risk-routing config: enabled true, mode warn, scoped/parent requirements true as planned, `riskyChangedPathGlobs: []`, highRiskRequiresCodeReview true, allowedLowRiskFlows `small-task-implementer` and `scoped-implementation`; merge stale existing configs with defaults while preserving explicit configured `riskyChangedPathGlobs`.
  - [x] Validation: Setup/default tests prove old configs remain valid, empty `riskyChangedPathGlobs` disables the low-risk path inconsistency predicate, and explicit configured globs enable it.
- [x] Target: `.codex-orchestrator/config.json` and `test/fixtures/config.ts`
  - [x] Action: Add default/warn risk-routing config. Use `riskyChangedPathGlobs: []` unless this repo deliberately chooses exact risk globs in the same slice with focused tests naming those exact patterns.
  - [x] Validation: `npm run typecheck` if type shape changed enough to need early confirmation.

### Slice Exit Gate
- [x] `npm run typecheck` passes or any failure is unrelated and documented with exact output.
- [x] Focused config/setup tests pass through `npm test` or targeted Node test command after build if the executor chooses a narrower loop.

### Slice 2 - Scoped Warn-Mode Gate
- [x] Objective: Scoped completion metadata inconsistencies become deterministic warnings in warn mode.
- [x] Test/Proof First: Add failing `test/review-gates.test.ts` cases for missing scoped `reviewHandoff`, empty `implementedContract`/`proofByAcceptanceCriteria`/`reviewFocus`/`humanReviewChecklist`, low-risk disallowed `flowUsed`, low-risk risky changed path, and high-risk missing code-review evidence with `mode: "warn"`.
- [x] Target: `src/runner/review-gates.ts`
  - [x] Action: Add `evaluateScopedRiskRoutingGate` that returns `ReviewGateResult` or findings, runs inside `evaluateReviewGates`, respects `enabled`, applies warn findings to `warnings`, and leaves existing quality/visual `reasons` untouched.
  - [x] Validation: Warn-mode tests prove `ok` remains true when no other blockers exist and warnings contain stable risk-routing text.
- [x] Target: `src/runner/review-gate-policy.ts` or `src/path-policy.ts`
  - [x] Action: Reuse/export `hasPassedValidation` and `globMatches` only as needed; do not duplicate regex/glob behavior.
  - [x] Validation: Existing review-gate tests remain passing.

### Slice Exit Gate
- [x] `test/review-gates.test.ts` scoped warn cases pass after RED -> GREEN.

### Slice 3 - Scoped Block-Mode And Rework Wiring
- [x] Objective: The same scoped findings become blockers in block mode and can trigger existing scoped/child rework only when configured.
- [x] Test/Proof First: Add failing `test/review-gates.test.ts` block-mode cases and `test/rework-policy.test.ts` cases for `risk-routing-policy` retryability, including a negative case when that blocker is not configured.
- [x] Target: `src/runner/review-gates.ts`
  - [x] Action: In block mode, append scoped findings to `reasons` with stable `Risk routing gate requires...` wording and set `ok` from total blockers.
  - [x] Validation: Block-mode tests prove reasons block publication and warning mode still does not.
- [x] Target: `src/runner/rework-policy.ts`
  - [x] Action: Add retryable pattern for scoped risk-routing reasons and no parent-specific retry pattern.
  - [x] Validation: Rework-policy tests pass.

### Slice Exit Gate
- [x] Focused `review-gates` and `rework-policy` tests pass.

### Review Checkpoints
- [x] Run `$code-review` on the config + scoped gate + rework partial change set before editing parent `plan-auto` behavior.
- [x] Continue only after fixing or explicitly documenting review findings that affect duplicate side effects, retry classification, default compatibility, source-of-truth ownership, or false block/warn outcomes.
  - Fixed checkpoint finding: runtime config loading now backfills missing `reviewGates.riskRouting`, not only setup migration.

### Review Focus
- Mandatory lenses: default config compatibility, no low-risk weakening of existing quality gates, scoped-only retry matching, duplicate finding text, false positives from glob matching, and stable error text used by tests/rework policy.

### Slice 4 - Parent Warn-Mode Rendering
- [x] Objective: Parent `plan-auto` metadata findings render as risk-routing warnings without stopping execution in warn mode.
- [x] Test/Proof First: Add failing `test/plan-auto-command.test.ts` coverage proving missing/invalid parent `sizeRisk` or `parentReviewHandoff` in warn mode appears as `Risk routing warnings` in parent PR body/report comment/result, while child creation/execution can continue. Add direct handoff-evidence tests if this repo has an existing test file for those helpers; otherwise cover through `plan-auto-command`.
- [x] Target: `src/runner/review-gates.ts` or new local helper in `src/runner/plan-auto-command.ts`
  - [x] Action: Add parent risk-routing evaluator that checks enabled/mode, `requireParentSizeRisk`, exact partition of every `report.graph.nodes[].stableId` across `small|medium|high`, `requireParentReviewHandoff`, and non-empty `risks`, `proofStrategy`, `humanReviewFocus`.
  - [x] Validation: Parent evaluator tests prove duplicate, missing, and unknown stable IDs are findings.
- [x] Target: `src/runner/plan-auto-command.ts`
  - [x] Action: Run parent evaluator immediately after `readPlanReport` returns a report. In warn mode, store warnings and pass them into `PlanAutoCommandResult.riskRoutingWarnings: string[]` or an equivalently named explicit field, `buildIssueTreeReviewReport`, and `buildIssueTreePullRequestBody`.
  - [x] Validation: Tests prove warn mode does not prevent child issue creation or PR body generation, and assert result warning field shape plus PR/report rendering.
- [x] Target: `src/runner/handoff-evidence.ts`
  - [x] Action: Render parent warnings under exact heading `Risk routing warnings`; do not hide them in `residualRisks`.
  - [x] Validation: Snapshot/string assertions include the heading and finding text.

### Slice Exit Gate
- [x] Parent warn-mode tests pass after RED -> GREEN.

### Slice 5 - Parent Block-Mode Stop Point
- [x] Objective: Parent block-mode findings stop after report validation and before parent content, child issue, child execution, PR, or final parent comment mutations.
- [x] Test/Proof First: Add failing `test/plan-auto-command.test.ts` coverage using fake adapters/spies to assert block-mode missing/invalid parent metadata calls blocked reporting but does not call `updateIssue`, `persistAutonomousChildNode`/child creation, child execution, `createDraftPullRequest`, or final review-ready comment.
- [x] Target: `src/runner/plan-auto-command.ts`
  - [x] Action: If parent evaluator returns block-mode reasons, call the existing blocked-result path with those reasons immediately after `readPlanReport`; include warnings/reasons in blocked report/comment/result and do not attempt parent planning rework.
  - [x] Validation: Tests prove only expected claim/running-label setup and blocked-report mutation occur before stop.
- [x] Target: `src/runner/handoff-evidence.ts`
  - [x] Action: Ensure blocked parent report renders risk-routing reasons clearly, reusing existing blocked report format unless a small optional warnings/reasons parameter is necessary.
  - [x] Validation: Blocked report assertions include risk-routing text.

### Slice Exit Gate
- [x] Parent block-mode tests pass and prove no parent retry loop is attempted.

### Slice 6 - Live Smoke Scenario And Run
- [x] Objective: The real live-smoke harness exercises risk-routing runner wiring once local tests are green.
- [x] Test/Proof First: Inspect `scripts/live-smoke.mjs` existing scenario structure, then add the smallest focused scenario that proves risk-routing through an actual runner path without re-testing every unit predicate.
- [x] Target: `scripts/live-smoke.mjs`
  - [x] Action: Add an attributable risk-routing live smoke case, preferably warn-mode unless block-mode can be proven without leaving confusing GitHub state; keep created artifacts clearly named for risk-routing enforcement.
  - [x] Validation: Scenario is reachable from `npm run smoke:live`.
- [x] Target: `docs/live-smoke-checklist.md`
  - [x] Action: Document what the risk-routing smoke proves and what artifacts it may create/update.
  - [x] Validation: Docs mention the scenario and expected gate behavior.
- [x] Target: local command execution
  - [x] Action: After `npm test` and `git diff --check` pass, run `npm run smoke:live` as required by the source plan.
  - [x] Validation: Save exact pass/fail/blocker evidence for final handoff.

### Slice Exit Gate
- [x] `npm run smoke:live` passes, or a concrete external blocker is recorded with the last local green state.

### Slice 7 - Docs And Final Reconciliation
- [x] Objective: Document warn/block semantics and reconcile implementation evidence for handoff.
- [x] Test/Proof First: Read the relevant current config/review-gates section in `docs/deep-dive.md` before editing so docs land in the existing architecture narrative.
- [x] Target: `docs/deep-dive.md`
  - [x] Action: Add concise docs for `reviewGates.riskRouting`, warn vs block behavior, scoped retryability, parent non-retryability, and the fact that low-risk claims never weaken existing quality gates.
  - [x] Validation: `git diff --check` catches markdown whitespace issues.
- [x] Target: final change set
  - [x] Action: Run `$cleanup-review` in a dedicated subagent, integrate safe fixes, rerun relevant validation, then run final `$code-review` on the settled diff.
  - [x] Validation: Final validation evidence is ready for handoff.

### Slice Exit Gate
- [x] All checkboxes are complete, blocked with notes, or intentionally not applicable.

## 4. Validation And Done Criteria
- [x] **Lint/Format:** No lint script configured; `git diff --check` passed.
- [x] **Typecheck:** `npm run typecheck` passed.
- [x] **Tests:** `npm test` passed.
- [x] **Architecture Check:** No dedicated architecture-check script configured; source-of-truth review against `docs/agents/execution-routing.md`, `docs/deep-dive.md`, and `docs/adr/0001-runner-owned-loop-policy.md` completed with `npm test`.
- [x] **Live/Manual Validation:** `npm run smoke:live` passed, and focused `npm run smoke:live -- --scenario risk-routing --cleanup` passed after final cleanup.
- [x] **Behavior Proof:** Unit tests cover config compatibility, scoped warn/block, scoped retry, parent warn rendering, parent block stop point, and live smoke exercises real runner wiring.
- [x] **Final Reconciliation:** No unchecked work remains.
- [x] **Final Handoff Requirements:** Final response includes contract implemented, high-risk checkpoint outcome, main invariants proved, cleanup-review/code-review findings and fixes, validation results, live smoke result or blocker, skipped checks, residual risks, and files by role.

## Defect Closure Notes
- [x] Review defect fixed: default `riskyChangedPathGlobs` is deterministic as `[]`, with tests for empty-disabled and explicit-enabled behavior.
- [x] Review defect fixed: parent warning threading is mandatory through `PlanAutoCommandResult` and parent PR/report builders.
- [x] Review defect fixed: spec-maker final response protocol is not included in the saved implementation spec.
