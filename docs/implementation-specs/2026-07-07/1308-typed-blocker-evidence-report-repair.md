---
title: "Typed blockers and bounded report/evidence repair"
created_at: "2026-07-07T13:08:00+03:00"
source_type: "plan"
source_plan: "/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-07/1252-typed-blocker-evidence-report-repair.md"
source_issues:
  - "None"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_verdict: "Approved"
---

## 1. Execution Context
- **Goal:** Replace regex-fragile implementation rework classification with typed runner blockers and add bounded report-only/evidence-only repair for safe scoped and tree-child implementation attempts before terminal blocking.
- **Source Material:** Reviewed plan `docs/plans/2026-07-07/1252-typed-blocker-evidence-report-repair.md`; prior completed spec `docs/implementation-specs/2026-07-07/1220-incomplete-agent-progress-retry.md` is existing behavior to preserve, not scope to redo.
- **Approved Scope:** Runner publishability, rework decision input, scoped completion-report read/repair support, review-gate typed evidence, repair prompts/session wiring, durable summary/handoff evidence for repair attempts, tests, and docs for typed blockers and repair-only behavior.
- **Out of Scope:** Weakening deny/scope/publication/acceptance-proof gates; broad stale recovery redesign; plan-auto parent planning repair; live smoke by default; release/version files; downstream repos; transcript scraping; making unknown failures retryable; Agent/repair GitHub mutation.
- **Simplest Viable Path:** Add a `RunnerBlocker` typed contract in `src/runner/rework-policy.ts`, emit blockers where publishability/review gates create failures, make `decideImplementationRework()` prefer typed blockers while preserving reason-string compatibility, then add exactly one report repair and one evidence repair path inside `runImplementationPublishabilityCheck()` using the existing Codex adapter/session-home pattern.
- **Primary Risk:** Accidentally converting safety/policy violations or unknown failures into repairable/retryable work, allowing publication without the normal gates proving the repaired evidence.

## 2. Preconditions And Evidence
- **Required Services / Env / Fixtures:** None beyond local repo. Do not run `npm run smoke:live` unless explicitly requested.
- **Blocking Unknowns:** None.
- **Confirmed Targets:** `src/runner/rework-policy.ts` (`ReworkBlockerKey`, blocker regexes, `decideImplementationRework`); `src/runner/local-execution-session.ts` (`runImplementationPublishabilityCheck`, `ImplementationPublishabilityInput`, blocked result construction, acceptance proof/check/review-gate ordering); `src/runner/completion-report.ts` (`readScopedCompletionReport`, scoped schema assertions); `src/runner/review-gates.ts` (`evaluateReviewGates`, quality/risk routing reasons); `src/runner/agent-attempt.ts` (passes publishability result into rework decision); `src/runner/prompt.ts` (completion report schema and rework prompt wording); `src/runner/durable-run-summary.ts`, `src/runner/runner-handoff-decision.ts`, `src/runner/handoff-evidence.ts` (visible handoff evidence); tests in `test/rework-policy.test.ts`, `test/local-execution-session.test.ts`, `test/scoped-auto-command.test.ts`, `test/completion-report.test.ts`, `test/review-gates.test.ts`; docs `docs/deep-dive.md`, maybe `README.md` if user-facing behavior changes.
- **Confirmed Commands:** `npm run typecheck`; `npm test`; focused built tests via `npm run build && node --test dist/test/<file>.test.js`; `git diff --check`. No lint or architecture script exists.
- **Protected Paths / Rejected Approaches:** Do not read/edit `.env` or `.env.*`. Do not edit package version, `CHANGELOG.md`, release workflow, downstream repos, or unrelated `.codex-orchestrator/local/self-improvement/*`. Do not add broad `exitCode 124` retry, transcript scraping, product-code repair mutation, or GitHub mutation from repair sessions. Do not replace acceptance proof repair with completion report repair.
- **Architecture Lens:** New deep contract is `RunnerBlocker` in `rework-policy.ts`, not a new adapter subsystem. Deletion test: deleting it returns policy to string regex drift and makes repair prompts/durable summaries inconsistent. Tests must use public seams: `decideImplementationRework()`, `runImplementationPublishabilityCheck()`, `runAgentAttemptLoop`/scoped command behavior, `readScopedCompletionReport*`, and `evaluateReviewGates()`.

## Contract Test Ledger

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| Typed blockers drive rework decisions without reason regex; legacy reason-string callers still work. | A wording change silently turns retryable blockers into `unknown` or retries the wrong blocker. | Add RED tests in `test/rework-policy.test.ts` for typed `missing-quality-gate-evidence`, `failed-configured-checks`, `incomplete-after-progress`, `denied-path`, and unknown legacy reason fallback. | green |
| Hard safety blockers always override repair/retry. | Denied paths, publication violations, destructive/prod actions, required Figma, scope blockers, or forbidden proof diffs get sent to repair. | Add RED tests in `test/rework-policy.test.ts` and `test/local-execution-session.test.ts` proving mixed hard+repairable blockers hard-block. | green |
| Completion report repair runs at most once per Agent attempt and only after safe changed files are proven. | Missing/invalid report loops indefinitely or repairs unsafe/no-op work. | Add RED tests in `test/local-execution-session.test.ts` for missing report safe repair success, invalid report repair success, no changed files no repair, denied/scope/publication no repair, repair failure terminal blocked. | green |
| Report/evidence repair cannot change product files, including files already changed before repair. | Repair session silently edits implementation code while changed paths stay the same, bypassing implementation rework. | Add RED test in `test/local-execution-session.test.ts` where repair Codex mutates an already-changed `src/feature.ts`; publishability blocks with repair mutation blocker and no PR-ready result. | green |
| Repair path cannot create local commits. | Repair session changes `HEAD`, hiding product mutation or publication boundary violation. | Add RED test in `test/local-execution-session.test.ts` where repair creates a local commit; publishability terminal-blocks even if report JSON is valid. | green |
| Evidence repair reruns normal gates and cannot publish by assertion alone. | Repair report claims code-review/TDD/reviewHandoff but configured checks or acceptance proof/review gates are skipped. | Add RED scoped or local execution test proving repair output is re-read and configured checks/review gates run again before publish-ready. | green |
| Repair artifact paths are deterministic and do not create ambiguous worktree writes. | Executor chooses ad hoc prompt/log paths or broad state-dir exceptions that hide mutations. | Add RED test or assertion proving repair session id suffix, prompt path, log path, isolated home path, original report path, and exact report-path-only exception when reportPath is inside worktree. | green |
| Existing `incomplete-after-progress` contract remains unchanged. | New blocker taxonomy regresses completed idle-timeout safe-progress retry behavior. | Existing tests from `test/rework-policy.test.ts`, `test/local-execution-session.test.ts`, `test/scoped-auto-command.test.ts` must stay green; add a regression if typed path bypasses the sentinel. | green |
| Durable handoff exposes blocker keys and repair attempts without replacing human-readable reasons. | Maintainers lose the reason/evidence needed to diagnose repaired or exhausted runs. | Add RED assertions in `test/scoped-auto-command.test.ts` or durable summary tests for repair attempt evidence and final blocked/review-ready comments. | green |

## Risk Controls
- **Source of Truth:** `src/runner/rework-policy.ts` owns `RunnerBlocker`, repairability, hard-block precedence, max-attempt decision mapping, and legacy reason fallback. `src/runner/completion-report.ts` owns report schema/validation errors. `src/runner/review-gates.ts` owns review-gate findings.
- **Safety Constraints:** Existing publication, deny path, scope isolation, prohibited action, acceptance proof, and configured-check gates must still run after repair. Repair sessions must not mutate product files or GitHub state. Repair safety must use content stability, not changed-path stability alone: before repair capture `preRepairHead = git.getHead(worktreePath)` and a deterministic protected diff/fingerprint for all worktree changes from `beforeHead`, excluding only the exact `reportPath` if implementation discovers it is inside `worktreePath`; after repair capture the same values and block if `postRepairHead !== preRepairHead` or the protected diff/fingerprint differs. Sorted changed paths may be compared as extra evidence, but patch/fingerprint equality is mandatory because the same changed path can have different content.
- **Contract Constraints:** Preserve existing exported constants and behavior for `MISSING_COMPLETION_REPORT_REASON`, `INCOMPLETE_AFTER_PROGRESS_REASON`, optional/required Figma blockers, invalid acceptance proof hard-blocks, and `loopPolicy.rework.retryableBlockers`. `ImplementationPublishabilityResult` may add optional `blockers` and `repairAttempts`, but existing `reasons` must remain for comments/tests/backward compatibility.
- **Concurrency / State Constraints:** Max one completion-report repair and max one evidence repair per publishability check. Repair runs serially in the same worktree and cannot run concurrently with implementation or acceptance proof. State summaries must identify prompt/report/log paths for repair sessions when available.
- **Forbidden Scope:** No generic recovery framework; no plan-auto parent repair; no config migration unless a test proves it is required; no live smoke by default; no compatibility branch for old report schemas beyond preserving the existing optional `artifacts` default.
- **Early Review Gate:** After Slice 2, run `$code-review` focused on report repair eligibility, hard-block precedence, allowed write set, product mutation detection, `getHead`/diff stability, repair report overwrite semantics, and rerunning publishability gates. Continue only after high-confidence findings are fixed or the spec is marked blocked.
- **Final Handoff Requirements:** Executor final response must include contract implemented, high-risk checkpoint result, ledger invariants proved, code-review/cleanup-review findings and fixes, validation commands, skipped checks, residual risks, and files by role.

## Write Scope Summary
- `src/runner/rework-policy.ts` - Update; typed blocker contract and rework decision compatibility.
- `src/runner/local-execution-session.ts` - Update; repair orchestration, deterministic repair paths, content-based repair mutation guard, and publishability re-entry.
- `src/runner/completion-report.ts` - Update; structured invalid report read/validation errors for repair.
- `src/runner/review-gates.ts` and possibly `src/runner/review-gate-policy.ts` - Update; typed review gate blocker metadata without changing pass/fail semantics.
- `src/runner/agent-attempt.ts` - Update only as needed to pass typed blockers/repair evidence to summaries/rework decisions.
- `src/runner/prompt.ts` - Update only as needed for repair-only prompt builders or rework wording.
- `src/runner/durable-run-summary.ts`, `src/runner/runner-handoff-decision.ts`, `src/runner/handoff-evidence.ts` - Update only if tests prove repair/blocker evidence is missing from visible output.
- `test/rework-policy.test.ts`, `test/local-execution-session.test.ts`, `test/scoped-auto-command.test.ts`, `test/completion-report.test.ts`, `test/review-gates.test.ts` - Update/add behavior-first coverage.
- `docs/deep-dive.md` and maybe `README.md` - Update docs after behavior is green.

## 3. Execution Slices

### Progress Discipline
- [x] Update this checklist as work is completed.
- [x] Leave blocked work unchecked with a short `Blocked:` note.
- [x] Stop if repo reality contradicts a confirmed target, command, precondition, or scope boundary.
- [x] Keep each implementation phase as a vertical tracer-bullet slice, not a horizontal layer pass.
- [x] Start each behavior-changing slice with the named RED test/proof before implementation work.
- [x] Update the Contract Test Ledger status as each invariant moves planned -> red -> green or blocked.
- [x] Run the early `$code-review` checkpoint after Slice 2 before implementing evidence repair.

### Slice 1 - Typed Blocker Contract
- [x] Objective: Make rework decisions consume typed runner blockers while preserving all current reason-string behavior.
- [x] Test/Proof First: Add RED tests in `test/rework-policy.test.ts` for `decideImplementationRework({ blockers, reasons, config, attempt })` covering retryable typed quality/check/incomplete blockers, hard typed blockers, hard-overrides-retryable mixed blockers, unknown legacy fallback, acceptance proof iteration budget, and existing raw idle timeout non-retry behavior.
- [x] Target: `src/runner/rework-policy.ts`
  - [x] Action: Add exported `RunnerBlocker` type with at least `{ key: ReworkBlockerKey; reason: string; source: 'publishability' | 'completion-report' | 'configured-check' | 'review-gate' | 'acceptance-proof' | 'safety' | 'codex' | 'recovery'; repair?: 'implementation-rework' | 'completion-report' | 'evidence' | 'none' }`.
  - [x] Action: Change `ReworkDecisionInput` to accept `blockers?: RunnerBlocker[]` while keeping `reasons: string[]` required for compatibility.
  - [x] Action: Add `blockersFromReasons(reasons: string[]): RunnerBlocker[]` as the only legacy regex adapter; keep current pattern behavior there.
  - [x] Action: Make `decideImplementationRework()` derive keys from `input.blockers ?? blockersFromReasons(input.reasons)`, preserve returned `blockerKeys`, `reasons`, and `disableOptionalFigmaMcp` behavior.
  - [x] Action: Do not change `RetryableReworkBlocker` config schema in this slice.
  - [x] Validation: RED tests become GREEN and existing `incomplete-after-progress` tests still pass.

### Slice Exit Gate
- [x] `npm run build && node --test dist/test/rework-policy.test.js`

### Slice 2 - Completion Report Repair
- [x] Objective: Repair missing/invalid scoped completion reports once when implementation changed safe files, without allowing repair to change product code or bypass normal gates.
- [x] Test/Proof First: Add RED tests in `test/completion-report.test.ts` for structured invalid report result, then `test/local-execution-session.test.ts` for safe missing report repair success, invalid JSON repair success, no changed files no repair, denied path no repair, scope blocker no repair, publication violation no repair, repair Codex failure terminal block, repair mutating an already-changed product file terminal block, and repair creating a local commit terminal block.
- [x] Target: `src/runner/completion-report.ts`
  - [x] Action: Add `readScopedCompletionReportDetailed(reportPath)` returning `{ kind: 'missing' } | { kind: 'invalid'; message: string; errors: string[]; rawContent?: string } | { kind: 'valid'; report }`.
  - [x] Action: Keep `readScopedCompletionReport(reportPath)` existing behavior by delegating to detailed read and throwing on `invalid`, so existing callers/tests remain compatible.
  - [x] Action: Bound `rawContent` included for repair to a deterministic truncation limit such as 8000 characters.
- [x] Target: `src/runner/local-execution-session.ts`
  - [x] Action: Extend `ImplementationPublishabilityInput.git` for repair paths to include `getHead`; if `getHead` is unavailable, report/evidence repair is not eligible and the original blocker remains terminal for that attempt.
  - [x] Action: Extend `ImplementationPublishabilityInput` with optional `reportRepair?: { targetRoot: string; sessionId: string; branchName: string; workflowPromptText: string; codexAdapter: { run(input: CodexCommandRunInput): Promise<CodexCommandRunResult> } }`.
  - [x] Action: Add deterministic repair session paths: `repairSessionId = `${sessionId}-completion-report-repair``, `repairPromptPath = sessionPromptPath({ targetRoot, config, issueNumber: issue.number, sessionId: repairSessionId })`, `repairLogPath = sessionLogPath({ targetRoot, config, issueNumber: issue.number, sessionId: repairSessionId })`, and `repairHomePath = sessionCodexHomePath({ targetRoot, sessionId: repairSessionId })`. The repair output path is the original implementation `reportPath`.
  - [x] Action: Add private helper `runCompletionReportRepair(...)` using `sessionCodexHomePath`, `cleanupSessionCodexHome`, `sessionPromptPath`, and `sessionLogPath`; pass the original `reportPath` as the Codex output path so the repair final JSON overwrites/creates the original scoped report.
  - [x] Action: Repair prompt must state: repair only the completion report JSON at `CODEX_ORCHESTRATOR_REPORT_FILE`; do not edit product files; do not edit GitHub; use changed files, issue text, schema errors/raw content, and validation/check evidence; final response raw JSON only.
  - [x] Action: Before repair, collect change set and validate non-empty changed files, deny paths, and scope isolation. Do not repair no-op, denied, out-of-scope, publication-violating, destructive/prohibited, or unknown Codex exits.
  - [x] Action: Before repair, capture `preRepairHead = git.getHead(worktreePath)` and `preRepairProtectedDiff` as a deterministic patch/fingerprint for the full worktree diff from `beforeHead`. Direct implementation may add a private helper in `local-execution-session.ts` such as `captureRepairProtectedDiff()` using existing git/shell seams; do not create a new module unless tests prove local helper duplication is worse. If `reportPath` is inside `worktreePath`, exclude only that exact normalized report path from the protected diff and add a focused test for that case; do not exclude broad state directories.
  - [x] Action: After repair, capture `postRepairHead` and `postRepairProtectedDiff`. Block repair if `postRepairHead !== preRepairHead` or protected diffs differ, even when `changedPaths` are identical.
  - [x] Action: Re-read the repaired report through normal detailed/strict path, then continue through the existing publishability pipeline: local phases, changedFiles, safety, configured checks, acceptance proof, failed validation, review gates, commitAll.
  - [x] Action: Emit typed blockers for missing/invalid report and repair failure; preserve human-readable reasons.
  - [x] Validation: RED tests become GREEN.

### Slice Exit Gate
- [x] `npm run build && node --test dist/test/completion-report.test.js dist/test/local-execution-session.test.js`

### Review Checkpoint
- [x] Run `$code-review` on Slice 1-2 diff before continuing. Review Focus: report repair eligibility, hard-block precedence, allowed write set, content-based product mutation detection, local commit blocking, exact reportPath exception, rerun publishability gates, and no regression of typed blocker compatibility. Continue only if no high-confidence findings remain.

### Slice 3 - Review/Evidence Repair
- [x] Objective: Repair missing reviewHandoff/TDD/code-review/cleanup-review evidence once when product work is otherwise safe, then rerun normal review gates.
- [x] Test/Proof First: Add RED tests in `test/review-gates.test.ts` for typed findings from missing reviewHandoff and missing quality evidence without changing current `reasons` strings. Add RED tests in `test/local-execution-session.test.ts` or `test/scoped-auto-command.test.ts` proving evidence repair prompt runs once, writes corrected report validation/reviewHandoff, cannot mutate an already-changed product file, cannot create a local commit, and publishability reruns configured checks/review gates before review-ready.
- [x] Target: `src/runner/review-gates.ts`
  - [x] Action: Add `findings` or `blockers` metadata to `ReviewGateResult`, preserving `ok`, `reasons`, and `warnings`.
  - [x] Action: Map quality gate failures to typed blockers: missing TDD/test-change -> `missing-quality-gate-evidence`; missing cleanup/code review -> `missing-quality-gate-evidence`; scoped risk routing block -> `risk-routing-policy` with source `review-gate`; visual proof strict failures remain existing acceptance/visual blocker semantics and are not evidence-repairable unless already represented by acceptance proof rework.
  - [x] Action: Keep WARN mode warnings non-blocking.
- [x] Target: `src/runner/local-execution-session.ts`
  - [x] Action: Reuse repair helper shape from Slice 2 as `runEvidenceReportRepair(...)` or a generic private repair helper with mode `completion-report | evidence` only if it removes duplication without hiding behavior.
  - [x] Action: Evidence repair uses deterministic paths: `repairSessionId = `${sessionId}-evidence-repair``, `sessionPromptPath(...)`, `sessionLogPath(...)`, `sessionCodexHomePath(...)`, and the original implementation `reportPath` as repair output.
  - [x] Action: Evidence repair is eligible only after changed files, safety, configured checks, and acceptance proof have run without hard blockers, and `evaluateReviewGates()` returns repairable evidence blockers.
  - [x] Action: Repair prompt must forbid product file changes and ask only for corrected completion report JSON evidence fields. It may ask the Agent to run read-only review commands/skills if needed, but final publication still depends on rerun gates.
  - [x] Action: Reuse the content-based protected diff/HEAD guard from Slice 2 before and after evidence repair. Block if protected diff changes or HEAD changes.
  - [x] Action: After repair, re-read report, rerun applicable skipped checks normalization and `evaluateReviewGates()`. Do not skip configured checks or acceptance proof results already required by pipeline.
  - [x] Action: If evidence repair returns the same blocker, invalid report, missing report, mutates product files, or creates a local commit, terminal block with typed blocker evidence.
  - [x] Validation: RED tests become GREEN.

### Slice Exit Gate
- [x] `npm run build && node --test dist/test/review-gates.test.js dist/test/local-execution-session.test.js dist/test/scoped-auto-command.test.js`

### Slice 4 - Durable Evidence, Docs, And Final Validation
- [x] Objective: Make repaired/exhausted outcomes explainable to maintainers and document the new contract.
- [x] Test/Proof First: Add RED assertions in `test/scoped-auto-command.test.ts` or durable summary tests that final blocked/review-ready handoff includes repair attempt count/type, blocker keys, prompt/report/log paths when available, and original human-readable reasons.
- [x] Target: `src/runner/agent-attempt.ts`
  - [x] Action: Pass `publishability.blockers` to `decideImplementationRework()` and preserve `publishability.repairAttempts` in `reworkAttempts` or adjacent durable evidence if tests show it is otherwise lost.
- [x] Target: `src/runner/durable-run-summary.ts`, `src/runner/runner-handoff-decision.ts`, `src/runner/handoff-evidence.ts`
  - [x] Action: Surface repair attempts and blocker keys in a compact way without replacing existing `reasons`, `validation`, `skippedChecks`, or `residualRisks`.
- [x] Target: `docs/deep-dive.md`
  - [x] Action: Document typed blockers, legacy reason fallback, one report repair and one evidence repair per publishability check, hard-block safety boundaries, content-based repair mutation guard, and that repair never publishes or bypasses gates.
- [x] Target: `README.md`
  - [x] Action: Update only if new behavior needs user-facing workflow documentation; otherwise leave unchanged and state skipped.
- [x] Validation: docs match behavior tests; no release files touched.

### Slice Exit Gate
- [x] `npm run build && node --test dist/test/rework-policy.test.js dist/test/completion-report.test.js dist/test/local-execution-session.test.js dist/test/review-gates.test.js dist/test/scoped-auto-command.test.js`

### Review Checkpoints
- [x] After Slice 2, run focused `$code-review` as described above.
- [x] After all slices, run `$cleanup-review` then final `$code-review` on the full diff because this changes runner retry/state behavior and publication safety.

### Review Focus
- Typed blocker source-of-truth ownership; hard-block precedence; repair eligibility; repair budget and idempotency; content-based product-code mutation detection; local commit blocking; report overwrite semantics; rerunning normal gates after repair; evidence preservation in terminal handoff; no regression of `incomplete-after-progress`; no hidden GitHub/publication authority in repair prompts.

## 4. Validation And Done Criteria
- [x] **Lint/Format:** `git diff --check`.
- [x] **Typecheck:** `npm run typecheck`.
- [x] **Tests:** `npm test` plus focused built test commands per slice.
- [x] **Architecture Check:** No dedicated architecture-check script exists; use source docs plus required review gates.
- [x] **Live/Manual Validation:** Not applicable by default; do not run `npm run smoke:live` unless explicitly requested.
- [x] **Behavior Proof:** Contract Test Ledger rows green; focused tests prove typed blockers, report repair, evidence repair, hard-block boundaries, repair mutation blocking, durable evidence, and `incomplete-after-progress` regression safety.
- [x] **Final Reconciliation:** all unchecked work is unfinished, blocked with a note, or intentionally not applicable.
- [x] **Final Handoff Requirements:** final response must include contract implemented, high-risk checkpoint result, main invariants proved, cleanup/code-review findings and fixes, validation commands, skipped checks, residual risks, and files by role.

## 5. Final Action
After saving the file, respond in chat with exactly:

Spec Status: Ready / Blocked
Saved Path: docs/implementation-specs/2026-07-07/1308-typed-blocker-evidence-report-repair.md
Execution Model: Single-Agent
Review Verdict: Approved
Validation Gates: Local Tests
Blockers: None
