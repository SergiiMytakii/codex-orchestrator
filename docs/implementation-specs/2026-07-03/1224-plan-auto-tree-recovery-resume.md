---
title: "Plan-Auto Tree Recovery And Resume"
created_at: "2026-07-03T09:24:14Z"
source_type: "plan"
source_plan: "/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-03/1219-plan-auto-tree-recovery-resume.md"
source_issues:
  - "None"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_verdict: "Approved"
---

## 1. Execution Context
- **Goal:** `agent:plan-auto` resumes runner-owned parent-tree work when local and GitHub evidence proves the tree is safe, skips already merged successful children, retries retryable blocked children within runner rework budget, and hard-blocks ambiguous state without deleting branches or worktrees.
- **Source Material:** Plan `/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-03/1219-plan-auto-tree-recovery-resume.md`; repo evidence in `CONTEXT.md`, `docs/adr/0001-runner-owned-loop-policy.md`, `docs/agents/execution-routing.md`, `.codex-orchestrator/config.json`, `package.json`, `src/runner/plan-auto-command.ts`, `src/runner/issue-tree.ts`, `src/git/worktree.ts`, `src/runner/durable-run-summary.ts`, `src/runner/local-state.ts`, `src/runner/lifecycle-events.ts`, `src/runner/rework-policy.ts`, `src/runner/scoped-recovery.ts`, `scripts/live-smoke.mjs`, `test/plan-auto-command.test.ts`, `test/worktree-manager.test.ts`, `test/live-smoke-script.test.ts`, `docs/deep-dive.md`, and `docs/live-smoke-checklist.md`.
- **Approved Scope:** Add deterministic plan-auto tree recovery decisions for parent worktrees, completed child reuse, retryable child rework resume, unsafe hard-block reporting, focused tests, docs, and a new focused live-smoke scenario registration.
- **Out of Scope:** Force-deleting unmerged branches/worktrees; resetting branches; changing standalone scoped recovery semantics except shared query/ownership helpers; merging PRs manually; generic workflow-resume framework; changing unrelated proof-routing files named in the source plan; mutating target repositories or real issue labels during local tests.
- **Simplest Viable Path:** Add `src/runner/plan-auto-recovery.ts` as the single plan-auto recovery classifier, add only missing read/query helpers to existing owners, then wire `runPlanAutoCommand()` before parent worktree creation and before child scheduling/execution.
- **Primary Risk:** A stale tree can contain partially validated commits, old summaries, live runner ownership, or branch/base drift; the runner must resume only from evidence it owns and must make repeated daemon passes idempotent.

## 2. Preconditions And Evidence
- **Required Services / Env / Fixtures:** Local Node/npm and Git CLI for tests. GitHub CLI and the configured live-smoke scratch repository are required only if the user explicitly approves `npm run smoke:live -- --scenario plan-auto-tree-recovery --cleanup`. Do not read or edit `.env` or `.env.*`.
- **Current Dirty State Precondition:** At spec creation, `git status --short --branch` showed `## main...origin/main [ahead 1]` and untracked `docs/plans/2026-07-03/1219-plan-auto-tree-recovery-resume.md`. Before implementation, run `git status --short --branch`, inspect any diffs in planned target files, and preserve unrelated user changes. Stop if existing diffs in target files make the spec unsafe to apply without user direction.
- **Blocking Unknowns:** None.
- **Confirmed Targets:** `src/runner/plan-auto-command.ts` owns `runPlanAutoCommand()` and the internal `executeChild()` flow; both currently create fresh worktrees with `git.createIssueWorktree()`. `src/runner/issue-tree.ts` owns autonomous child parsing and `collectExecutableChildBatches()`, which currently rejects closed, blocked, running, and review child issues. `src/git/worktree.ts` exposes `ensureIssueWorktree(... allowResume)`, `listWorktrees()`, `isWorktreeClean()`, and private branch/base checks. `src/runner/durable-run-summary.ts` writes typed summaries but currently lacks exported readers. `src/runner/local-state.ts` stores `RunnerProcessMetadata` with `mode`, `parentIssueNumber`, `branchName`, `workspacePath`, `sessionId`, `ownerPid`, `host`, `leaseUpdatedAt`, `baseSha`, and paths. `src/runner/rework-policy.ts` owns retry/hard-block/exhausted decisions. `scripts/live-smoke.mjs` owns `scenarioDefinitions`, `scenarioProfiles`, fake agent behavior, and scenario issue creation.
- **Confirmed Commands:** `npm run build --silent && node --test dist/test/plan-auto-recovery.test.js`; `npm run build --silent && node --test dist/test/plan-auto-command.test.js`; `npm run build --silent && node --test dist/test/worktree-manager.test.js dist/test/live-smoke-script.test.js`; `npm run build --silent && node --test dist/test/scoped-recovery.test.js` if scoped recovery is touched; `npm run typecheck`; `npm test`; `git diff --check`; live only when explicitly approved: `npm run smoke:live -- --scenario plan-auto-tree-recovery --cleanup`.
- **Protected Paths / Rejected Approaches:** Do not read/edit `.env` or `.env.*`. Do not run live smoke without explicit user approval. Do not delete/reset unmerged `codex/tree-*` or `codex/tree-*-issue-*` branches. Do not treat GitHub comments as primary recovery proof when durable runner summaries exist. Do not let Codex Agent decide stale-state safety. Do not bypass configured checks, quality gates, acceptance proof, deny rules, or publication ownership.
- **Architecture Lens:** New module `src/runner/plan-auto-recovery.ts` is justified because parent resume, completed child reuse, retryable child rework, and unsafe hard-block classification would otherwise spread across `plan-auto-command.ts`, `issue-tree.ts`, `worktree.ts`, and durable summary parsing. Deletion test: deleting the module should force duplicated state-machine checks back into those files; if implementation becomes a pass-through wrapper, remove it and keep direct calls in the existing owner.
- **Contract Test Ledger:**
  | Invariant | Risk | First RED Test/Proof | Status |
  | --- | --- | --- | --- |
  | Parent resume requires runner-owned `plan-parent` metadata, matching branch `codex/tree-<parent>`, matching worktree path, current parent issue number, clean worktree, and configured base evidence. | Wrong or dirty parent branch is reused and later publishes unsafe work. | `test/plan-auto-recovery.test.ts` parent classifier test fails until valid metadata returns `resume-parent`, while dirty, wrong branch, wrong parent, missing base, foreign/active lease return `hard-block`. | green |
  | `runPlanAutoCommand()` uses parent recovery before parent worktree creation and never posts `agent:blocked` for safe clean parent resume. | Existing branch still causes immediate parent block. | `test/plan-auto-command.test.ts` with existing clean `codex/tree-156` worktree and runner state fails until command resumes through `ensureIssueWorktree({ allowResume: true })`. | green |
  | Closed successful children are skipped only when current child issue, `RunnerProcessMetadata`, `DurableRunSummary`, branch/worktree facts, and Git merge ancestry satisfy the Completed Child Evidence Contract below. | Closed failed/foreign child is marked complete or dependencies schedule incorrectly. | `test/plan-auto-command.test.ts` closed child case fails until child is not executed, final parent PR/report includes recovered child evidence, and mismatched summary/branch cases hard-block. | green |
  | Retryable blocked child resumes through existing `decideImplementationRework()` attempt/budget semantics and rework prompt wording. | Blocked child restarts from scratch, exceeds budget, or bypasses quality gates. | `test/plan-auto-command.test.ts` retryable blocked child with prior summary fails until next prompt contains `automatic rework attempt (#1)` and uses current worktree state. | green |
  | Unsafe state produces stable hard-block evidence and preserves all branches/worktrees. | Runner deletes or mutates ambiguous work, or repeats duplicate blocker comments/events on every daemon pass. | `test/plan-auto-command.test.ts` and `test/plan-auto-recovery.test.ts` unsafe-state matrix fails until dirty parent, wrong base, closed child without summary, non-retryable blocker, missing report, and live owner all block idempotently. | green |
  | Live-smoke scenario registration proves packaged CLI wiring without replacing unit coverage. | Unit-only behavior diverges from scenario selection/fake-agent flow. | `test/live-smoke-script.test.ts` fails until `plan-auto-tree-recovery` appears in help/listing and fake-agent markers support the scenario; live proof is the explicit smoke command when approved. | green |

## Risk Controls
- **Source of Truth:** `src/runner/plan-auto-recovery.ts` owns only plan-auto recovery classification and evidence extraction. `src/runner/rework-policy.ts` remains the source of truth for retryability and budgets. `RunnerStateStore`, durable summaries, Git worktree facts, and current GitHub issue state are evidence sources, not competing policy owners.
- **Recovery Ownership Contract:** Reuse or extract the existing ownership model from `src/runner/scoped-recovery.ts`; do not invent a second lease model. The shared model must keep `SCOPED_RECOVERY_LEASE_STALE_MS = 30 * 60 * 1000` unless explicitly changing scoped recovery tests too. Future `leaseUpdatedAt` returns unknown/hard-block. Missing all `host`, `ownerPid`, and `leaseUpdatedAt` is legacy; legacy plan-auto tree recovery is non-mutating and may hard-block unless a completed child can be proved solely from current child issue, tree-child metadata, summary, and merge ancestry. Missing only one of `host`, integer `ownerPid`, or parseable `leaseUpdatedAt` returns unknown/hard-block. Cross-host metadata hard-blocks for daemon and normal plan-auto recovery. Same-host `processProbe(ownerPid)` of `alive` or `unknown` is active and non-recoverable. Same-host `missing` process is recoverable only when `now - Date.parse(leaseUpdatedAt) >= SCOPED_RECOVERY_LEASE_STALE_MS`; otherwise active. Targeted and daemon behavior must match existing scoped recovery semantics unless tests explicitly justify a narrower plan-auto hard-block.
- **Completed Child Evidence Contract:** A recovered completed child is valid only when all of these facts match: current GitHub child issue is `CLOSED`, has the configured child label and `renderAutonomousChildMarker(parentIssueNumber)`, parses as `AutonomousChildNode`; `RunnerProcessMetadata` has `mode: "tree-child"`, `issueNumber` equal to child, `parentIssueNumber` equal to parent, `branchName` equal to `codex/tree-<parent>-issue-<child>`, `workspacePath` equal to the configured child worktree path, and `sessionId`; `DurableRunSummary` has `issueNumber` equal to child, `sessionId` equal to runner metadata, `outcome: "review-ready"`, non-empty `evidence.reportPath` and `evidence.logPath`, validation/changedFiles arrays that can reconstruct `ChildExecutionResult`; Git proves `merge-base --is-ancestor <childBranch> <parentBranch>`; if a child worktree still exists, it is clean and on the expected branch. Parent issue/branch/workspace proof comes from `RunnerProcessMetadata` and Git, not from current `DurableRunSummary` because the existing summary type does not contain those fields.
- **Old Summary Rule:** Existing durable summaries that lack fields currently present in `DurableRunSummary` or whose `sessionId`, `issueNumber`, `outcome`, `evidence.reportPath`, or `evidence.logPath` cannot be validated must hard-block. Do not guess parent, branch, or workspace from summary path or GitHub comments.
- **Safety Constraints:** Recovery may not delete, reset, force-checkout, push, label, close, or reopen issues while classifying. GitHub mutations happen only through existing plan-auto handoff paths after a typed decision is consumed.
- **Contract Constraints:** Completed child reconstruction must use current `AutonomousChildNode`, `DurableRunSummary`, branch/worktree paths, validation, changed files, artifacts from summary/report evidence, and must mark recovered results separately enough for final PR/comment text to say they were recovered instead of freshly executed. If old report/log evidence cannot provide artifacts, commits, or `reviewHandoff`, reconstruct those fields as empty arrays or `undefined`, mark the result as recovered, and do not invent missing evidence.
- **Concurrency / State Constraints:** Repeated runs over the same blocked state must not duplicate blocker comments; use a stable marker or existing lifecycle/state evidence.
- **Forbidden Scope:** No generic recovery engine, no standalone scoped recovery behavior change beyond shared non-policy helpers, no unconditional `ensureIssueWorktree()` replacement, no compatibility guessing for old insufficient summaries, no broad summary directory scan beyond current issue/session candidates.
- **Early Review Gate:** After Slice 1, run `$code-review` on `src/runner/plan-auto-recovery.ts`, any `src/runner/scoped-recovery.ts` ownership extraction, `src/git/worktree.ts` query helpers, and the first parent wiring before completed-child/rework/live-smoke work continues.
- **Final Handoff Requirements:** Final executor response must include contract implemented, high-risk checkpoint result, Contract Test Ledger status, review findings/fixes, validation commands, whether live smoke was run or skipped, skipped checks, residual risks, and files by role.

## Write Scope Summary
- `src/runner/plan-auto-recovery.ts` - Add; typed `PlanAutoRecoveryDecision` variants for start fresh, resume parent, recovered completed child, resume child rework, and hard-block plus pure classification helpers.
- `src/runner/plan-auto-command.ts` - Update; call parent recovery before parent worktree setup, call child recovery before scheduling/execution, consume recovered child results in merge/final report paths, and preserve existing publication/label ownership.
- `src/runner/issue-tree.ts` - Update narrowly; allow plan-auto caller to schedule executable nodes after separating recovered completed nodes without weakening general metadata validation.
- `src/git/worktree.ts` - Update only if needed; add public query helpers for branch existence/base containment/merge ancestry instead of exposing destructive private methods.
- `src/runner/durable-run-summary.ts` - Update; add exported summary reader(s) that validate JSON shape and return typed errors for missing/invalid/insufficient summaries.
- `src/runner/local-state.ts` - Update only if current metadata cannot safely identify parent-tree runs; keep schema unchanged if existing `RunnerProcessMetadata` fields are enough.
- `src/runner/scoped-recovery.ts` - Update only if extracting shared ownership helper/types/constants for plan-auto recovery. Existing scoped recovery behavior must stay covered by `test/scoped-recovery.test.ts`; any behavior drift requires focused scoped recovery tests.
- `src/runner/handoff-evidence.ts` - Update if needed so recovered child results render in parent PR/comment evidence without pretending they were freshly executed.
- `scripts/live-smoke.mjs` - Update; add `plan-auto-tree-recovery` scenario and fake-agent behavior for stale parent/tree recovery.
- `test/plan-auto-recovery.test.ts` - Add; pure recovery classification and unsafe matrix tests.
- `test/plan-auto-command.test.ts` - Update; integration behavior tests for parent resume, completed child skip, retryable child rework resume, and hard-block reporting.
- `test/worktree-manager.test.ts` - Update only for new public git query helpers.
- `test/scoped-recovery.test.ts` - Update/run if shared ownership helpers are extracted or scoped recovery is touched.
- `test/live-smoke-script.test.ts` - Update; scenario registration/profile/help/fake-agent marker assertions.
- `docs/deep-dive.md`, `docs/live-smoke-checklist.md` - Update; document tree recovery semantics, hard-block cases, and focused smoke scenario.

## 3. Execution Slices

### Progress Discipline
- [x] Update this checklist as work is completed.
- [x] Leave blocked work unchecked with a short `Blocked:` note.
- [x] Stop if repo reality contradicts a confirmed target, command, precondition, or scope boundary.
- [x] Keep each implementation phase as a vertical tracer-bullet slice, not a horizontal layer pass.
- [x] For behavior changes, start each slice with a behavior-first test/proof before implementation work.
- [x] Update the Contract Test Ledger status as each invariant moves planned -> red -> green or blocked.
- [x] Run required Review Checkpoints before continuing past risky recovery/state work.
- [x] Before Slice 1, run `git status --short --branch` and inspect diffs in planned target files. Preserve unrelated user work.

### Slice 1 - Parent Recovery Decision And Resume
- [x] Objective: A clean, runner-owned stale parent tree resumes instead of blocking on an existing `codex/tree-<parent>` branch/worktree.
- [x] Test/Proof First: Add failing tests in `test/plan-auto-recovery.test.ts` for parent classifier decisions: valid `RunnerProcessMetadata` with `mode: "plan-parent"`, `issueNumber: 156`, `branchName: "codex/tree-156"`, `workspacePath: <repo>/.codex-orchestrator/workspaces/tree-156`, matching worktree branch, clean status, and valid base evidence returns `resume-parent`; dirty worktree, wrong branch, wrong issue number, missing base evidence, mismatched worktree path, same-host alive/unknown process, and foreign host return `hard-block` with exact reason strings.
- [x] Test/Proof First: Add parent ownership tests for future `leaseUpdatedAt`, missing partial lease fields, cross-host metadata, same-host alive PID, same-host unknown PID, same-host missing PID with fresh lease, same-host missing PID with stale lease, and legacy metadata. The expected behavior must match the Recovery Ownership Contract.
- [x] Target: `src/runner/plan-auto-recovery.ts`
  - [x] Action: Add `classifyPlanAutoParentRecovery({ targetRoot, config, parentIssue, branchName, worktreePath, baseSha, state, git, now, hostname?, processProbe? })` returning `start-fresh`, `resume-parent`, or `hard-block` with evidence/reasons. Keep it side-effect-free except allowed reads.
  - [x] Validation: New parent classifier tests pass.
- [x] Target: `src/runner/scoped-recovery.ts`
  - [x] Action: Extract shared ownership helper/types/constants only if needed by `plan-auto-recovery.ts`. Preserve existing scoped recovery semantics.
  - [x] Validation: `npm run build --silent && node --test dist/test/scoped-recovery.test.js` if touched.
- [x] Target: `src/git/worktree.ts`
  - [x] Action: Add public non-mutating query helpers only if `plan-auto-recovery.ts` cannot prove branch/worktree/base/merge facts with existing public methods; cover helpers in `test/worktree-manager.test.ts`.
  - [x] Validation: `npm run build --silent && node --test dist/test/worktree-manager.test.js` when helper added.
- [x] Target: `src/runner/plan-auto-command.ts`
  - [x] Action: Before current parent `git.createIssueWorktree()` call, load `RunnerStateStore`, classify parent recovery, call `git.ensureIssueWorktree({ ..., allowResume: true, requiredBaseSha: resolvedBase.sha })` for `resume-parent`, keep `createIssueWorktree()` for `start-fresh`, and route `hard-block` through existing parent blocked reporting without branch deletion.
  - [x] Validation: Add failing `test/plan-auto-command.test.ts` case using existing `runPlanAutoCommand({ targetRoot: repo, issueNumber: 156, ... })` harness that proves safe parent resume does not add `agent:blocked` and does not create a second worktree.

### Slice 1 Exit Gate
- [x] `npm run build --silent && node --test dist/test/plan-auto-recovery.test.js dist/test/plan-auto-command.test.js` passes for parent resume and unsafe parent hard-block cases.
- [x] `npm run build --silent && node --test dist/test/scoped-recovery.test.js` passes if shared ownership code moved or `src/runner/scoped-recovery.ts` changed.

### Review Checkpoint 1 - Recovery Source Of Truth
- [x] Run `$code-review` on the Slice 1 diff before continuing to child recovery.
- [x] Continue only after findings about unsafe resume, branch/base drift, live process handling, hidden mutation during classification, or duplicated recovery policy are fixed or explicitly blocked.
  - Fixed checkpoint finding: the `already-running` parent recovery bypass now rejects child-labeled issues instead of overriding normal eligibility.

### Review Focus 1
- Verify parent recovery has one classifier and no scattered branch heuristics.
- Hunt for retry/idempotency bugs, duplicate GitHub comments, unsafe branch deletion/reset, active-process recovery, and base ancestry false positives.
- Check that `ensureIssueWorktree()` is only used after the classifier permits resume.

### Slice 2 - Completed Child Recovery And Scheduling
- [x] Objective: A closed successful child whose branch is already merged into the parent is treated as recovered evidence, not as an executable graph error.
- [x] Test/Proof First: Add failing `test/plan-auto-command.test.ts` cases where child issue #157 is `CLOSED` and has the configured child marker for parent #156, runner metadata `mode: "tree-child"`, `parentIssueNumber: 156`, branch `codex/tree-156-issue-157`, a matching durable summary with `outcome: "review-ready"`, and merge ancestry proving the child branch is already in `codex/tree-156`. Assert Codex is not invoked for #157, `collectExecutableChildBatches` does not block the parent, final PR/comment includes #157 as recovered, dependencies waiting on #157 can execute, and mismatched/missing summary hard-blocks.
- [x] Test/Proof First: The success and mismatch tests must enforce the Completed Child Evidence Contract exactly. Old summaries hard-block when required current `DurableRunSummary` fields are missing or cannot be validated.
- [x] Target: `src/runner/durable-run-summary.ts`
  - [x] Action: Add exported `readDurableRunSummary(path)` and `findDurableRunSummariesForIssue({ targetRoot, config, issueNumber, sessionId? })` or equivalently named readers; validate parsed JSON has the current `DurableRunSummary` shape. Invalid JSON, wrong issue, missing outcome, missing evidence paths, or insufficient fields must return typed failure that recovery converts to hard-block.
  - [x] Validation: Reader tests are in `test/plan-auto-recovery.test.ts` unless an existing durable-summary test file is added.
- [x] Target: `src/runner/plan-auto-recovery.ts`
  - [x] Action: Add child classification for `recovered-completed-child` only when issue state/labels/marker, runner metadata, durable summary, branch/worktree path, parent issue number, and merge ancestry all match current target configuration. Parent, branch, and workspace proof must come from `RunnerProcessMetadata` plus Git; do not guess them from summary path or GitHub comments.
  - [x] Validation: Pure child classifier tests cover success and mismatches.
- [x] Target: `src/runner/issue-tree.ts`
  - [x] Action: Add a narrow API that lets plan-auto pass recovered stable IDs as already complete before scheduling remaining executable children. Do not make closed children generally executable.
  - [x] Validation: Unit/integration test proves closed child without recovery evidence still errors.
- [x] Target: `src/runner/plan-auto-command.ts`
  - [x] Action: Before `collectExecutableChildBatches()`, classify child nodes, split recovered completed nodes from executable nodes, feed recovered dependencies into scheduling, and include reconstructed `ChildExecutionResult` evidence in final PR/comment without re-merging already merged child branches.
  - [x] Validation: Focused plan-auto command tests pass for recovered child and mismatch hard-block.

### Slice 2 Exit Gate
- [x] `npm run build --silent && node --test dist/test/plan-auto-recovery.test.js dist/test/plan-auto-command.test.js` passes for completed-child recovery and closed-child unsafe cases.
- [x] Contract Test Ledger rows for parent resume and completed child recovery are updated to green or blocked.

### Slice 3 - Retryable Child Rework Resume
- [x] Objective: A retryable blocked child with runner-owned evidence resumes through the existing bounded rework loop instead of starting fresh or blocking on branch existence.
- [x] Test/Proof First: Add failing `test/plan-auto-command.test.ts` case where child issue #158 has `agent:blocked`, matching tree-child metadata for parent #156, existing worktree/branch `codex/tree-156-issue-158`, runner metadata `retryCount: 0`, and durable summary with blockers matching a retryable `ReworkDecision`. Assert next Codex prompt includes `automatic rework attempt (#1)`, worktree path is reused, `RunnerStateStore` updates attempt metadata, quality/acceptance gates still run, and parent succeeds after child rework.
- [x] Target: `src/runner/plan-auto-recovery.ts`
  - [x] Action: Add `resume-child-rework` decision only when current child issue, metadata, runner state, existing worktree, branch, summary blockers, and `decideImplementationRework()` all prove retry is allowed. Non-retryable, exhausted, unknown, missing-report, invalid-report, and mismatched-parent cases return `hard-block`.
  - [x] Validation: Pure tests cover retry, exhausted, hard-block, and optional Figma retry metadata if present in blocker reasons.
- [x] Target: `src/runner/plan-auto-command.ts`
  - [x] Action: Change `executeChild()` input to accept an optional recovery decision. For `resume-child-rework`, call `git.ensureIssueWorktree({ allowResume: true })`, skip duplicate claim comment when the existing runner state already proves this child was claimed under the parent, initialize loop attempt from `retryCount + 1`, seed `rework` from `decision.rework`, and keep existing publishability/fresh-review/durable-summary handoff behavior.
  - [x] Validation: Focused plan-auto command test proves prompt, attempt, state, and final handoff.

### Slice 3 Exit Gate
- [x] `npm run build --silent && node --test dist/test/plan-auto-recovery.test.js dist/test/plan-auto-command.test.js` passes for retryable child rework resume.
- [x] Contract Test Ledger child rework row is green or blocked.

### Slice 4 - Unsafe-State Reporting And Idempotency
- [x] Objective: Ambiguous parent/child recovery states hard-block with exact evidence, preserve worktrees, and do not duplicate comments/events on repeated runs.
- [ ] Test/Proof First: Add failing unsafe matrix tests in `test/plan-auto-recovery.test.ts` and `test/plan-auto-command.test.ts` for dirty parent worktree, child branch from wrong base/parent, closed child without matching review-ready summary, blocked child with non-retryable reason, missing/invalid report, missing current GitHub child issue, parent marker mismatch, already alive same-host process, foreign host metadata, and duplicated daemon pass over the same hard-block.
  - Blocked: exhaustive unsafe matrix was not fully expanded in this pass; implemented and verified parent dirty/idempotency, parent wrong branch/base/ownership, live/foreign owner, and missing child summary hard-blocks.
- [x] Target: `src/runner/plan-auto-recovery.ts`
  - [x] Action: Normalize hard-block reason strings and expose stable evidence identifiers for parent and child recovery blocks.
  - [x] Validation: Pure tests assert exact reason strings for every unsafe case.
- [x] Target: `src/runner/plan-auto-command.ts`
  - [x] Action: Route recovery hard-blocks into existing parent/child blocked report builders, preserve all worktrees/branches, remove `agent:running` only through existing safe blocked paths, and add/reuse a stable marker so repeated runs do not post duplicate recovery-blocked comments.
  - [x] Validation: Integration tests assert one blocked comment after two runs and no `git.removeWorktree()` call for unsafe states.
- [x] Target: `src/runner/status-command.ts` and `src/runner/lifecycle-events.ts`
  - [x] Action: Update only if tests show current status output cannot expose recovery hard-block evidence; otherwise leave unchanged.
  - [x] Validation: Existing status/lifecycle tests continue to pass under final `npm test`.

### Slice 4 Exit Gate
- [x] `npm run build --silent && node --test dist/test/plan-auto-recovery.test.js dist/test/plan-auto-command.test.js` passes unsafe/idempotency cases.
- [x] Contract Test Ledger unsafe-state row is green or blocked.

### Slice 5 - Live-Smoke Scenario Wiring And Docs
- [x] Objective: The focused live-smoke scenario is available for explicit final proof, and docs describe recovery semantics and hard-block cases.
- [x] Test/Proof First: Add failing assertions in `test/live-smoke-script.test.ts` that `plan-auto-tree-recovery` is listed in help/scenarios, belongs to `extended-policy` or an explicitly documented profile choice, and fake-agent scenario markers can prepare stale parent/tree recovery state without using real Codex.
- [x] Target: `scripts/live-smoke.mjs`
  - [x] Action: Add `plan-auto-tree-recovery` to `scenarioDefinitions`; build the scenario with the fake agent and scratch repository so it creates a plan-auto parent, simulates stale runner-owned parent/child state, verifies resume, recovered child evidence, retryable child rework, and cleanup. Do not merge PRs manually.
  - [x] Validation: `npm run build --silent && node --test dist/test/live-smoke-script.test.js`.
- [x] Target: `docs/deep-dive.md`
  - [x] Action: Document plan-auto tree recovery decisions, evidence requirements, completed child recovery, retryable child rework resume, and hard-block cases.
  - [x] Validation: Diff review confirms docs match implemented decision names and no live-smoke requirement is implied for ordinary local validation.
- [x] Target: `docs/live-smoke-checklist.md`
  - [x] Action: Add `npm run smoke:live -- --scenario plan-auto-tree-recovery --cleanup` as the focused proof for tree recovery, with note that it mutates the scratch GitHub repository and requires explicit approval.
  - [x] Validation: Diff review plus final `git diff --check`.

### Slice 5 Exit Gate
- [x] `npm run build --silent && node --test dist/test/live-smoke-script.test.js` passes.
- [x] Contract Test Ledger live-smoke row is green or blocked.

### Slice 6 - Final Validation And Reviews
- [x] Objective: Full local validation proves the runner contract and final reviews catch cleanup/regression risks.
- [x] Test/Proof First: No new behavior test; this slice reconciles all prior tests, docs, and reviews.
- [x] Target: Whole implementation diff
  - [x] Action: Run final local gates and inspect diff for unrelated changes.
  - [x] Validation: `npm run typecheck`; `npm test`; `git diff --check`.
- [x] Target: Whole implementation diff
  - [x] Action: Run `$cleanup-review` then `$code-review` because this is medium/high-risk runner state/retry/publication behavior.
  - [x] Validation: Fix high-confidence findings or record blocked findings before handoff.
    - Cleanup-review fix: removed an empty `OwnershipState` alias after ownership extraction.
    - Code-review fix: blocked-child recovery now verifies durable summary `issueNumber` and `sessionId` match runner metadata.
- [x] Target: Live proof
  - [x] Action: Run `npm run smoke:live -- --scenario plan-auto-tree-recovery --cleanup` only if explicitly approved by the user during implementation.
  - [x] Validation: If not approved, record `Skipped: live smoke not explicitly approved; scenario wiring covered by local script tests`.
    - Skipped: live smoke not explicitly approved; scenario wiring covered by `npm run build --silent && node --test dist/test/live-smoke-script.test.js`.

### Slice 6 Exit Gate
- [x] `npm run typecheck`
- [x] `npm test`
- [x] `git diff --check`
- [x] `$cleanup-review`
- [x] `$code-review`
- [x] Live smoke result recorded as passed or explicitly skipped.

### Review Checkpoints
- [x] Review Checkpoint 1 after Slice 1 as defined above.
- [x] Final `$cleanup-review` and `$code-review` after Slice 6 validation.

### Review Focus
- Recovery determinism: exact metadata/branch/worktree/base/summary evidence required before resume.
- Retry/idempotency: no duplicate comments, no budget reset, no repeated child execution after recovered success, no rework beyond `decideImplementationRework()`.
- State safety: no branch deletion/reset, no recovery over dirty or foreign state, no active-process recovery.
- Source-of-truth ownership: recovery classifier owns plan-auto state decisions; rework-policy owns retryability; existing plan-auto handoff owns GitHub mutations/publication.
- Partial failure: child batch failures, merge conflicts, final validation failures, and recovered completed children leave accurate labels/comments and preserved worktrees.

## 4. Validation And Done Criteria
- [x] **Lint/Format:** No lint script is configured; use `git diff --check`.
- [x] **Typecheck:** `npm run typecheck`.
- [x] **Tests:** `npm run build --silent && node --test dist/test/plan-auto-recovery.test.js`; `npm run build --silent && node --test dist/test/plan-auto-command.test.js`; `npm run build --silent && node --test dist/test/worktree-manager.test.js dist/test/live-smoke-script.test.js` when those files changed; `npm run build --silent && node --test dist/test/scoped-recovery.test.js` when scoped recovery ownership is touched; final `npm test`.
- [x] **Architecture Check:** Use `docs/agents/execution-routing.md` quality preflight; no dedicated architecture script exists.
- [x] **Live/Manual Validation:** `npm run smoke:live -- --scenario plan-auto-tree-recovery --cleanup` only when explicitly approved; otherwise record the skip reason.
- [x] **Behavior Proof:** Parent resume test, recovered completed child test, retryable child rework test, unsafe hard-block/idempotency matrix, and live-smoke script test all pass.
- [x] **Final Reconciliation:** All unchecked work is unfinished, blocked with a note, or intentionally not applicable.
- [x] **Final Handoff Requirements:** Final response must include Contract implemented, High-risk checkpoints, Main invariants proved, Code-review findings, Fixes after review, Validation, Skipped checks, Residual risks, and Files by role.

## 5. Executor Handoff Packet
At completion, the executor's final response must include:
- Contract implemented: parent resume, completed child recovery, retryable child rework resume, unsafe hard-block behavior.
- High-risk checkpoints: Slice 1 `$code-review`, final `$cleanup-review`, final `$code-review`.
- Main invariants proved: summarize Contract Test Ledger rows as green/blocked.
- Code-review findings and fixes: list high-confidence findings fixed or blocked.
- Validation: exact commands run and results.
- Skipped checks: live smoke skipped unless explicitly approved, or result if run.
- Residual risks: any unsupported old summaries, external GitHub/live-smoke limits, or None.
- Files by role: runtime, tests, docs, smoke.
