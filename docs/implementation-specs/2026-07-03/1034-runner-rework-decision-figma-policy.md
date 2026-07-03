---
title: "Implement Runner Rework Decision And Figma Dependency Policy"
created_at: "2026-07-03T07:34:27Z"
source_type: "plan"
source_plan: "/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-03/1026-runner-rework-decision-figma-policy.md"
source_issues:
  - "None"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_verdict: "Approved"
---

## 1. Execution Context
- **Goal:** Replace the boolean rework helper model with a first-class `ReworkDecision` flow so fixable quality/proof failures continue through bounded rework, while hard blockers still stop safely, and Figma MCP access is optional or required according to issue text policy.
- **Source Material:** Approved plan `/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-03/1026-runner-rework-decision-figma-policy.md`; repo evidence in `CONTEXT.md`, `docs/adr/0001-runner-owned-loop-policy.md`, `docs/deep-dive.md`, `package.json`, `src/runner/rework-policy.ts`, `src/runner/scoped-auto-command.ts`, `src/runner/plan-auto-command.ts`, `src/runner/scoped-recovery.ts`, `src/runner/local-execution-session.ts`, `src/runner/review-gates.ts`, `src/runner/review-gate-policy.ts`, `src/runner/completion-report.ts`, `src/codex/command-adapter.ts`, `src/config/schema.ts`, `src/setup/project-config.ts`, `scripts/live-smoke.mjs`, and `test/live-smoke-script.test.ts`.
- **Approved Scope:** Update package runner policy, scoped/tree-child/recovery rework call sites, attempt evidence, structured TDD validation evidence, Figma optional/required MCP policy, setup/config schema/defaults, bundled prompts/docs/tests, and a focused live-smoke scenario for tree-child quality-gate rework.
- **Out of Scope:** Do not implement or merge Levantem issues #262/#265, do not change GitHub label names, do not weaken runner-owned publication or deny safety rules, do not add a generic multi-MCP abstraction, and do not create compatibility wrappers for the removed rework helper pair.
- **Simplest Viable Path:** Make `src/runner/rework-policy.ts` the single decision owner, migrate existing callers to `decideImplementationRework()`, then add only the smallest report/config fields needed for structured TDD evidence and Figma dependency classification.
- **Primary Risk:** Retry classification, attempt state, and report evidence can drift across scoped, tree-child, recovery, review-gate, and live-smoke paths if more than one source of truth remains.

## 2. Preconditions And Evidence
- **Required Services / Env / Fixtures:** Local Node/npm environment; no `.env` or `.env.*` access; GitHub CLI and live smoke repo access only for the final live-smoke command; no external Figma credential is required for unit tests because Figma behavior must be simulated through mocked process output and prompt/config classification.
- **Blocking Unknowns:** None.
- **Confirmed Targets:** `src/runner/rework-policy.ts` exports `MISSING_COMPLETION_REPORT_REASON`, `shouldRequestImplementationRework()`, and `maxReworkAttemptsForReasons()` today. `src/runner/scoped-auto-command.ts`, `src/runner/plan-auto-command.ts`, and `src/runner/scoped-recovery.ts` import the old helper pair. `src/runner/plan-auto-command.ts` already has tree-child rework loop logic around publishability checks. `src/runner/review-gate-policy.ts` currently proves TDD by summary regex. `src/runner/completion-report.ts` validates validation items as `command/status/summary`. `src/codex/command-adapter.ts` injects Figma MCP config from `codex.figmaMcp.issueTextPatterns`. `scripts/live-smoke.mjs` owns `scenarioDefinitions`, `scenarioProfiles`, `runQualityGatesScenario`, `runPlanAutoScenario`, `runPlanAutoBlockingScenario`, and fake-agent scenario behavior. `test/live-smoke-script.test.ts` asserts help/profile/scenario behavior.
- **Confirmed Commands:** `npm run typecheck`; `npm test`; `npm run build && node --test dist/test/rework-policy.test.js`; `npm run build && node --test dist/test/plan-auto-command.test.js`; `npm run build && node --test dist/test/scoped-auto-command.test.js`; `npm run build && node --test dist/test/scoped-recovery.test.js`; `npm run build && node --test dist/test/completion-report.test.js dist/test/review-gates.test.js`; `npm run build && node --test dist/test/codex-command-adapter.test.js dist/test/config-schema.test.js dist/test/setup-command.test.js`; `npm run build && node --test dist/test/live-smoke-script.test.js`; `git diff --check`; `npm run smoke:live -- --scenario tree-child-quality-rework --cleanup`.
- **Protected Paths / Rejected Approaches:** Do not read/edit `.env` or `.env.*`; do not weaken `deny`, publication safety, worktree safety, acceptance proof safety, or GitHub label semantics; do not keep `shouldRequestImplementationRework()` or `maxReworkAttemptsForReasons()` as wrappers; do not hide a retry inside `CodexCommandAdapter`; do not make every Figma URL a hard block; do not use regex-only TDD proof as the primary path after structured evidence exists.
- **Architecture Lens:** Reused module: Runner Loop Policy in `src/runner/rework-policy.ts`. New public interface: `decideImplementationRework()`. Deletion test: if this decision API is deleted, retry/hard-block/exhausted classification spreads back into three callers, so the module has current depth and leverage. No new adapter abstraction is allowed for Figma because there is still one MCP policy.
- **Contract Test Ledger:**
  | Invariant | Risk | First RED Test/Proof | Status |
  | --- | --- | --- | --- |
| One decision API returns retry, exhausted, or hard-block and old helper exports are gone. | Boolean helper drift lets callers disagree on retry budget or hard blockers. | `test/rework-policy.test.ts` fails until `decideImplementationRework()` covers quality retry, exhausted budget, deny hard block, acceptance proof budget, and old helpers are not exported. | green |
| Scoped, tree-child, and recovery callers use the decision API. | One path still blocks prematurely or retries unsafe reasons. | Focused tests in `test/scoped-auto-command.test.ts`, `test/plan-auto-command.test.ts`, and `test/scoped-recovery.test.ts` fail if old imports remain or decisions are ignored. | green |
| Tree-child retry attempts write distinct prompt/report/log/snapshot evidence and do not mark parent blocked before retry budget exhaustion. | Maintainers cannot tell whether rework happened, and parent blocks while child is still fixable. | `test/plan-auto-command.test.ts` tree-child quality miss expects attempt 0 and attempt 1 artifacts, no parent `agent:blocked` before budget exhaustion, and parent success after rework. | green |
| Structured TDD evidence is the primary proof path inside existing `validation[]`. | Regex summary parsing rejects valid proof or accepts weak prose. | `test/completion-report.test.ts` and `test/review-gates.test.ts` fail until `validation[].evidence.kind === "tdd-red-green"` passes with red failed plus green passed evidence and malformed evidence is rejected. | green |
| Optional Figma MCP failure retries through normal rework with Figma disabled; required Figma failure hard-blocks. | Optional design links hang/block ordinary work, or required design work proceeds without design. | `test/codex-command-adapter.test.ts` and scoped runner Figma tests fail until optional and required pattern behavior is distinct and visible in decision evidence. | green |
| Live smoke proves the #265-like tree-child quality-gate rework path. | Unit tests pass but packaged CLI/live issue-tree behavior regresses. | `test/live-smoke-script.test.ts` fails until `tree-child-quality-rework` is listed/routable, then `npm run smoke:live -- --scenario tree-child-quality-rework --cleanup` passes. | green |

## Decision Contract
- `attempt` is zero-based and means the implementation attempt that just produced `reasons`. Attempt `0` is the original run. `loopPolicy.rework.maxAttempts` is the number of allowed rework attempts after the original run. Retry is allowed only when `attempt < maxAttempts`.
- Generic max attempts: `config.loopPolicy.rework.maxAttempts`. Acceptance-proof max attempts: `Math.max(0, config.reviewGates.acceptanceProof.maxIterations - 1)`. If any reason maps to `failed-acceptance-proof`, use the acceptance-proof max; otherwise use generic max.
- Hard-block precedence: if any reason maps to a hard blocker, return `hard-block` even when other reasons are retryable.
- Exhausted behavior: if at least one reason maps to a configured retryable blocker and `attempt >= maxAttempts`, return `exhausted`, not `hard-block`.
- Unknown reasons are hard-block unless another recognized hard blocker already explains them; do not retry unknown `Codex exited with code ...` failures.

```ts
export type ReworkBlockerKey =
  | 'missing-completion-report'
  | 'invalid-completion-report'
  | 'no-changed-files'
  | 'failed-configured-checks'
  | 'missing-quality-gate-evidence'
  | 'failed-acceptance-proof'
  | 'risk-routing-policy'
  | 'optional-figma-mcp-failure'
  | 'required-figma-mcp-failure'
  | 'denied-path'
  | 'publication-violation'
  | 'destructive-or-production-action'
  | 'unknown';

export interface ReworkDecisionInput {
  reasons: string[];
  config: CodexOrchestratorConfig;
  attempt: number;
}

export type ReworkDecision =
  | {
      kind: 'retry';
      attempt: number;
      nextAttempt: number;
      maxAttempts: number;
      blockerKeys: ReworkBlockerKey[];
      reasons: string[];
      rework: {
        attempt: number;
        blockedReasons: string[];
        disableOptionalFigmaMcp: boolean;
      };
    }
  | {
      kind: 'exhausted';
      attempt: number;
      maxAttempts: number;
      blockerKeys: ReworkBlockerKey[];
      reasons: string[];
    }
  | {
      kind: 'hard-block';
      attempt: number;
      blockerKeys: ReworkBlockerKey[];
      reasons: string[];
    };
```

## Figma Failure Contract
- Extend `CodexCommandRunResult` with optional metadata:

```ts
figmaMcp?: {
  requirement: 'none' | 'optional' | 'required';
  enabled: boolean;
};
```

- `CodexCommandAdapter.run()` sets `figmaMcp.requirement` from prompt/config classification for each attempt and sets `enabled` to whether Figma MCP options were inserted for that attempt.
- `CodexCommandRunInput` gets optional `disableOptionalFigmaMcp?: boolean`. When true, optional Figma MCP is not inserted; required Figma MCP is still inserted.
- Figma MCP failure is recognized only when all are true: `codexResult.exitCode !== 0`; `codexResult.figmaMcp.enabled === true`; output is `stderr + "\n" + stdout`; output matches `/\bfigma\b[\s\S]{0,120}\b(?:mcp|server|tool|connection|connect|timeout|timed out|401|403|auth|unauthorized|forbidden|unavailable|failed)\b/iu` or `/mcp_servers\.figma/iu`.
- Optional failure reason string must be exactly `Optional Figma MCP failed before completion; retry without optional Figma MCP.` and maps to `optional-figma-mcp-failure`.
- Required failure reason string must be exactly `Required Figma MCP failed; required design access is unavailable.` and maps to `required-figma-mcp-failure` hard-block.
- Non-Figma non-zero Codex exits keep the existing `Codex exited with code ...` reason and map to `unknown` hard-block.

## Risk Controls
- **Source of Truth:** `src/runner/rework-policy.ts` owns retryable/hard-block classification, budget calculation, and final decision shape. Callers may not reimplement reason matching or attempt limits.
- **Safety Constraints:** Existing deny/publication/destructive/prod blockers remain hard-block. Non-zero Codex exits are not made retryable by default. No secret files may be read or edited.
- **Contract Constraints:** Completion report schema remains backward-compatible for existing `{ command, status, summary }` validation lines, but structured TDD evidence is the preferred path when present. `validation[]` remains the only source of validation evidence.
- **Concurrency / State Constraints:** Retrying continues in the existing worktree and must not reset user or agent changes. Each attempt updates `RunnerStateStore` and lifecycle events with attempt-specific paths. Parent issue-tree publication waits until all retryable child work has either passed or exhausted/hard-blocked.
- **Forbidden Scope:** No generic MCP framework, no compatibility wrappers for old rework helpers, no hidden adapter rerun, no label rename, no release/publish automation change.
- **Early Review Gate:** After Slice 1, run `$code-review` on `src/runner/rework-policy.ts` plus migrated caller imports/conditionals before adding TDD evidence, Figma policy, or smoke work. Continue only after high-confidence findings are fixed or explicitly recorded as blocked.
- **Final Handoff Requirements:** Final executor response must summarize implemented contract, risky checkpoint result, contract ledger status, review findings/fixes, validation commands, live smoke result, skipped checks, residual risks, and files by role.

## Write Scope Summary
- `src/runner/rework-policy.ts` - Update; define `ReworkDecision`, decision input, reason category mapping, budget logic, exact Figma failure reason mapping, and remove old helper exports.
- `src/runner/scoped-auto-command.ts` - Update; use decision API and attempt evidence.
- `src/runner/plan-auto-command.ts` - Update; use decision API for tree-child, split attempt artifacts, update state per attempt, preserve parent atomicity.
- `src/runner/scoped-recovery.ts` - Update; use decision API for missing report retry.
- `src/runner/prompt.ts` - Update; shared rework prompt wording and structured TDD/Figma rework instructions.
- `src/runner/completion-report.ts` - Update; parse optional structured validation evidence.
- `src/runner/handoff-evidence.ts` - Update; validation evidence type and rendered attempt evidence.
- `src/runner/durable-run-summary.ts` - Update; include concise attempt history when an issue exhausts rework or hard-blocks after attempts.
- `src/runner/review-gate-policy.ts` and `src/runner/review-gates.ts` - Update; prefer structured TDD evidence, retain regex fallback.
- `src/runner/local-execution-session.ts` - Update; produce exact optional/required Figma failure reason strings before generic Codex exit reason.
- `src/config/schema.ts` - Update; Figma optional/required policy fields and validation.
- `src/setup/project-config.ts` - Update; defaults and migration from existing Figma config.
- `src/codex/command-adapter.ts` - Update; classify Figma MCP enablement for an attempt, return Figma metadata, and respect `disableOptionalFigmaMcp` without retrying internally.
- `scripts/live-smoke.mjs` - Update; add `tree-child-quality-rework` scenario and fake-agent behavior.
- `test/rework-policy.test.ts`, `test/plan-auto-command.test.ts`, `test/scoped-auto-command.test.ts`, `test/scoped-recovery.test.ts`, `test/completion-report.test.ts`, `test/review-gates.test.ts`, `test/codex-command-adapter.test.ts`, `test/config-schema.test.ts`, `test/setup-command.test.ts`, `test/live-smoke-script.test.ts` - Update/add focused behavior tests.
- `README.md`, `docs/deep-dive.md`, `CHANGELOG.md` - Update docs for decision API behavior, structured TDD evidence, Figma policy, and live-smoke coverage.

## 3. Execution Slices

### Progress Discipline
- [x] Update this checklist as work is completed.
- [x] Leave blocked work unchecked with a short `Blocked:` note.
- [x] Stop if repo reality contradicts a confirmed target, command, precondition, or scope boundary.
- [x] Keep each implementation phase as a vertical tracer-bullet slice, not a horizontal layer pass.
- [x] For behavior changes, start each slice with a behavior-first test/proof before implementation work.
- [x] Update the Contract Test Ledger status as each invariant moves planned -> red -> green or blocked.
- [x] Run required Review Checkpoints before continuing past risky retry/state work.

### Slice 1 - Rework Decision Core
- [x] Objective: One first-class policy decision replaces the old helper pair and governs retry, exhausted, and hard-block outcomes.
- [x] Test/Proof First: In `test/rework-policy.test.ts`, replace old helper tests with failing tests for `decideImplementationRework()` covering: quality-gate retry when `attempt: 0` and `maxAttempts: 1`; exhausted quality-gate budget when `attempt: 1` and `maxAttempts: 1`; deny/publication/destructive hard-block precedence; acceptance-proof budget using `reviewGates.acceptanceProof.maxIterations - 1`; configured risk-routing retry only when listed; optional Figma retry with `disableOptionalFigmaMcp: true`; required Figma hard-block; old helper exports unavailable from `src/runner/rework-policy.ts`.
- [x] Target: `src/runner/rework-policy.ts`
  - [x] Action: Export the exact `ReworkDecisionInput`, `ReworkDecision`, and `ReworkBlockerKey` contract above; keep `MISSING_COMPLETION_REPORT_REASON`; remove `shouldRequestImplementationRework()` and `maxReworkAttemptsForReasons()` exports.
  - [x] Validation: `npm run build && node --test dist/test/rework-policy.test.js`.
- [x] Target: `src/runner/scoped-auto-command.ts`, `src/runner/plan-auto-command.ts`, `src/runner/scoped-recovery.ts`
  - [x] Action: Replace old imports and retry conditionals with `decideImplementationRework()` handling. For `retry`, pass `decision.rework` to the next prompt and pass `disableOptionalFigmaMcp` into the next Codex run. For `exhausted` and `hard-block`, proceed to existing blocked handoff with decision details. Preserve existing behavior for passed, promotion, and hard-block safety.
  - [x] Validation: `npm run build && node --test dist/test/scoped-auto-command.test.js dist/test/plan-auto-command.test.js dist/test/scoped-recovery.test.js`.

### Slice 1 Exit Gate
- [x] `npm run build && node --test dist/test/rework-policy.test.js dist/test/scoped-auto-command.test.js dist/test/plan-auto-command.test.js dist/test/scoped-recovery.test.js` passes.
- [x] `rg "shouldRequestImplementationRework|maxReworkAttemptsForReasons" src test` returns no matches.

### Review Checkpoint 1 - Retry Policy Source Of Truth
- [x] Run `$code-review` on the Slice 1 diff before continuing.
- [x] Continue only after findings about unsafe retry, duplicated reason matching, exhausted budget, hard-block leakage, or caller drift are fixed or explicitly recorded as blocked.

### Review Focus 1
- Verify there is one source of truth for retry classification and budget.
- Hunt for retrying denied paths, publication violations, destructive/prod actions, unknown Codex exits, or required Figma failures.
- Check that scoped, tree-child, and recovery callers do not duplicate reason regexes or attempt limits.
- Check zero-based attempt semantics: `attempt < maxAttempts` retries, `attempt >= maxAttempts` exhausts.

### Slice 2 - Attempt Evidence And Parent Blocking Semantics
- [x] Objective: Retry attempts are visible, attempt-specific, and do not mark parent/child blocked until the decision is exhausted or hard-blocked.
- [x] Test/Proof First: In `test/plan-auto-command.test.ts`, add/adjust a tree-child quality-gate test where attempt 0 fails with missing TDD proof, attempt 1 succeeds, parent ends review-ready, child ends review-ready, no parent `agent:blocked` label/comment is posted, and attempt 0/1 prompt/report/log/snapshot artifacts are distinct.
- [x] Target: `src/runner/plan-auto-command.ts`
  - [x] Action: Move tree-child prompt/report/log/session id creation inside the attempt loop so paths include the attempt timestamp/session; update `RunnerStateStore.upsertRun()` per attempt; append lifecycle events for `retry`, `exhausted`, and `hard-block` decisions.
  - [x] Validation: `npm run build && node --test dist/test/plan-auto-command.test.js`.
- [x] Target: `src/runner/scoped-auto-command.ts`
  - [x] Action: Add decision/exhaustion detail to scoped lifecycle/durable evidence and preserve recovery retry input behavior.
  - [x] Validation: `npm run build && node --test dist/test/scoped-auto-command.test.js dist/test/scoped-recovery.test.js`.
- [x] Target: `src/runner/durable-run-summary.ts`, `src/runner/handoff-evidence.ts`
  - [x] Action: Add concise attempt history fields/rendering for exhausted and hard-block handoffs: attempt, maxAttempts, decision kind, reasons, and prompt/report/log paths.
  - [x] Validation: Existing handoff/durable summary tests updated and passing under focused plan/scoped/recovery tests.

### Slice 2 Exit Gate
- [x] Focused plan-auto/scoped/recovery tests pass and show parent remains unblocked until exhausted/hard-block.
- [x] Contract Test Ledger rows for decision API, caller migration, and tree-child attempt evidence are updated to green or blocked.

### Slice 3 - Structured TDD Evidence In Existing Validation Lines
- [x] Objective: Valid red-to-green proof is machine-readable and no longer depends primarily on summary regex.
- [x] Test/Proof First: In `test/completion-report.test.ts`, add failing cases for a valid validation item with `evidence.kind: "tdd-red-green"`, red failed command/summary, green passed command/summary; malformed evidence with red passed or green failed; and legacy validation lines still accepted. In `test/review-gates.test.ts`, add failing cases proving structured TDD evidence passes without regex-friendly summary text and malformed evidence fails.
- [x] Target: `src/runner/completion-report.ts`
  - [x] Action: Parse and validate optional `validation[].evidence` for `tdd-red-green`; keep existing validation item fields required.
  - [x] Validation: `npm run build && node --test dist/test/completion-report.test.js`.
- [x] Target: `src/runner/handoff-evidence.ts`, `src/runner/review-gate-policy.ts`, `src/runner/review-gates.ts`
  - [x] Action: Extend `RunnerValidationLine` typing and `hasPassedTddValidation()` to prefer structured evidence, then fallback to existing regex behavior.
  - [x] Validation: `npm run build && node --test dist/test/review-gates.test.js`.
- [x] Target: `src/runner/prompt.ts`
  - [x] Action: Update completion report instructions so agents emit structured TDD evidence for behavior-changing work.
  - [x] Validation: `npm run build && node --test dist/test/prompt-builder.test.js`.

### Slice 3 Exit Gate
- [x] Completion-report, review-gates, and prompt-builder tests pass.
- [x] Contract Test Ledger structured TDD row is green or blocked.

### Slice 4 - Figma Optional/Required Dependency Policy
- [x] Objective: Figma links enable MCP when useful, optional MCP failure routes to bounded rework without MCP, and required design access hard-blocks.
- [x] Test/Proof First: In `test/config-schema.test.ts` and `test/setup-command.test.ts`, add failing tests for new `codex.figmaMcp.optionalIssueTextPatterns`, `codex.figmaMcp.requiredIssueTextPatterns`, `optionalFailure: "retry-without-mcp"`, and `requiredFailure: "block"` defaults/migration. In `test/codex-command-adapter.test.ts`, add failing tests for optional prompt enabling MCP, `disableOptionalFigmaMcp` skipping optional MCP, and required prompt still requiring MCP. In `test/plan-auto-command.test.ts` or `test/scoped-auto-command.test.ts`, add a mocked optional Figma MCP failure reason that produces a retry decision and a mocked required failure reason that hard-blocks.
- [x] Target: `src/config/schema.ts`
  - [x] Action: Extend `CodexFigmaMcpConfig` with `optionalIssueTextPatterns`, `requiredIssueTextPatterns`, `optionalFailure: 'retry-without-mcp'`, `requiredFailure: 'block'`, and deprecated `issueTextPatterns?: string[]` input support normalized to optional patterns.
  - [x] Validation: `npm run build && node --test dist/test/config-schema.test.js`.
- [x] Target: `src/setup/project-config.ts`
  - [x] Action: Set defaults and migrate existing `issueTextPatterns` into `optionalIssueTextPatterns`; generated config should write the new shape, not the legacy key.
  - [x] Validation: `npm run build && node --test dist/test/setup-command.test.js`.
- [x] Target: `src/codex/command-adapter.ts`
  - [x] Action: Add `disableOptionalFigmaMcp?: boolean` to `CodexCommandRunInput`; return `figmaMcp` metadata on `CodexCommandRunResult`; classify prompt as `none`, `optional`, or `required`; insert MCP only when enabled and not disabled by optional retry.
  - [x] Validation: `npm run build && node --test dist/test/codex-command-adapter.test.js`.
- [x] Target: `src/runner/local-execution-session.ts`, `src/runner/rework-policy.ts`, `src/runner/scoped-auto-command.ts`, `src/runner/plan-auto-command.ts`, `src/runner/prompt.ts`
  - [x] Action: Convert matching Figma non-zero Codex exits into the exact optional/required reason strings from the Figma Failure Contract; route optional reason to retry with `disableOptionalFigmaMcp: true`; route required reason to hard-block.
  - [x] Validation: Focused scoped/plan-auto tests pass.

### Slice 4 Exit Gate
- [x] `npm run build && node --test dist/test/codex-command-adapter.test.js dist/test/config-schema.test.js dist/test/setup-command.test.js dist/test/plan-auto-command.test.js dist/test/scoped-auto-command.test.js` passes.
- [x] Contract Test Ledger Figma row is green or blocked.

### Slice 5 - Live Smoke Scenario For Tree-Child Quality Rework
- [x] Objective: Packaged CLI live smoke reproduces a tree-child quality-gate rework and proves the child continues instead of blocking the parent prematurely.
- [x] Test/Proof First: In `test/live-smoke-script.test.ts`, add a failing assertion that help lists `tree-child-quality-rework`, the desired profile routing includes it if added to a profile, and fake-agent/source markers support the scenario.
- [x] Target: `scripts/live-smoke.mjs`
  - [x] Action: Add `tree-child-quality-rework` to `scenarioDefinitions`; add `runTreeChildQualityReworkScenario(context)` that configures `loopPolicy.rework.maxAttempts: 1`, creates an `agent:plan-auto` parent issue, makes fake child attempt 0 miss structured TDD evidence, makes retry attempt 1 pass with structured TDD evidence, and asserts parent/child review-ready plus no parent blocked label/comment before retry exhaustion.
  - [x] Validation: `npm run build && node --test dist/test/live-smoke-script.test.js`.
- [x] Target: fake agent raw template inside `scripts/live-smoke.mjs`
  - [x] Action: Add deterministic markers/counters for tree-child quality-rework using the existing prompt/report env files; do not depend on external Figma or real Codex.
  - [x] Validation: Existing fake-agent unit tests plus new scenario tests pass.

### Slice 5 Exit Gate
- [x] `npm run build && node --test dist/test/live-smoke-script.test.js` passes.
- [x] The final live command to run after all implementation slices is documented as `npm run smoke:live -- --scenario tree-child-quality-rework --cleanup`.

### Slice 6 - Docs And Config Rollout
- [x] Objective: Package docs and defaults explain the new decision model, structured TDD proof, and Figma optional/required policy.
- [x] Test/Proof First: Run `rg "shouldRequestImplementationRework|maxReworkAttemptsForReasons" README.md docs src test` and fail the slice if docs still instruct old helper usage; run config/setup tests from Slice 4. Note: broad historical `docs/` contains archived plans/specs quoting old helper names as past context, so live-doc validation used `README.md docs/deep-dive.md src test`.
- [x] Target: `README.md`
  - [x] Action: Document retry/hard-block/exhausted behavior at user level and name the focused live-smoke command.
  - [x] Validation: `rg "tree-child-quality-rework|retry|hard-block|exhausted" README.md` shows the updated concepts.
- [x] Target: `docs/deep-dive.md`
  - [x] Action: Update Loop Policy, bounded rework, TDD evidence, Figma dependency behavior, and recovery notes.
  - [x] Validation: `rg "ReworkDecision|structured TDD|Figma" docs/deep-dive.md` shows the updated concepts.
- [x] Target: `CHANGELOG.md`
  - [x] Action: Add unreleased/release-note bullet for bounded decision rework and Figma policy.
  - [x] Validation: `git diff --check`.

### Slice 6 Exit Gate
- [x] Docs mention the new behavior and do not preserve old helper usage as the implementation path.

### Slice 7 - Final Validation And Reconciliation
- [x] Objective: Prove package correctness locally and with the new live smoke before handoff.
- [x] Test/Proof First: Run focused commands from previous slices before full suite to isolate regressions.
- [x] Target: whole repo
  - [x] Action: Run final validation commands in order.
  - [x] Validation: `npm run typecheck`; `npm test`; `git diff --check`; `npm run smoke:live -- --scenario tree-child-quality-rework --cleanup`.
- [x] Target: spec checklist and Contract Test Ledger
  - [x] Action: Mark all completed items `[x]`, leave blocked items unchecked with `Blocked:` note, and update each ledger row to green or blocked.
  - [x] Validation: Manual final reconciliation pass.

### Slice 7 Exit Gate
- [x] Full local validation and focused live smoke pass, or failures are recorded with exact blocker and artifact/log path.

## 4. Validation And Done Criteria
- [x] **Lint/Format:** `git diff --check`.
- [x] **Typecheck:** `npm run typecheck`.
- [x] **Tests:** `npm test`.
- [x] **Architecture Check:** `$cleanup-review` after implementation; final `$code-review` after cleanup fixes.
- [x] **Live/Manual Validation:** `npm run smoke:live -- --scenario tree-child-quality-rework --cleanup`.
- [x] **Behavior Proof:** Unit tests prove decision, caller migration, structured TDD evidence, Figma optional/required behavior, and live-smoke scenario routing; live smoke proves packaged tree-child quality rework behavior.
- [x] **Final Reconciliation:** all unchecked work is unfinished, blocked with a note, or intentionally not applicable.
- [x] **Final Handoff Requirements:** Final response must include contract implemented, high-risk checkpoint result, main invariants proved, cleanup-review/code-review findings and fixes, validation commands, live-smoke result, skipped checks, residual risks, and files by role.

## Halt Conditions
- [x] Stop if any caller still imports or uses `shouldRequestImplementationRework()` or `maxReworkAttemptsForReasons()` after Slice 1.
- [x] Stop if a retry path would retry denied paths, runner-owned publication violations, destructive/prod actions, unknown Codex exits, or required Figma failures.
- [x] Stop if optional Figma failure can mark a non-required design issue hard-blocked, or required Figma failure can continue without hard-block evidence.
- [x] Stop if tree-child retry can mark the parent blocked before retry budget is exhausted.
- [x] Stop if structured TDD evidence creates a second validation source outside `validation[]`.
- [x] Stop if live-smoke scenario cannot be made deterministic without real Figma or non-mocked external design access.

## Defect Closure Notes
- [x] Initial implementation-spec-review rejected the draft because `ReworkDecision`, Figma failure classification, final spec path, and conditional write scope were underspecified. This revision fixes those defects with exact contracts.

## 5. Final Action
After saving the file, respond in chat with exactly:

Spec Status: Ready
Saved Path: docs/implementation-specs/2026-07-03/1034-runner-rework-decision-figma-policy.md
Execution Model: Single-Agent
Review Verdict: Approved
Validation Gates: Local / Live / Tests
Blockers: None
