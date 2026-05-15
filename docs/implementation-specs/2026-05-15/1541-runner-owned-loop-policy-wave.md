---
title: "Runner-owned Loop Policy scoped execution wave"
created_at: "2026-05-15T12:41:05Z"
source_type: "wave"
source_plan: "None"
source_issues:
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/336"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/337"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/338"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/339"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/340"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/341"
status: "ready"
execution_model: "single-agent"
spec_mode: "compact"
review_verdict: "Approved"
---

## 1. Execution Context
- **Goal:** Consume the implemented #337 Loop Policy config contract in daemon selection, scoped rework, fresh-context review, and durable scoped run summaries without giving the Agent selection or publication authority.
- **Source Material:** Parent PRD #336, contract issue #337, active wave issues #338-#341, `CONTEXT.md`, `docs/adr/0001-runner-owned-loop-policy.md`, and local repo evidence in the confirmed targets below.
- **Approved Scope:** #338 daemon selection by `loopPolicy.issueSelection.priorityLabels` with `issue-number-asc` tie-breaker; #339 scoped Rework Loop by `loopPolicy.rework.maxAttempts` and `retryableBlockers`; #340 optional scoped Fresh-Context Review using the existing Codex adapter boundary; #341 scoped Durable Run Summary artifacts and handoff excerpts.
- **Out of Scope:** Issue-tree loop policy support, live smoke updates, release notes, npm publish, auto-merge, non-GitHub trackers, LLM-selected prioritization, automatic mutation of prompts/config from policy suggestions, and changing the #337 config shape.
- **Simplest Viable Path:** Reuse existing runner modules and fakeable adapters: sort eligible daemon decisions after existing skip rules, replace scoped hard-coded retry classification with config-driven blocker codes, add one separate review phase before push/PR, and persist a small runner-owned summary before review-ready or blocked handoff reports.
- **Primary Risk:** The four issues share one scoped publication path; review, retry, and summary work must not let Codex sessions push, label, comment, or publish before runner-owned gates finish.

## 2. Preconditions And Evidence
- **Required Services / Env / Fixtures:** Node.js `>=18`, npm dependencies installed, `git` CLI for scoped tests. Automated tests use temp repos, in-memory GitHub issue/PR adapters, fake Codex adapters, fake shell executors, and temporary `.codex-orchestrator` state directories. No live GitHub credentials or real Codex invocation are required.
- **Blocking Unknowns:** None.
- **Confirmed Targets:** `src/config/schema.ts` already defines `loopPolicy.issueSelection.priorityLabels/tieBreaker`, `rework.maxAttempts/retryableBlockers`, `freshContextReview.enabled/mode/blockOnHighConfidencePolicyViolations`, `durableRunSummaries.enabled`, and `policySuggestions.enabled/maxSuggestions`; `src/runner/daemon-command.ts` owns daemon polling and `findNextEligibleIssue`; `src/runner/issue-state-machine.ts` owns eligibility/skip decisions; `src/runner/scoped-auto-command.ts` owns scoped attempts, Codex invocation, blocked/review label transitions, push, PR creation, and reports; `src/runner/local-execution-session.ts` owns runner local phase sequencing and publishability checks; `src/runner/handoff-evidence.ts` owns scoped report/PR body rendering; `src/codex/command-adapter.ts` is the existing Codex CLI boundary; `src/runner/local-state.ts` persists runner metadata under `runner.stateDir`.
- **Confirmed Tests:** `test/daemon-command.test.ts`, `test/issue-state-machine.test.ts`, `test/scoped-auto-command.test.ts`, `test/local-execution-session.test.ts`, `test/handoff-evidence` coverage currently lives in scoped/plan tests, `test/codex-command-adapter.test.ts`, `test/local-state.test.ts`, and `test/fixtures/config.ts`.
- **Confirmed Commands:** `npm run typecheck`; `npm run build`; focused `npm run build && node --test dist/test/daemon-command.test.js dist/test/issue-state-machine.test.js dist/test/scoped-auto-command.test.js dist/test/local-execution-session.test.js dist/test/codex-command-adapter.test.js dist/test/local-state.test.js`; final `npm test`.
- **Protected Paths / Rejected Approaches:** Do not change `loopPolicy` schema from #337, do not add a second GitHub issue adapter abstraction, do not let the Agent choose work or mutate GitHub publication, do not store full implementation transcripts in summaries/comments, do not retry denied paths, secret/prohibited actions, publication-boundary violations, or maintainer clarification blockers.
- **Architecture Lens:** Reuse the runner command modules as owners. New code is allowed only when it has a current owner: a small retry classifier, fresh-context review helper, and durable summary helper pass deletion test if they remove config/string duplication from `scoped-auto-command.ts`; pass-through wrappers fail deletion test and must not be added.

## 3. Shared Contracts
- **Issue Selection:** Existing skip semantics stay in `decideIssueWork`. Selection policy is applied only after issues are classified. Priority order is the array order in `config.loopPolicy.issueSelection.priorityLabels`; lower index means higher priority. Unprioritized eligible issues sort after prioritized issues. `issue-number-asc` is the only supported tie-breaker.
- **Rework Blocker Codes:** Map blocked reasons into config codes before deciding retries: missing completion report -> `missing-completion-report`; invalid completion report -> `invalid-completion-report`; no changes -> `no-changed-files`; failed configured checks -> `failed-configured-checks`; quality gate missing TDD/cleanup/code-review evidence -> `missing-quality-gate-evidence`. Denied paths, secret/prohibited actions, publication-boundary violations, Codex non-zero exit without a retryable code, and maintainer clarification are non-retryable.
- **Fresh-Context Review Result:** Fakeable review phase returns `status: 'passed' | 'blocked'`, `findings: Array<{ severity: 'advisory' | 'high-confidence-policy-violation'; summary: string; evidence: string[] }>`, `validation: RunnerValidationLine[]`, `artifacts`, and `residualRisks`. Disabled config must skip the phase and preserve current behavior.
- **Durable Run Summary:** Runner-owned JSON artifact under configured state dir, for example `.codex-orchestrator/state/summaries/issue-155-<sessionId>.json`, with version, issueNumber, mode, sessionId, status, changedFiles, validation, blockers, residualRisks, policySuggestions, nextAction, promptPath/reportPath/logPath, and summaryExcerpt. It references existing logs/reports; it does not replace them.
- **Fake Adapter Requirements:** Tests must inject `codexAdapter.run` for implementation attempts and a separate fake review adapter or fake local phase for Fresh-Context Review. Fakes must capture inputs proving review did not receive implementation stdout/stderr/full transcript and must return deterministic advisory/blocking findings.

## 4. Execution Slices

### Progress Discipline
- [ ] Update this checklist as work is completed.
- [ ] Leave blocked work unchecked with a short `Blocked:` note.
- [ ] Stop if repo reality contradicts a confirmed target, command, precondition, or scope boundary.
- [ ] Keep each implementation phase as a vertical tracer-bullet slice, not a horizontal layer pass.
- [ ] For behavior changes, start each slice with a behavior-first test/proof before implementation work.

### Slice 1 - #338 Daemon Selection Policy
- [ ] Objective: Daemon executes the highest configured priority eligible issue while preserving all existing skip rules.
- [ ] Test/Proof First: In `test/daemon-command.test.ts`, keep/add tests where prioritized plan/scoped issues beat lower-number unprioritized issues, same-priority ties choose lower issue number, and skipped manual/blocked/running/review/closed/conflicting issues never win.
- [ ] Target: `src/runner/issue-state-machine.ts`
  - [ ] Action: Either keep `discoverIssueWork` issue-number sorted for audit output or add an exported/public selection helper only if needed by `daemon-command.ts`; do not change skip reason codes or eligibility decisions.
  - [ ] Validation: `node --test dist/test/issue-state-machine.test.js` after build.
- [ ] Target: `src/runner/daemon-command.ts`
  - [ ] Action: In `findNextEligibleIssue`, apply `config.loopPolicy.issueSelection` to eligible decisions before choosing one. Emit an auditable selection line naming matched priority label or unprioritized plus tie-breaker.
  - [ ] Validation: `node --test dist/test/daemon-command.test.js` after build.
- [ ] Slice Exit Gate: Daemon behavior tests prove configured priority labels select work; issue-number remains the deterministic tie-breaker.

### Slice 2 - #339 Bounded Scoped Rework Loop
- [ ] Objective: Scoped execution retries only configured retryable machine-checkable blockers and stops at `loopPolicy.rework.maxAttempts`.
- [ ] Test/Proof First: In `test/scoped-auto-command.test.ts`, add/keep tests for recovery within limit, exhaustion when `maxAttempts: 0` or after final attempt, and no retry for denied path/publication-boundary/prohibited action blockers. Assert rework prompt includes exact previous reasons and "continue from the current worktree state" behavior.
- [ ] Target: `src/runner/scoped-auto-command.ts`
  - [ ] Action: Replace `const maxReworkAttempts = 1` and regex-only `shouldRequestRework` ownership with config-driven max attempts and retryable blocker classification.
  - [ ] Action: Preserve the current rework prompt object passed to `buildScopedImplementationPrompt`; include exact previous blocker reasons.
  - [ ] Validation: `node --test dist/test/scoped-auto-command.test.js` after build.
- [ ] Target: `src/runner/local-execution-session.ts`
  - [ ] Action: Preserve blocked reason strings from publishability checks so the retry classifier can map them; do not hide original reasons in reports.
  - [ ] Validation: focused scoped tests cover mappings through public runner behavior.
- [ ] Slice Exit Gate: Retryable failures recover or block exactly at the configured limit; non-retryable failures run Codex once and block.

### Slice 3 - #340 Fresh-Context Review Before Scoped Handoff
- [ ] Objective: When enabled, a separate review pass runs after publishability evidence is collected and before `pushBranch`/`createDraftPullRequest`.
- [ ] Test/Proof First: In `test/scoped-auto-command.test.ts`, add fake-review tests for disabled mode preserving current behavior, advisory finding included in residual risks/report/PR body without blocking, and high-confidence policy violation blocking draft PR creation when `blockOnHighConfidencePolicyViolations` is true.
- [ ] Target: `src/runner/scoped-auto-command.ts`
  - [ ] Action: Add a fakeable review dependency to `ScopedAutoCommandOptions` or reuse `localPhaseExecutor` only if it keeps implementation and review inputs distinct. The review input must include issue context, changed files, completion report evidence, validation, artifacts, residual risks, and diff-oriented instructions; it must not include implementation stdout/stderr or full run log contents.
  - [ ] Action: Run review after publishability status is `publish-ready` and before push/PR. Disabled config must skip review.
  - [ ] Validation: scoped fake-adapter tests assert PR count is zero for blocking findings and one for advisory findings.
- [ ] Target: `src/codex/command-adapter.ts`
  - [ ] Action: Reuse the existing adapter boundary for real review sessions; add no new process/auth mechanism unless the current adapter cannot accept a distinct prompt/report path.
  - [ ] Validation: `test/codex-command-adapter.test.ts` remains passing.
- [ ] Target: `src/runner/handoff-evidence.ts`
  - [ ] Action: Render Fresh-Context Review validation/findings in scoped review comments and PR bodies using existing validation/residual-risk sections or one concise new review evidence section.
  - [ ] Validation: scoped report/PR body assertions prove evidence appears.
- [ ] Slice Exit Gate: Fresh-context review evidence is visible in handoff; blocking findings stop before publication; disabled mode is behavior-compatible.

### Slice 4 - #341 Durable Run Summaries For Scoped Execution
- [ ] Objective: Every scoped review-ready or blocked outcome writes a structured runner-owned summary and references it in handoff reports.
- [ ] Test/Proof First: In `test/scoped-auto-command.test.ts` or a new focused summary test, prove successful and blocked scoped runs write JSON summaries, include concise excerpts in issue comments/PR bodies, and preserve links/paths to prompt/report/log evidence. In `test/local-state.test.ts`, keep runner state metadata-only and reject full issue snapshots.
- [ ] Target: `src/runner/local-state.ts`
  - [ ] Action: Add summary path helpers or a small summary store only if it keeps `runner-state.json` metadata-only. Do not add issue body/comments/labels snapshots to runner state.
  - [ ] Validation: `node --test dist/test/local-state.test.js` after build.
- [ ] Target: `src/runner/scoped-auto-command.ts`
  - [ ] Action: Write the summary before `finishBlocked`, `finishPromotionRequested`, and review-ready issue/PR report publication. Include final next action: draft PR review, maintainer clarification/blocker resolution, or promotion review.
  - [ ] Validation: scoped tests assert summary file exists for blocked and review-ready results.
- [ ] Target: `src/runner/handoff-evidence.ts`
  - [ ] Action: Add summary excerpt/path rendering to blocked/review reports and scoped PR body. Keep raw logs and completion reports listed.
  - [ ] Validation: report/PR assertions cover excerpt and full summary path.
- [ ] Slice Exit Gate: Durable summary artifacts exist for success and blocked paths, separate confirmed facts from residual risks and policy suggestions, and do not replace existing logs/reports.

### Slice 5 - Wave Reconciliation
- [ ] Objective: Prove #338-#341 work together on the scoped path without drift from #337's config contract.
- [ ] Test/Proof First: Add one integration-style scoped test using config overrides for priority labels, `maxAttempts`, review blocking policy, and durable summaries. The fake implementation should fail once with a retryable quality blocker, recover, pass advisory review, write a summary, and create one draft PR.
- [ ] Target: `test/fixtures/config.ts`
  - [ ] Action: Keep `validConfig` based on `buildProjectConfig`; use per-test overrides rather than mutating the shared fixture.
  - [ ] Validation: full `npm test`.
- [ ] Target: `src/runner/scoped-auto-command.ts`, `src/runner/daemon-command.ts`, `src/runner/handoff-evidence.ts`
  - [ ] Action: Reconcile naming and evidence wording to domain terms from `CONTEXT.md`: Runner, Agent, Issue Selection Policy, Rework Loop, Fresh-Context Review, Durable Run Summary, Policy Suggestion, Draft PR Handoff.
  - [ ] Validation: focused tests and full test suite pass.
- [ ] Slice Exit Gate: Combined fake-adapter test proves retry, review, summary, and handoff evidence on one scoped run.

## 5. Stop Conditions
- [ ] Stop if implementation requires changing the #337 `loopPolicy` config shape or adding new enum values not already validated in `src/config/schema.ts`.
- [ ] Stop if any design requires the Agent or review session to call GitHub publication, labels, comments, pushes, merges, releases, or deploys.
- [ ] Stop if Fresh-Context Review cannot be tested without passing full implementation transcripts into the review session.
- [ ] Stop if summaries require storing full issue bodies/comments, secrets, raw Codex transcripts, or replacing existing logs/completion reports.
- [ ] Stop if retry classification cannot preserve original blocked reasons in final blocked reports.

## 6. Validation And Done Criteria
- [ ] **Lint/Format:** Not applicable; no lint/format script exists in `package.json`.
- [ ] **Typecheck:** `npm run typecheck`.
- [ ] **Build:** `npm run build`.
- [ ] **Focused Tests:** `npm run build && node --test dist/test/daemon-command.test.js dist/test/issue-state-machine.test.js dist/test/scoped-auto-command.test.js dist/test/local-execution-session.test.js dist/test/codex-command-adapter.test.js dist/test/local-state.test.js`.
- [ ] **Full Tests:** `npm test`.
- [ ] **Architecture Check:** `rg "createDraftPullRequest|pushBranch|addLabels|removeLabels|postComment|mergeBranch" src/runner/local-execution-session.ts` must show no publication calls. `rg "loopPolicy|Fresh-Context|Durable Run Summary|policy suggestion|shouldRequestRework|maxReworkAttempts" src test` should show one clear owner per behavior and no stale hard-coded one-attempt retry owner.
- [ ] **Live/Manual Validation:** Not applicable for this wave; do not run `npm run smoke:live` unless explicitly requested.
- [ ] **Behavior Proof:** Daemon priority selection, bounded retry recovery/exhaustion/stop, advisory/blocking Fresh-Context Review, and blocked/review-ready Durable Run Summaries are all proven through public runner behavior with fake adapters.
- [ ] **Final Review Gates:** Run cleanup-review first because the wave touches multiple runtime files; integrate high-confidence cleanup fixes and rerun relevant checks. Then run final code-review and fix critical, medium, or high-confidence findings.
- [ ] **Final Reconciliation:** all unchecked work is unfinished, blocked with a note, or intentionally not applicable.

## 7. Spec Review
- **Review Method:** Applied `implementation-spec-review` criteria after drafting because this compact wave targets more than three runtime files and shared runner state.
- **Review Scores:** Determinism 2/2; Evidence 2/2; Validation 2/2; Safety 2/2.
- **Critical Defects:** None.
- **Required Fixes Before Execution:** None.

## 8. Final Action
After saving the file, respond in chat with exactly:

Spec Status: Ready
Saved Path: docs/implementation-specs/2026-05-15/1541-runner-owned-loop-policy-wave.md
Execution Model: Single-Agent
Review Verdict: Approved
Validation Gates: Local / Tests
Blockers: None
