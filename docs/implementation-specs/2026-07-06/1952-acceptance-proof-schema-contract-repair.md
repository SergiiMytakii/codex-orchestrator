---
title: "Acceptance Proof schema contract and repair loop implementation"
created_at: "2026-07-06T19:52:38+03:00"
source_type: "plan"
source_plan: "/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-06/1950-acceptance-proof-schema-contract-repair.md"
source_issues:
  - "None"
status: "implemented"
execution_model: "single-agent"
spec_mode: "full"
review_verdict: "Approved"
---

## 1. Execution Context
- **Goal:** Make Acceptance Proof report shape a runner-owned executable contract consumed by validation, CLI, and adaptive proof prompts, then repair malformed adaptive proof reports inside proof instead of spending full implementation rework attempts.
- **Source Material:** Plan at `/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-06/1950-acceptance-proof-schema-contract-repair.md`; repo docs `CONTEXT.md`, `docs/adr/0001-runner-owned-loop-policy.md`, `docs/adr/0002-adaptive-acceptance-proof.md`, `docs/agents/execution-routing.md`, `.codex-orchestrator/config.json`, `package.json`, `tsconfig.json`.
- **Approved Scope:** Add one Acceptance Proof report shape contract in `src/runner/acceptance-proof.ts`; generate prompt template text and CLI validation from it; collect all schema/shape errors; add proof-agent self-validation prompt instructions; add one adaptive proof-report schema repair attempt; update focused tests and minimal docs.
- **Out of Scope:** GitHub publication authority changes; proof pass semantics changes; new browser/mobile tooling; new external schema dependency unless the internal collector proves insufficient; live smoke; release/version/package workflow changes; accepting product-code proof edits.
- **Simplest Viable Path:** Keep report shape and semantic evaluation in `acceptance-proof.ts`; add a thin CLI command and prompt renderer that consume that owner; make the proof loop call one explicit adaptive repair callback for malformed adaptive proof report shape before returning publishability blockers.
- **Primary Risk:** Creating another schema source or allowing malformed proof JSON to enter normal product implementation rework.

## 2. Preconditions And Evidence
- **Required Services / Env / Fixtures:** Node/npm only. No GitHub credentials, browser, mobile device, or live smoke prerequisites for local tests.
- **Blocking Unknowns:** None.
- **Confirmed Targets:** `src/runner/acceptance-proof.ts` (`AcceptanceProofReport`, `readAcceptanceProofReport`, `assertAcceptanceProofReport`, `evaluateAcceptanceProofReport`); `src/runner/acceptance-proof-runner.ts` (`runAcceptanceProofAdapter`, `buildAcceptanceProofPrompt`); `src/runner/acceptance-proof-loop.ts` (`runAcceptanceProofLoopAttempt`, invalid report handling); `src/runner/rework-policy.ts` (`failed-acceptance-proof` classifier); `src/runner/agent-attempt.ts` (implementation rework loop); `src/cli.ts`; tests `test/acceptance-proof.test.ts`, `test/acceptance-proof-loop.test.ts`, `test/scoped-auto-command.test.ts`, `test/cli.test.ts`.
- **Confirmed Commands:** Focused tests after each slice: `npm run build --silent && node --test dist/test/acceptance-proof.test.js`, `npm run build --silent && node --test dist/test/cli.test.js`, `npm run build --silent && node --test dist/test/scoped-auto-command.test.js`, `npm run build --silent && node --test dist/test/acceptance-proof-loop.test.js`. Final: `npm run typecheck`; `npm test`; `git diff --check`.
- **Protected Paths / Rejected Approaches:** Do not read/edit `.env` or `.env.*`. Do not run `npm run smoke:live`. Do not add Ajv/Zod unless stopped and justified. Do not define report fields in prompt text independent of `acceptance-proof.ts`. Do not make malformed proof schema a normal full implementation rework. Do not allow proof agent product-code edits.
- **Architecture Lens:** Reused Module: `acceptance-proof.ts` as the deep report contract/evaluation module. New helpers must be small public interfaces over real depth: shape validator, template builder, error formatter. Deletion test passes only if deleting the helper would reintroduce validator/prompt/CLI drift. No new adapter abstraction; adaptive and command proof remain existing concrete paths.

## Contract Test Ledger
| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| One malformed Acceptance Proof report returns all shape errors in one validation result, including per-criterion missing `description`, `reasoningSummary`, and `artifactRefs`. | Runner and proof rework spend one attempt per missing field. | `test/acceptance-proof.test.ts` new test `acceptance proof shape validation reports all schema errors at once`. | green |
| Prompt schema/template is generated from `acceptance-proof.ts` and no longer contains hardcoded one-line `Schema: {...}` prose. | Prompt and validator drift again. | `test/scoped-auto-command.test.ts` assertion on proof prompt template and source grep assertion excluding hardcoded schema line in `acceptance-proof-runner.ts`. | green |
| `codex-orchestrator acceptance-proof validate --report <path>` uses the same shape validator and returns nonzero with all shape errors. | Agent local self-check disagrees with runner. | `test/cli.test.ts` new CLI validation test for invalid and valid report files. | green |
| Adaptive proof prompt explicitly permits writing validated report JSON to `CODEX_ORCHESTRATOR_PROOF_REPORT_PATH` before final response, then requires returning the validated JSON as final output. | Agent cannot run local validation because Codex saves final output only after exit. | `test/scoped-auto-command.test.ts` prompt assertions for same-report self-validation flow. | green |
| Invalid adaptive proof report shape is repaired by exactly one proof-artifact repair attempt and does not consume a full implementation rework attempt. | Product code is re-run when only report JSON shape is wrong. | `test/acceptance-proof-loop.test.ts` new test with first invalid adaptive report then valid report from `executeAdaptiveProofRepair`. | green |
| Invalid adaptive proof report shape that remains invalid after one repair returns a terminal blocked proof-schema reason, not retryable implementation rework. | An invalid report can loop through `acceptanceProof.maxIterations` or unbounded nested proof repair. | `test/acceptance-proof-loop.test.ts` new repeated-invalid repair exhaustion test plus `test/rework-policy.test.ts` or existing rework-policy coverage for hard-block classification. | green |
| Valid `needs-rework` proof still routes to implementation rework evidence, not proof-artifact repair. | Real product behavior failures get hidden as report formatting repair. | `test/acceptance-proof-loop.test.ts` existing needs-rework test expanded or new assertion preserving `evidence.reworkRequest`. | green |

## Risk Controls
- **Source of Truth:** `src/runner/acceptance-proof.ts` owns report shape validation, template data, shape-error formatting, semantic evaluation, and report read result types. Prompt, CLI, and loop must import from it.
- **Safety Constraints:** Runner-owned publication boundary remains unchanged. Proof repair may rewrite the proof report and proof-owned artifacts only; product-code proof changes still block through existing proof diff classification.
- **Contract Constraints:** Shape validation answers structural/type/enum/object/array field correctness only. Semantic proof checks such as empty criteria, high confidence, artifact existence, UI Evidence completeness, and forbidden product diff stay in `evaluateAcceptanceProofReport` unless a field is structurally malformed.
- **Repair Contract:** `runAcceptanceProofLoopAttempt` gets a new optional `executeAdaptiveProofRepair(input)` callback. It is called only when adapter kind is `adaptive` and `readAcceptanceProofReport` returns `invalid`. Input must include `reportPath`, `artifactDir`, `schemaErrors`, and the previous `AcceptanceProofAdapterResult`. It returns a fresh `AcceptanceProofAdapterResult` for the same report path/artifact dir. There is exactly `const maxSchemaRepairAttempts = 1` per proof loop attempt. Command-proof invalid reports do not use repair; they remain blocked command proof results.
- **Concurrency / State Constraints:** One schema repair attempt must not increment implementation attempt counters. If the repair report is still invalid, the proof loop returns blocked evidence with a reason classified as non-retryable hard-block by `decideImplementationRework`. Reuse the same proof report path/artifact dir and collect the final change set once after proof/repair.
- **Forbidden Scope:** No prompt-only fix, no new schema library by default, no live smoke, no external publication mutation, no screenshot-only compatibility pass, no broad report schema redesign beyond fields already present, no new draft-report path.
- **Early Review Gate:** After Slice 2 (contract + CLI) run `$code-review` on `src/runner/acceptance-proof.ts`, `src/cli.ts`, and focused tests before prompt/loop repair changes. Continue only if no high-confidence source-of-truth or CLI contract findings remain.
- **Final Handoff Requirements:** Final response must include contract implemented, early review result, invariants proved, cleanup/code-review findings and fixes, validation commands, skipped checks, residual risks, and files by role.

## 3. Execution Slices

### Progress Discipline
- [x] Before Slice 1, re-read `docs/agents/execution-routing.md`, `docs/deep-dive.md`, `docs/adr/0001-runner-owned-loop-policy.md`, `docs/adr/0002-adaptive-acceptance-proof.md`, `.codex-orchestrator/config.json`, `package.json`, `tsconfig.json`, then run `git status --short`.
- [x] Update this checklist as work is completed.
- [x] Leave blocked work unchecked with a short `Blocked:` note. No blocked work remains.
- [x] Stop if repo reality contradicts a confirmed target, command, precondition, or scope boundary. No contradiction found.
- [x] Keep each implementation phase as a vertical tracer-bullet slice, not a horizontal layer pass.
- [x] For behavior changes, start each slice with a behavior-first test/proof before implementation work.
- [x] Update Contract Test Ledger status as each invariant moves planned -> red -> green or blocked.
- [x] Run required Review Checkpoints before continuing past risky slices.

### Slice 1 - Shape Contract Collector
- [x] Objective: `acceptance-proof.ts` exposes one public shape validator that reports every structural schema error without changing semantic proof evaluation.
- [x] Test/Proof First: Add RED `test/acceptance-proof.test.ts` coverage for multiple missing/invalid fields in one report and for `readAcceptanceProofReport` returning a combined invalid message.
- [x] Target: `src/runner/acceptance-proof.ts`
  - [x] Action: Add exported shape validation result/helpers, make `assertAcceptanceProofReport` throw a combined message from the same helper, and keep `evaluateAcceptanceProofReport` semantic checks unchanged.
  - [x] Validation: `npm run build --silent && node --test dist/test/acceptance-proof.test.js`.

### Slice 1 Exit Gate
- [x] `npm run build --silent && node --test dist/test/acceptance-proof.test.js`

### Slice 2 - CLI Self-Validation Surface
- [x] Objective: The package exposes local proof report shape validation through `codex-orchestrator acceptance-proof validate --report <path>`.
- [x] Test/Proof First: Add RED `test/cli.test.ts` for missing args, invalid report with multiple errors on stderr/stdout, and valid report exit 0.
- [x] Target: `src/cli.ts`
  - [x] Action: Add help text, command parsing, and command execution for `acceptance-proof validate --report <path>` using the helper from `acceptance-proof.ts`.
  - [x] Validation: `npm run build --silent && node --test dist/test/cli.test.js`.

### Slice 2 Exit Gate
- [x] `npm run build --silent && node --test dist/test/acceptance-proof.test.js dist/test/cli.test.js`
- [x] Early Review Gate: `$code-review` on `src/runner/acceptance-proof.ts`, `src/cli.ts`, `test/acceptance-proof.test.ts`, and `test/cli.test.ts`; focus on schema source-of-truth drift, shape-vs-semantic split, CLI exit behavior, and import boundaries. Result: no findings.

### Slice 3 - Generated Prompt Contract And Same-Report Validation Flow
- [x] Objective: Adaptive proof prompt gives agents a minimal valid report template and executable self-check instructions from the same contract owner.
- [x] Test/Proof First: Add RED assertions in `test/scoped-auto-command.test.ts` proving prompt includes required JSON template fields, the validate command, same-report instructions, and no hardcoded `Schema: { ... }` line.
- [x] Target: `src/runner/acceptance-proof.ts`
  - [x] Action: Export a minimal JSON template/rendering helper for prompt use. Required template fields: top-level `status`, `criteria`, `artifacts`, `proofPhaseDiff`, `residualRisks`; `criteria[]` includes `id`, `description`, `status`, `confidence`, `reasoningSummary`, `artifactRefs`.
  - [x] Validation: focused prompt test sees generated fields.
- [x] Target: `src/runner/acceptance-proof-runner.ts`
  - [x] Action: Replace hardcoded prose schema with generated template and instructions to write JSON to `CODEX_ORCHESTRATOR_PROOF_REPORT_PATH`, run `codex-orchestrator acceptance-proof validate --report "$CODEX_ORCHESTRATOR_PROOF_REPORT_PATH"`, fix all errors, then return exactly the validated JSON as final response.
  - [x] Validation: `npm run build --silent && node --test dist/test/scoped-auto-command.test.js`.

### Slice 3 Exit Gate
- [x] `npm run build --silent && node --test dist/test/scoped-auto-command.test.js dist/test/acceptance-proof.test.js dist/test/cli.test.js`

### Slice 4 - Adaptive Proof Schema Repair Routing
- [x] Objective: Malformed adaptive proof report shape is retried once inside proof report repair, while valid `needs-rework` still routes to implementation rework evidence.
- [x] Test/Proof First: Add RED `test/acceptance-proof-loop.test.ts` case where initial adaptive result writes `{"status":"passed"}`, `executeAdaptiveProofRepair` rewrites a valid report, and `runAcceptanceProofLoopAttempt` passes without exposing a full implementation rework blocker. Add RED repeated-invalid repair test proving terminal blocked reason is hard-block/non-retryable. Add/keep a test proving valid `needs-rework` returns `evidence.status === "needs-rework"` and `reworkRequest` unchanged.
- [x] Target: `src/runner/acceptance-proof-loop.ts`
  - [x] Action: Add `executeAdaptiveProofRepair?: (input: { reportPath: string; artifactDir: string; schemaErrors: string[]; previousResult: AcceptanceProofAdapterResult }) => Promise<AcceptanceProofAdapterResult>` to `RunAcceptanceProofLoopAttemptInput`. In `evaluateAdapterReport` or a nearby loop helper, when `readAcceptanceProofReport` returns invalid for adaptive proof, call the repair callback at most once, re-read the same report path, and then continue normal outcome assembly. If no callback exists or the repaired report is still invalid, return blocked proof-schema evidence.
  - [x] Validation: focused loop tests pass.
- [x] Target: `src/runner/acceptance-proof-runner.ts`
  - [x] Action: Add `repairSchemaErrors?: string[]` input to `runAcceptanceProofAdapter`; when present, build a repair prompt that includes previous shape errors, same report path, artifact dir, proof-owned path rules, and forbids product-code/GitHub changes.
  - [x] Validation: prompt/loop tests pass.
- [x] Target: `src/runner/local-execution-session.ts`
  - [x] Action: Wire `executeAdaptiveProofRepair` to `runAcceptanceProofAdapter({ repairSchemaErrors })` only when adaptive proof is available. Do not wire repair for command proof.
  - [x] Validation: scoped auto/local execution tests pass.
- [x] Target: `src/runner/rework-policy.ts`
  - [x] Action: Add an invalid-acceptance-proof-report classifier before generic `failed-acceptance-proof` and include it in `hardBlockerKeys`, so exhausted malformed proof schema does not schedule product implementation rework.
  - [x] Validation: loop/rework focused tests pass.

### Slice 4 Exit Gate
- [x] `npm run build --silent && node --test dist/test/acceptance-proof-loop.test.js dist/test/scoped-auto-command.test.js`

### Slice 5 - Docs And Final Review
- [x] Objective: Durable docs mention proof report shape/self-validation only where architecture readers need it.
- [x] Test/Proof First: Inspect whether `docs/deep-dive.md` needs a short update for `acceptance-proof validate`; skip docs if code/prompt already carry the contract and docs would duplicate schema.
- [x] Target: `docs/deep-dive.md` or none
  - [x] Action: Add one short paragraph only if needed; do not paste schema.
  - [x] Validation: docs-only diff inspection.

### Slice 5 Exit Gate
- [x] `npm run typecheck`
- [x] `npm test`
- [x] `git diff --check`
- [x] Cleanup-review and final code-review for the full diff. Result: no findings; cleanup-review performed inline because current multi-agent tool policy disallows spawning without explicit user delegation.

## 4. Validation And Done Criteria
- [x] **Lint/Format:** Not applicable; no lint script in `package.json`. Run `git diff --check`.
- [x] **Typecheck:** `npm run typecheck`.
- [x] **Tests:** Focused slice tests and final `npm test`.
- [x] **Architecture Check:** No dedicated architecture script configured; used docs preflight, early code-review, cleanup-review, final code-review.
- [x] **Live/Manual Validation:** Not applicable; do not run `npm run smoke:live` unless explicitly requested.
- [x] **Behavior Proof:** Contract Test Ledger rows green, prompt contains generated template and self-validation command, CLI validates valid/invalid reports, malformed adaptive proof shape repaired once in proof loop, repeated malformed shape hard-blocks without implementation retry, valid needs-rework still routes to implementation evidence.
- [x] **Final Reconciliation:** all implementation work is finished; no blocked items remain.
- [x] **Final Handoff Requirements:** Final response must include contract implemented, early review checkpoint, main invariants proved, review findings/fixes, validation, skipped checks, residual risks, and files by role.

## Write Scope Summary
- `src/runner/acceptance-proof.ts` - Update; shape contract, multi-error validation, prompt template helper; docs comments only if non-obvious.
- `src/cli.ts` - Update; `acceptance-proof validate --report` command and help.
- `src/runner/acceptance-proof-runner.ts` - Update; generated prompt contract and repair prompt mode.
- `src/runner/acceptance-proof-loop.ts` - Update; adaptive invalid schema proof repair routing.
- `src/runner/local-execution-session.ts` - Update; wire adaptive schema repair callback.
- `src/runner/rework-policy.ts` - Update; malformed proof schema hard-block classification.
- `test/acceptance-proof.test.ts` - Update; shape validation contract tests.
- `test/cli.test.ts` - Update; CLI validation tests.
- `test/scoped-auto-command.test.ts` - Update; prompt contract tests.
- `test/acceptance-proof-loop.test.ts` - Update; proof repair routing tests.
- `test/rework-policy.test.ts` or existing rework-policy coverage - Update only if needed for hard-block classification.
- `docs/deep-dive.md` - Optional minimal update; no schema duplication.

## Defect Closure Notes
- [x] First `implementation-spec-review` returned Needs Work because Slice 4 left repair topology, repair budget, and self-validation path ambiguous. This revision fixes that with a named `executeAdaptiveProofRepair` callback, exactly one schema repair attempt, `CODEX_ORCHESTRATOR_PROOF_REPORT_PATH` as the only self-validation path, adaptive-only repair, and hard-block classification for repeated malformed schema.

## 5. Final Action
Spec Status: Implemented
Saved Path: docs/implementation-specs/2026-07-06/1952-acceptance-proof-schema-contract-repair.md
Execution Model: Single-Agent
Review Verdict: Approved
Validation Gates: Local / Tests
Blockers: None
