---
title: "Risk Routing Enforcement For Review Gates"
created_at: "2026-07-01T18:34:23Z"
complexity: "medium"
status: "ready-for-approval"
---

## 1. Executive Summary
- **Goal:** Add deterministic, runner-owned enforcement for risk-routing metadata already produced by prompts and completion reports, so small tasks stay review-light while high-risk work cannot silently skip proof, review focus, or parent handoff expectations.
- **Scope:** In scope: backward-compatible `reviewGates.riskRouting` config, scoped review-gate evaluation, parent `plan-auto` metadata gate before parent content/child/PR/comment mutations in block mode, explicit warn/block rendering, scoped retryable blocker wiring, tests, a risk-routing live smoke scenario, running live smoke after local validation, and docs. Out of scope: LLM risk inference, new GitHub labels outside the controlled live smoke scenario, parent planning rework loop, prompt sync behavior, external services, and weakening existing quality gates by default.
- **Chosen Option:** Option 3, phased warn-to-block enforcement, delegated by the user and recommended.
- **Why This Approach:** The simplest sufficient path is to validate declared metadata and changed-path evidence through runner-owned gates. Warn mode gives visibility without breaking existing runs; block mode becomes explicit repo policy once metadata is stable.

Product options considered:
1. Warn-only. Emit risk-routing warnings but never block publication. Choose when metadata reliability is unknown.
2. Immediate block-mode. Fail publication whenever configured risk metadata rules are violated. Choose only after measured reliability.
3. Phased warn-to-block. `mode: "warn" | "block"` controls whether findings land in warnings or blockers. Choose now.

## 2. Current Understanding
- **Confirmed:** `reviewGates` is the existing config surface. `evaluateReviewGates` returns blockers as `reasons` and advisory output as `warnings`. `ScopedCompletionReport` supports optional `reviewHandoff`. `PlanAutoCompletionReport` supports optional `sizeRisk` and `parentReviewHandoff`. `rework-policy.ts` only retries known blocker classes, so scoped risk-routing blockers need explicit retryable wiring. Parent `plan-auto` has no planning rework loop today. Parent `plan-auto` already claims/running-labels the parent before the planning report exists, so the new parent gate cannot precede every parent issue mutation.
- **Assumptions:** Agent metadata is untrusted evidence: useful for policy, never enough to weaken existing gates by default. Existing target repos must not fail when they lack `reviewGates.riskRouting`. Default config is non-breaking: `enabled: true`, `mode: "warn"`.
- **Open Decisions:** None blocking implementation. This plan decides: parent block-mode findings stop immediately after `readPlanReport` and before parent content update, child issue creation, child execution, parent PR creation, or final parent comment; parent findings are not retryable in this slice; `sizeRisk` must partition every `graph.nodes[].stableId` exactly once when `requireParentSizeRisk` is enabled; all `reviewHandoff` arrays must be non-empty when scoped handoff is required.

## 3. Architectural Design
- **Component Flow:**
  - Scoped path: Agent writes scoped completion report -> runner validates report shape -> publishability calls `evaluateReviewGates` -> quality, visual proof, and scoped risk-routing gates produce warnings/reasons -> existing rework or review-ready publication path continues.
  - Parent path: Plan agent writes `PlanAutoCompletionReport` -> runner validates report shape -> new parent risk-routing gate runs immediately after `readPlanReport`. In warn mode, findings are stored and rendered in parent report/PR/comment output while execution continues. In block mode, the runner stops before parent content update, child issue creation, child execution, parent PR creation, or final parent comment; it reports a blocked parent planning result. No parent planning rework loop is added in this slice.
- **Simplest Viable Path:** Add one config object, one scoped helper inside `src/runner/review-gates.ts`, one parent helper near plan-auto report handling, and one scoped retryable blocker class. Keep predicates deterministic and string/glob based.
- **Why Not Simpler:** Completion-report parsing cannot make metadata required without breaking old reports and promotion paths. Prompt-only guidance cannot affect publication. A scoped-only gate misses parent metadata because parent reports do not pass through `evaluateReviewGates`.
- **Architecture Lens:** Module: runner review policy. Interface: scoped `evaluateReviewGates(input): ReviewGateResult`; parent helper returns the same `{ ok, reasons, warnings }` shape. Seam: config-driven policy, not a new adapter. Deletion test: deleting risk-routing helpers removes only this policy family while preserving quality/visual gates.
- **Clean Architecture Map:** Domain: risk levels, flow names, parent size buckets, and exact policy findings. Application/Use Case: scoped publishability and parent planning publication gates. Infrastructure: config schema/default migration and path glob matching. Presentation: PR/comment rendering consumes warnings and handoff data but does not decide enforcement.
- **Reuse Strategy:** Reuse `ScopedCompletionReport.reviewHandoff`, `PlanAutoCompletionReport.sizeRisk`, `PlanAutoCompletionReport.parentReviewHandoff`, `ReviewGateResult`, `hasPassedValidation`, `classifyChangedPaths`, path/glob helpers, `rework-policy.ts`, and current test files.
- **Rejected Paths:** No LLM risk inference. No GitHub labels as source of truth. No hard default block mode. No duplicate enforcement in prompts. No parent planning rework loop in this slice. No new adapter layer. No compact-validation exception that weakens existing TDD/code-review gates.

### Deterministic Predicate Contract
Config shape:
- `reviewGates.riskRouting.enabled: boolean`
- `reviewGates.riskRouting.mode: "warn" | "block"`
- `reviewGates.riskRouting.requireScopedReviewHandoff: boolean`
- `reviewGates.riskRouting.requireParentSizeRisk: boolean`
- `reviewGates.riskRouting.requireParentReviewHandoff: boolean`
- `reviewGates.riskRouting.riskyChangedPathGlobs: string[]`
- `reviewGates.riskRouting.highRiskRequiresCodeReview: boolean`
- `reviewGates.riskRouting.allowedLowRiskFlows: ReviewHandoffFlow[]`, default `['small-task-implementer', 'scoped-implementation']`

Predicate table:
- Missing scoped `reviewHandoff` while `requireScopedReviewHandoff` is true -> finding `Risk routing gate requires scoped reviewHandoff.` Scoped retryable: yes in block mode via `risk-routing-policy`.
- Present/required scoped `reviewHandoff` with any empty `implementedContract`, `proofByAcceptanceCriteria`, `reviewFocus`, or `humanReviewChecklist` array -> finding naming the empty field. Scoped retryable: yes in block mode.
- `riskLevel: low` with `flowUsed` not in `allowedLowRiskFlows` -> finding. Scoped retryable: yes in block mode.
- `riskLevel: low` and any changed file matches `riskyChangedPathGlobs` -> finding. Scoped retryable: yes in block mode. This does not infer high risk; it only says the low-risk claim is inconsistent with configured paths.
- `riskLevel: high` and `highRiskRequiresCodeReview` true without passed code-review evidence by existing `hasPassedValidation(...quality.codeReview.requiredValidationPatterns)` -> finding. Scoped retryable: yes in block mode.
- Missing parent `sizeRisk` while `requireParentSizeRisk` is true -> parent finding. Parent retryable: no in this slice.
- Parent `sizeRisk.small|medium|high` does not partition every `graph.nodes[].stableId` exactly once -> parent finding. Parent retryable: no in this slice.
- Missing parent `parentReviewHandoff` while `requireParentReviewHandoff` is true -> parent finding. Parent retryable: no in this slice.
- Parent `parentReviewHandoff.risks`, `proofStrategy`, or `humanReviewFocus` is empty -> parent finding. Parent retryable: no in this slice.

Finding application:
- If `enabled` is false, no findings.
- If `mode` is `warn`, findings append to `warnings`, `ok` remains determined by other blockers.
- If `mode` is `block`, scoped findings append to `reasons` and can trigger existing scoped/child rework; parent findings append to parent gate `reasons` and stop before parent content/child/PR/comment mutations without retry.

## 4. Constraints And Edge Cases
- **Data And Scale:** Inputs are small arrays of changed file paths, graph nodes, and report strings. Use array scans and configured glob matching only.
- **Errors And Fallbacks:** Missing `riskRouting` in existing configs must be defaulted during config merge/setup and accepted by schema migration tests. Malformed report metadata remains a completion-report validation error. Unknown enum values remain schema errors until deliberately added. Empty risky glob lists are valid and disable low-risk path inconsistency checks.
- **Concurrency And State:** Gates are pure. They must not mutate GitHub, worktrees, reports, or config. Parent block-mode gate runs after parent claim/running-label setup but before parent content update, child creation/execution, parent PR creation, or final parent comment, so it cannot leave partially created child issues or draft PRs.
- **Retry Semantics:** Add `risk-routing-policy` to `RetryableReworkBlocker`, default retryable blockers, schema validation, and `rework-policy.ts` matching for scoped/child implementation only. Parent risk-routing blockers are non-retryable until a parent planning rework loop is deliberately added later.
- **Rendering Semantics:** Scoped warnings reuse existing review report/PR body warning surfaces where available. Parent warn-mode findings must be passed explicitly into `PlanAutoCommandResult`, `buildIssueTreeReviewReport`, and `buildIssueTreePullRequestBody`, rendered under `Risk routing warnings`, and not hidden inside `residualRisks`. Parent block-mode findings must appear in the blocked report/comment/result before child or PR publication.
- **Live Smoke Semantics:** The implementation must add a focused live smoke scenario for this policy family, then run it after local tests. The smoke should prove the real runner wiring, not re-test every predicate already covered by unit tests. It should use the existing live-smoke harness and leave its created GitHub artifacts clearly attributable to the smoke run.

## 5. Impacted Areas
- `src/config/schema.ts`: add risk-routing config types, validation, and `risk-routing-policy` retryable blocker enum.
- `src/setup/project-config.ts`: add default risk routing and merge/migrate it so old configs remain valid.
- `.codex-orchestrator/config.json` and `test/fixtures/config.ts`: add current repo/default fixture config.
- `src/runner/review-gates.ts`: add scoped `evaluateScopedRiskRoutingGate` and merge findings into warnings/reasons.
- `src/runner/plan-auto-command.ts`: run parent gate immediately after plan report validation; carry warn-mode findings into final parent output; stop block-mode before parent content/child/PR/comment mutations.
- `src/runner/rework-policy.ts`: add retry matching for scoped `risk-routing-policy`.
- `src/runner/handoff-evidence.ts`: render parent/scoped risk-routing warnings where needed.
- `scripts/live-smoke.mjs` and `docs/live-smoke-checklist.md` if needed: add a focused risk-routing smoke case and document what it proves.
- Tests: `test/config-schema.test.ts`, `test/setup-command.test.ts`, `test/rework-policy.test.ts`, `test/review-gates.test.ts`, `test/scoped-auto-command.test.ts`, `test/plan-auto-command.test.ts`, `test/fixtures/config.ts`.
- Docs: `docs/deep-dive.md` or README config section for warn/block semantics.

## 6. Execution Slices And Multi-Agent Model
- **Slices:**
  1. Config/backward-compat tracer bullet: add schema/defaults/merge behavior and `risk-routing-policy` enum. Prove stale configs without `riskRouting` still setup-migrate.
  2. Scoped warn-mode tracer bullet: missing/incomplete `reviewHandoff`, invalid low-risk flow, low-risk risky-path inconsistency, and high-risk missing code-review produce warnings when mode is `warn`.
  3. Scoped block-mode/rework tracer bullet: same scoped findings become `reasons` prefixed with `Risk routing gate requires`; `shouldRequestImplementationRework` returns true when `risk-routing-policy` is enabled.
  4. Parent warn-mode tracer bullet: missing/invalid `sizeRisk` or `parentReviewHandoff` renders `Risk routing warnings` in parent outputs while children can execute.
  5. Parent block-mode tracer bullet: same parent findings stop immediately after plan report validation and before parent content update, child creation/execution, parent PR creation, or final parent comment; no parent planning retry is attempted.
  6. Live smoke tracer bullet: add a focused live smoke scenario that exercises risk-routing through the real runner path, then run `npm run smoke:live` after local tests pass.
  7. Documentation/reconciliation slice: document mode behavior, record live smoke coverage, and finish validation.
- **Per-Slice Test/Proof:** Each behavior slice starts with a failing focused test in the listed test file, then implementation, then passing test. No UI proof required.
- **Exit Gates:** `npm run typecheck` after schema/type work if useful; final `npm test`; `git diff --check`; then `npm run smoke:live` for the new risk-routing live smoke coverage.
- **Agent Matrix:** Phase | Owner | Input | Output | Dependencies. Config | implementer | schema/default config | typed config, migration tests | none. Scoped gates | implementer | config + scoped report | warning/block findings | Config. Rework | implementer | scoped risk blockers | retry behavior | Config. Parent gate | implementer | plan-auto report | parent warning/block behavior | Config. Live smoke | implementer | completed local behavior | live smoke scenario and run evidence | all code slices. Docs/final | implementer | completed behavior | docs and full test/smoke proof | all prior slices.
- **Parallelization Limits:** Keep implementation in one worker unless split carefully; config schema/defaults, review gates, and tests overlap. Do not run live smoke until the focused smoke scenario is implemented and local `npm test` has passed.

## 7. Implementation Handoff Contract
- **approval_state:** ready-for-approval
- **approved_scope:** Add config-driven risk-routing enforcement for existing scoped and parent metadata, with non-breaking default warn mode, opt-in block mode, and focused live smoke coverage that is run after local validation.
- **do_not_touch:** `docs/agents/memory/lessons.md`, live GitHub issues/labels/PRs outside the controlled live smoke scenario, prompt sync behavior, unrelated visual proof internals, release files unless explicitly requested.
- **architecture_rules:** Enforcement must be deterministic, runner-owned, config-driven, and pure at evaluation time. Scoped and parent gates are separate. Warnings never block. Scoped blockers use existing `reasons` and retry through `risk-routing-policy`. Parent block-mode findings stop after parent claim/running-label setup but before parent content update, child creation/execution, parent PR creation, or final parent comment, and are non-retryable in this slice. Existing quality gates are not weakened by low-risk claims.
- **rejected_paths:** No LLM risk inference; no new GitHub label source of truth; no hard default block mode; no duplicated validation parsing for code-review/cleanup-review; no parent planning rework loop; no new adapter layer.
- **required_docs:** Add concise docs explaining `warn` vs `block`, when each applies, and what happens next.
- **preconditions:** Current risk metadata/report foundation exists. Local implementation does not require external services, but the final live smoke run requires the repo's normal live-smoke GitHub access and must be run only after local tests pass.
- **phase_boundaries:** Config/backward compatibility -> scoped warn/block -> scoped retry semantics -> parent warn/block gate -> live smoke scenario/run -> docs/final validation.
- **validation_gates:** Red/green tests per slice; final `npm test`; `git diff --check`; `npm run smoke:live` for the added risk-routing smoke scenario.
- **blocking_assumptions:** None.
