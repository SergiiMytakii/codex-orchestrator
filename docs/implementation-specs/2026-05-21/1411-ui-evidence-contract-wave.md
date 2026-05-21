---
title: "UI Evidence Contract Wave"
created_at: "2026-05-21T14:11:00+03:00"
source_type: "wave"
source_plan: "None"
source_issues:
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/815"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/816"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/817"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/818"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/819"
status: "ready"
execution_model: "single-agent"
spec_mode: "compact"
review_verdict: "Approved"
---

## 1. Execution Context
- **Goal:** Make Acceptance Proof reject shallow UI artifacts unless the Proof Report carries a runner-validated UI Evidence Contract, then consume the same schema/failure vocabulary in prompt generation, visual-proof fallback removal, and rework handoff output.
- **Source Material:** Parent PRD #815; active wave #816, #817, #818, #819. #816 has no blockers and must land first. #817, #818, and #819 are blocked by #816. #820 and #821 are later-wave exit/follow-up gates only.
- **Approved Scope:** Add `uiEvidence` to the Acceptance Proof report contract/evaluator; define stable failure dimensions for workflow, viewport, freshness, layout, copy, and source-input evidence; update the Adaptive Proof Agent prompt/schema to emit the contract; remove screenshot/UI-dump-only pass behavior from runner-owned visual proof; surface validator dimensions as actionable rework/blocker reasons. Add focused tests for each active issue.
- **Out of Scope:** Do not implement #820 scoped runner regression suite except as an exit gate note. Do not implement #821 docs/bundled guidance except final notes if code changes require a prompt-schema reference. Do not build a visual diff engine, hardcode product-specific IntelliOutreach rules, require UI Evidence for pure non-visual proof, grant proof agents GitHub authority, allow proof-phase product-code fixes, run live smoke, or apply execution labels.
- **Simplest Viable Path:** Extend the existing Acceptance Proof report/evaluator in `src/runner/acceptance-proof.ts` as the only source of truth, then have prompt, visual proof, local publishability, and handoff paths reuse its report shape and `evaluation.reasons` without adding a second UI pass/fail layer.
- **Primary Risk:** Creating parallel UI proof vocabularies where the prompt, visual proof adapter, and handoff output drift from the runner validator.

## 2. Preconditions And Evidence
- **Required Services / Env / Fixtures:** No secrets or live services. Use synthetic proof reports and temp proof directories in Node tests. Do not read `.env` or `.env.*`.
- **Blocking Unknowns:** None.
- **Confirmed Targets:** `src/runner/acceptance-proof.ts`; `src/runner/visual-proof-runner.ts`; `src/runner/acceptance-proof-runner.ts`; `src/runner/review-gate-policy.ts`; `src/runner/local-execution-session.ts`; `src/runner/handoff-evidence.ts`; `prompts/workflows/acceptance-proof.md`; `test/acceptance-proof.test.ts`; `test/visual-proof-runner.test.ts`; `test/prompt-builder.test.ts`; `test/local-execution-session.test.ts`.
- **Confirmed Commands:** `npm run typecheck`; `npm test`. No dedicated lint or architecture-check script exists. Do not run `npm run smoke:live` unless explicitly requested because it mutates real GitHub issues/PRs.
- **Protected Paths / Rejected Approaches:** Never read/edit `.env` or `.env.*`. Do not add a product-specific validator, do not let `visualProof` become a weaker pass path, do not keep screenshot-only command success as passed, and do not downgrade proof-phase product-code edits to UI rework.
- **Architecture Lens:** Reuse the existing Acceptance Proof module as the deep module. `AcceptanceProofReport` and `evaluateAcceptanceProofReport` are the public test surface. Add only one small exported failure-dimension constant/type if needed so #817/#818/#819 can reuse the vocabulary; deletion test: if removing the helper causes duplicated strings across consumers, it is justified.
- **#817 Source Excerpt:** Prompt work must require task-specific UI checks; concrete source inputs from issue criteria, implementation evidence, reproduction signals, validation, or Manual QA Plan content; exact workflow scope, screen state, and entrypoint; viewport coverage including wide desktop for web layout and mobile only when issue/criteria call for it; current post-run artifact refs and freshness; layout findings; user-facing copy findings; real UI login preferred when configured credentials exist; explicit reason for session/cookie seeding; and no GitHub/publication/product-code repair authority.

## Canonical UI Evidence Contract
Add this exact optional field to `AcceptanceProofReport`; it is required when any report artifact has `type: "screenshot"` or `type: "ui-dump"`.

```ts
export type UiEvidenceFailureDimension = 'workflow' | 'viewport' | 'freshness' | 'layout' | 'copy' | 'source-input';

export interface AcceptanceProofUiEvidence {
  workflowScope: {
    entrypoint: string;
    path: string[];
    screenState: string;
    authPath?: 'real-login' | 'seeded-session' | 'not-required' | 'blocked';
    authShortcutReason?: string;
  };
  viewportCoverage: Array<{
    name: string;
    width: number;
    height: number;
    artifactRefs: string[];
    requiredBy: 'desktop-web-layout' | 'mobile-or-responsive' | 'issue-specific' | 'other';
  }>;
  artifactFreshness: {
    currentArtifactRefs: string[];
    checkedAfterFinalRun: boolean;
  };
  layoutReview: {
    checked: boolean;
    findings: Array<{ summary: string; artifactRefs: string[] }>;
  };
  copyReview: {
    checked: boolean;
    acceptedTerms?: string[];
    rejectedTermsAbsent?: string[];
    findings: Array<{ summary: string; artifactRefs: string[] }>;
  };
  sourceInputs: {
    acceptanceCriteriaRefs: string[];
    implementationEvidenceRefs: string[];
    reproductionSignalRefs?: string[];
    manualQaPlanRefs?: string[];
    runtimeValidationRefs?: string[];
  };
}
```

Contract rules:
- Every string is trimmed non-empty; every array above is required and non-empty unless marked optional.
- `width` and `height` are positive integers. For `requiredBy: "desktop-web-layout"`, `width >= 1280` and `height > 0` are required.
- Each `artifactRefs` and `currentArtifactRefs` entry must match an existing report artifact `path`, `url`, or `description` exactly, using the same artifact ref set already used for criteria validation.
- `layoutReview.checked` and `copyReview.checked` must be `true`; each review must have at least one finding for UI proof, and every finding must have at least one mapped artifact ref.
- `sourceInputs.acceptanceCriteriaRefs` and `sourceInputs.implementationEvidenceRefs` are required for UI proof; optional source arrays must be non-empty when present. Source inputs prove derivation only and cannot satisfy workflow, viewport, freshness, layout, or copy evidence by themselves.
- `authPath` and `authShortcutReason` are issue-derived from #817: real UI login is preferred when configured credentials exist; `seeded-session` requires `authShortcutReason`; `blocked` must correspond to report status `blocked` or `needs-rework`.
- Failure vocabulary is one public contract: `UiEvidenceFailureDimension`. `evaluateAcceptanceProofReport` must include each failing dimension in `reasons` as `UI Evidence <dimension>: <specific reason>.` #817, #818, and #819 must consume this dimension list and must not introduce different names.
- Parser/evaluator split: `assertAcceptanceProofReport` remains a transport/schema guard for the existing report plus `uiEvidence` object-ness only. If `uiEvidence` is present it must be a non-null object, not an array; otherwise the report is invalid. Missing or malformed nested UI evidence fields are evaluator failures, not parse failures, so they must return canonical `UI Evidence <dimension>:` reasons from `evaluateAcceptanceProofReport`. Only non-JSON, wrong top-level report shape, invalid top-level status, non-array criteria/artifacts/residualRisks, invalid artifact type, or non-object `uiEvidence` remain `readAcceptanceProofReport` invalid states.

## Contract Test Ledger
| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| Complete UI Evidence with screenshot/UI-dump artifacts, high-confidence criteria, existing artifacts, and no forbidden proof diff passes through `evaluateAcceptanceProofReport`. | Validator blocks valid UI proof or requires product-specific semantics. | Add `test/acceptance-proof.test.ts` test `acceptance proof accepts complete UI evidence contract for screenshot proof`; RED before implementation, GREEN after. | planned |
| Screenshot or UI-dump proof without `workflowScope` fails with `UI Evidence workflow:`. | Nearby/wrong screen passes as proof. | Add/replace `test/acceptance-proof.test.ts` test `acceptance proof rejects UI evidence missing workflow scope`; RED before implementation, GREEN after. | planned |
| UI proof without viewport coverage, positive dimensions, or artifact refs fails with `UI Evidence viewport:`; `desktop-web-layout` requires `width >= 1280`. | Mobile-only or unscoped viewport screenshots hide desktop layout defects. | Add `test/acceptance-proof.test.ts` test `acceptance proof rejects UI evidence missing viewport coverage`; RED before implementation, GREEN after. | planned |
| Missing/false current artifact freshness fails with `UI Evidence freshness:`. | Stale/intermediate screenshots are treated as final proof. | Add `test/acceptance-proof.test.ts` test `acceptance proof rejects UI evidence missing current artifact freshness`; RED before implementation, GREEN after. | planned |
| Layout review must be checked and findings must map to artifact refs, otherwise `UI Evidence layout:` fails. | Generic geometry text or unmapped findings pass without proving spacing/overlap/clipping/alignment. | Add `test/acceptance-proof.test.ts` test `acceptance proof rejects UI evidence with unmapped layout findings`; RED before implementation, GREEN after. | planned |
| Copy review must be checked and findings/rejected terms must map to user-facing copy evidence, otherwise `UI Evidence copy:` fails. | Technical/rejected copy silently returns. | Add `test/acceptance-proof.test.ts` test `acceptance proof rejects UI evidence with unmapped copy review`; RED before implementation, GREEN after. | planned |
| Source inputs are required for UI proof and cannot replace workflow/viewport/freshness/layout/copy evidence, otherwise `UI Evidence source-input:` fails. | Prompt cites issue text while skipping actual artifact mapping. | Add `test/acceptance-proof.test.ts` test `acceptance proof rejects UI evidence missing source inputs`; RED before implementation, GREEN after. | planned |
| Non-visual smoke-output-only proof remains valid without `uiEvidence`. | Contract accidentally forces UI schema onto API/CLI/smoke proof. | Keep existing `acceptance proof passes only with high-confidence criterion artifacts and no product diff` passing; add explicit smoke-output assertion if needed. | planned |
| Visual proof command success with screenshots/UI dumps but no valid `acceptance-proof-report.json` fails/blocks. | Screenshot-only fallback remains a pass path. | Add `test/visual-proof-runner.test.ts` test `runner visual proof fails screenshot-only output without acceptance proof report`; RED before implementation, GREEN after. | planned |
| Visual proof valid report path delegates to the canonical validator and returns `UI Evidence <dimension>:` reasons. | Visual proof owns separate rules or masks validator reasons. | Add `test/visual-proof-runner.test.ts` test `runner visual proof reports canonical UI evidence failure dimensions`; RED before implementation, GREEN after. | planned |
| Adaptive Proof Agent prompt/schema requires workflow, viewport, freshness, layout, copy, sourceInputs, real-login preference, seeded-session reason, and no GitHub/product-code authority. | Agent emits generic screenshot reasoning or treats proof as implementation. | Add `test/prompt-builder.test.ts` prompt test for generated acceptance proof prompt and update existing prompt text checks; RED before implementation, GREEN after. | planned |
| Failed UI Evidence validation blocks Draft PR Handoff and preserves report path, artifact dir, validator reasons, and residual risks. | Handoff hides actionable missing dimensions behind generic proof failure. | Add `test/local-execution-session.test.ts` test `publishability blocks UI evidence failure with canonical proof reasons`; assert `buildChildBlockedReport`/`renderAcceptanceProofEvidence` output if needed. | planned |

## 3. Execution Slices

### Progress Discipline
- [ ] Update this checklist as work is completed.
- [ ] Leave blocked work unchecked with a short `Blocked:` note.
- [ ] Stop if repo reality contradicts a confirmed target, command, precondition, or scope boundary.
- [ ] Keep each implementation phase as a vertical tracer-bullet slice, not a horizontal layer pass.
- [ ] Start each behavior-changing slice with a behavior-first RED test/proof.
- [ ] Keep #816 first; do not start #817/#818/#819 implementation until #816 exposes `AcceptanceProofUiEvidence` and `UiEvidenceFailureDimension`.
- [ ] Update the Contract Test Ledger status as each invariant moves planned -> red -> green or blocked.

### Slice 1 - #816 Canonical UI Evidence Validator
- [ ] Objective: Runner evaluation accepts complete UI Evidence and rejects shallow screenshot/UI-dump proof with stable dimensions.
- [ ] Test/Proof First: Add the #816 tests listed in the Contract Test Ledger to `test/acceptance-proof.test.ts`; prove at least the missing-workflow test fails before implementation.
- [ ] Target: `src/runner/acceptance-proof.ts`
  - [ ] Action: Add `AcceptanceProofUiEvidence` and `UiEvidenceFailureDimension` exactly as specified above; add `uiEvidence?: AcceptanceProofUiEvidence` to `AcceptanceProofReport`.
  - [ ] Action: Extend `assertAcceptanceProofReport` only with the parser/evaluator split above: `uiEvidence` may be absent; when present, it must be a non-null object and semantic UI validation remains in `evaluateAcceptanceProofReport`.
  - [ ] Action: In `evaluateAcceptanceProofReport`, require `uiEvidence` when report artifacts include `type: "screenshot"` or `type: "ui-dump"`; append `UI Evidence <dimension>:` reasons for each missing/invalid group.
  - [ ] Action: Validate all artifact mapping against the existing report artifact ref set.
  - [ ] Validation: Run `npm test` after the RED test is added and again after the implementation is green; run `npm run typecheck` after TypeScript changes.
- [ ] Slice Exit Gate: Non-visual smoke-output-only proof still passes without `uiEvidence`; all #816 failure dimensions are available for later slices without duplicating vocabulary.

### Slice 2 - #817 Adaptive Proof Prompt Emits Same Contract
- [ ] Objective: The proof agent prompt asks for task-derived UI evidence using the canonical schema but does not own pass/fail authority.
- [ ] Test/Proof First: Add a `test/prompt-builder.test.ts` test that fails until the generated acceptance proof prompt includes the canonical fields and #817-derived auth guidance.
- [ ] Target: `src/runner/acceptance-proof-runner.ts`
  - [ ] Action: Update the `buildAcceptanceProofPrompt` schema string to include the exact `AcceptanceProofUiEvidence` shape accepted by `src/runner/acceptance-proof.ts`.
  - [ ] Action: Derived from #817, require task-specific UI checks from issue acceptance criteria, implementation evidence, reproduction signals, validation sections, Manual QA Plan content when present, and runtime/media artifacts.
  - [ ] Action: Derived from #817, state that wide desktop coverage is required for web layout proof; mobile is required only when issue/criteria call for mobile or responsive behavior.
  - [ ] Action: Derived from #817, state that configured credentials should drive real UI login when available and that session/cookie seeding requires `authPath: "seeded-session"` plus `authShortcutReason`.
- [ ] Target: `prompts/workflows/acceptance-proof.md` and `src/runner/review-gate-policy.ts`
  - [ ] Action: Keep bundled workflow and child prompt guidance aligned with runner-owned schema and authority; do not document a separate visual-proof pass rule.
  - [ ] Validation: Run `npm test` after prompt tests go RED and GREEN; run `npm run typecheck` if TypeScript prompt code changes.
- [ ] Slice Exit Gate: Prompt tests prove #817 consumes `AcceptanceProofUiEvidence`/`UiEvidenceFailureDimension` and still forbids product-code edits/GitHub publication by the proof agent.

### Slice 3 - #818 Remove Screenshot-Only Visual Proof Pass Path
- [ ] Objective: Runner-owned visual proof succeeds only through a valid Acceptance Proof report evaluated by the canonical validator.
- [ ] Test/Proof First: Add `test/visual-proof-runner.test.ts` tests for screenshot-only output with missing report, invalid report, valid complete UI report, and legacy `reviewGates.visualProof` config delegation; prove the screenshot-only missing-report test fails before implementation.
- [ ] Target: `src/runner/visual-proof-runner.ts`
  - [ ] Action: Remove the final screenshot-count `status: "passed"` branch when `readAcceptanceProofReport` is missing. A successful command with screenshots but no valid report must return `failed` for Acceptance Proof, preserving produced artifacts only as evidence.
  - [ ] Action: Keep command/env/artifact-dir migration inputs from `runnerVisualProofPolicy`, including legacy `reviewGates.visualProof` command, timeout, artifact dir, and env passthrough, but treat them only as inputs to report-producing proof.
  - [ ] Action: When a valid report exists, continue evaluating with `evaluateAcceptanceProofReport` and include canonical `UI Evidence <dimension>:` reasons in validation summary.
- [ ] Target: `src/runner/review-gate-policy.ts`
  - [ ] Action: If `blockOnMissingProof` still exists after the implementation, make it impossible for screenshot-only success to pass Acceptance Proof; otherwise remove/simplify it with tests proving legacy config still delegates inputs.
  - [ ] Validation: Run `npm test` after visual-proof tests go RED and GREEN; run `npm run typecheck` after TypeScript changes.
- [ ] Slice Exit Gate: No code path in `runRunnerVisualProof` marks screenshot/UI-dump artifact presence alone as passed.

### Slice 4 - #819 Surface Canonical Failure Dimensions As Rework/Blocker Evidence
- [ ] Objective: UI Evidence failures reach publishability and blocked/handoff evidence as actionable workflow/viewport/freshness/layout/copy/source-input reasons.
- [ ] Test/Proof First: Add `test/local-execution-session.test.ts` or focused handoff tests proving failed UI Evidence validation blocks Draft PR Handoff and preserves proof report path, artifact directory, validator reasons, residual risks, and product-code proof diffs as separate blockers.
- [ ] Target: `src/runner/local-execution-session.ts`
  - [ ] Action: Confirm failed runner visual/adaptive proof validation remains a publication blocker before review-ready handoff; adjust only if current generic failure wrapping hides canonical reasons.
- [ ] Target: `src/runner/acceptance-proof-runner.ts`
  - [ ] Action: Ensure adaptive proof validation summaries preserve `evaluation.reasons` with `UI Evidence <dimension>:` text intact for #819 output.
- [ ] Target: `src/runner/handoff-evidence.ts`
  - [ ] Action: If current `renderAcceptanceProofEvidence` omits useful `reworkRequest` or residual risks needed by #819, add concise output while preserving prompt path, report path, artifact dir, validation, and blockers.
  - [ ] Validation: Run `npm test` after blocker/handoff tests go RED and GREEN; run `npm run typecheck` after TypeScript changes.
- [ ] Slice Exit Gate: Product-code edits during proof still produce the existing product-code blocker and are not relabeled as UI Evidence rework.

### Slice 5 - Wave Exit Gates For #820/#821
- [ ] Objective: Leave later waves clear without implementing them in this spec.
- [ ] Test/Proof First: Not applicable; this is reconciliation only.
- [ ] Target: issue/wave handoff notes only
  - [ ] Action: Record that #820 should add scoped runner regressions after #816-#819 land, using public runner/session behavior; do not fold #820 into this wave unless implementation discovers a missing final regression that is required to prove #816-#819.
  - [ ] Action: Record that #821 should update README/Deep Dive/bundled guidance after #820 or after implemented behavior stabilizes; docs must describe implemented behavior only.
- [ ] Slice Exit Gate: Active implementation remains limited to #816-#819.

## 4. Validation And Done Criteria
- [ ] **Lint/Format:** No dedicated lint script; run `git diff --check` before handoff.
- [ ] **Typecheck:** `npm run typecheck`.
- [ ] **Tests:** `npm test` after slice-focused RED/GREEN work passes.
- [ ] **Architecture Check:** No dedicated architecture-check script is configured; apply the quality preflight from `docs/agents/execution-routing.md` and report that no architecture-check command exists.
- [ ] **Live/Manual Validation:** Not applicable. Do not run `npm run smoke:live` unless the maintainer explicitly requests live GitHub-mutating smoke.
- [ ] **Behavior Proof:** Contract ledger rows are green or explicitly blocked; public evaluator/runner/publishability tests show shallow UI proof blocks and complete UI Evidence passes.
- [ ] **Final Reconciliation:** all unchecked work is unfinished, blocked with a note, or intentionally not applicable.

## Execution Ledger
- [x] Slice 1 #816: canonical UI Evidence Contract added to `src/runner/acceptance-proof.ts` and covered through public evaluator tests.
- [x] Slice 2 #817: Adaptive Proof Agent prompt/schema and bundled guidance now require task-derived `uiEvidence`.
- [x] Slice 3 #818: runner-owned visual proof no longer passes screenshot-only output without a valid Proof Report.
- [x] Slice 4 #819: scoped runner handoff blocks shallow UI Evidence with canonical `UI Evidence <dimension>:` reasons.
- [x] Slice 5 #820/#821 reconciliation: scoped regression and implemented-behavior docs were updated in this wave.

## Defect Closure Notes
- [ ] First review defect fixed: `Canonical UI Evidence Contract` now defines exact field names, types, required/optional cardinality, artifact ref mapping, source input semantics, and auth shortcut semantics.
- [ ] First review defect fixed: failure vocabulary is one public `UiEvidenceFailureDimension` contract and `UI Evidence <dimension>:` reason format.
- [ ] First review defect fixed: slice validation now uses only confirmed repo commands `npm test` and `npm run typecheck`.
- [ ] First review defect fixed: #817 auth/login/seeding prompt requirements are explicitly issue-derived.
- [ ] Second review defect fixed: parser-invalid report states are separated from evaluator-invalid UI Evidence dimensions.
- [ ] Second review defect fixed: `desktop-web-layout` viewport threshold is `width >= 1280`.
- [ ] Second review defect fixed: #817 source requirements are embedded in this spec.
- [ ] Final narrow review verdict: Approved; no remaining blockers.

## 5. Final Action
After saving the file, respond in chat with exactly:

Spec Status: Ready
Saved Path: docs/implementation-specs/2026-05-21/1411-ui-evidence-contract-wave.md
Execution Model: Single-Agent
Review Verdict: Approved
Validation Gates: Local Tests
Blockers: None
