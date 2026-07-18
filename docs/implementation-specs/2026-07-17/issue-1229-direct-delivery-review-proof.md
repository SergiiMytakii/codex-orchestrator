# Issue #1229 — Direct Delivery Review-To-Proof

Status: ready
Mode: compact
Review profile: high

## 1. Authority And Scope

- Product authority: GitHub issue #1229, parent #1225, and the approved route contract from #1227.
- Baseline: ancestor commits `144a9d2`, `2898e9e`, and `da2885e` on `codex/issue-1225`.
- Implement only the `direct` route. A direct run must never create a spec artifact or invoke `spec-author`, `spec-review`, or `spec-implementation`.
- Reuse the resulting implementation-review-to-proof state machine from a typed Runner-owned seam; #1231 may supply a frozen spec to that seam later, but this ticket does not implement the complex/spec path.
- Preserve existing checked-change, denied-path, proof freshness, owner-lock, publication, and waiting-human contracts.
- Live GitHub smoke remains outside AFK completion.

## 2. Confirmed Repository Reality

- `RunIssue` currently performs implementation, configured checks, Acceptance Proof, and publication, but has no cleanup/code-review stage.
- `internal-workflow` already ships sealed `cleanup-review` and `code-review` operations, reviewer profiles, and `code-review-v1.json`; runtime operation preparation does not yet admit those operation IDs.
- `RunRecordV1` currently persists only implementation report/transport budgets and broad lifecycle names. It cannot resume a cleanup/full/closure review or preserve reviewer identity and a defect ledger.
- Implementation agents are workspace-write contained processes. Reviewer operations are read-only/report-only and must remain separate attempts with separate session IDs.
- Acceptance Proof already consumes a nominal `CheckedChange`; the new seam must produce that capability only after implementation review is clear and configured checks pass.

## 3. Public Contracts

### 3.1 Review Report

Create `src/v2/code-review-report.ts` with exact runtime/schema parity:

```ts
type ReviewMode = 'full' | 'closure';
type ReviewVerdict = 'approved' | 'needs-work' | 'rejected';
type ReviewClass = 'blocker' | 'execution-risk' | 'improvement';
type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low';
type ReviewStatus = 'open' | 'fixed' | 'verified' | 'reopened' | 'superseded';

interface CodeReviewDefectV1 {
  id: string;
  class: ReviewClass;
  severity: ReviewSeverity;
  confidence: 'high' | 'medium' | 'low';
  status: ReviewStatus;
  invariant: string;
  failure: string;
  evidence: string[];
  repair: string;
  affectedTargets: string[];
  introducedTargetRevision: number;
  statusTargetRevision: number;
  supersededBy: string | null;
}

interface CodeReviewReportV1 {
  version: 1;
  operation: 'cleanup-review' | 'code-review';
  targetRevision: number;
  targetFingerprint: string;
  verdict: ReviewVerdict;
  mode: ReviewMode;
  coverage: string[];
  defects: CodeReviewDefectV1[];
  residualRisks: string[];
  reviewerSessionId: string;
  closureRequestSha256: string | null;
  repairFindingOutcomes: Array<{ id: string; status: 'verified' | 'reopened' }>;
}
```

- Change the maintained source `scripts/runtime-workflow-overlays/schemas/code-review-v1.json`, regenerate `internal-workflow/schemas/code-review-v1.json` with `npm run sync:workflow`, and keep exact runtime/schema parity.
- Validator rejects unknown keys, duplicate IDs, malformed supersession, mode/session mismatch, empty required text, and `approved` with unresolved blocker/execution-risk defects.
- A report-only repair may correct envelope/schema bytes only. It cannot modify the worktree, reviewer session, operation, target revision/fingerprint, mode, or defect semantics. Its request is `{ repairOnly: true, originalReportSha256, validationDiagnostic, originalReportBytes }`; bytes are bounded/secret-scanned, the attempt has a new attempt ID, and acceptance requires identical pre/post target fingerprint.

### 3.2 Durable Direct Delivery State

Create `src/v2/direct-delivery.ts`. Existing `RunRecordV1.lifecycle`, `cycle`, implementation `reportRepairs`/`transportRetries`, `checks`, `checkedChangeSha256`, `proofId`, `proofReceipt`, and publication `intent` remain the sole owners of those concerns. Add only optional review-specific `directReview`:

```ts
interface ReviewInvocationV1 {
  attemptId: string;
  operation: 'cleanup-review' | 'code-review';
  mode: 'full' | 'closure';
  reviewerSessionId: string;
  targetRevision: number;
  targetFingerprint: string;
  closureRequestSha256: string | null;
  status: 'prepared' | 'launched' | 'abandoned';
  pid: number | null;
  processGroupId: number | null;
}

interface ReviewTrackV1 {
  version: 1;
  disposition: 'pending' | 'not-required' | 'active' | 'clear';
  profile: 'simple' | 'medium' | 'high';
  reviewerSessionId: string | null;
  mode: 'full' | 'closure' | null;
  reportRepairs: 0 | 1;
  transportRetries: 0 | 1;
  coverage: string[];
  defects: CodeReviewDefectV1[];
  affectedDefectIds: string[];
  acceptedReportSha256: string | null;
}

interface DirectReviewV1 {
  version: 1;
  status: 'active' | 'clear' | 'legacy-bypass' | 'terminal';
  stage: null | 'cleanup-full' | 'cleanup-repair' | 'cleanup-closure'
    | 'review-full' | 'review-repair' | 'review-closure';
  targetRevision: number;
  targetFingerprint: string;
  cleanup: ReviewTrackV1;
  review: ReviewTrackV1;
  invocation?: ReviewInvocationV1;
  repairFindings: Array<{
    id: string;
    provenance: 'cleanup' | 'code-review' | 'check' | 'proof';
    sourceId: string;
    targetRevision: number;
    summary: string;
    affectedContracts: string[];
    status: 'open' | 'fixed' | 'verified' | 'reopened';
  }>;
  terminalOutcome?:
    | { status: 'blocked'; kind: 'external' | 'safety' | 'exhausted' }
    | { status: 'transport-failed' | 'cancelled' | 'internal-error' };
}
```

Reviewer identity is created by the Runner and must equal the report session ID. The review-specific legal-state table is exact:

| `directReview.status/stage` | Cleanup | Code review | `RunRecord.lifecycle` |
| --- | --- | --- | --- |
| `active/cleanup-full|cleanup-repair|cleanup-closure` | `active` | `pending` | `implementing` |
| `active/review-full|review-repair|review-closure` | `clear|not-required` | `active` | `implementing` |
| `clear/*` | `clear|not-required` | `clear` | `checking|proving|publishing|review-ready` |
| `legacy-bypass/null` | `not-required` | `not-required` | `checking|proving|publishing|review-ready` |
| `terminal/<last stage or legacy null>` | preserved | preserved | exact `blocked|transport-failed|cancelled|internal-error` projection |

`stage` remains the last review stage when status is `clear`; it grants no execution authority. For non-terminal states, `stage=null` is required only for `legacy-bypass`, because that pinned legacy run never entered a review stage; every other non-terminal composite is invalid. Terminal nullability is governed exclusively by the projection rule below.

Before a terminal run CAS, clear any invocation and project `directReview.status=terminal` with the exact public terminal status/kind while preserving tracks, defects, findings, budgets, revision, fingerprint, and last non-null stage. `stage=null`, revision `0`, and both tracks `not-required:legacy-pinned-generation` are allowed exactly when projecting a prior `legacy-bypass`; every non-legacy terminal projection requires the last non-null stage. Terminal projection performs no review effect and is immutable. A run that never initialized direct review has no projection.

Track field invariants are exact: `pending` has null session/mode/hash and empty coverage/defects/affected IDs with zero budgets; `not-required` has null session/mode/hash, empty defects/affected IDs, and exactly one Runner-issued `not-required:<reason>` coverage row; `active` requires non-null session/mode and may carry canonical defects/affected IDs; `clear` requires non-null session/mode/report hash, empty affected IDs, mandatory coverage, and the clear predicate below. `RunRecord.lifecycle=safe-halt` may retain an `active` composite only with `process.purpose=cleanup-review|code-review` and `process.resumeReviewStage` equal to `directReview.stage`.

Stage-specific invariants disambiguate replay: `*-full` requires the selected track `active/mode=full`, null accepted report hash, empty affected IDs, and invocation either absent (ready to prepare) or matching `prepared|launched`; `*-repair` requires invocation absent, a non-null accepted report hash, and non-empty open/reopened defect or repair-finding IDs owned by the implementation repair; `*-closure` requires `mode=closure`, non-null prior accepted report hash, non-empty affected IDs whose defects/findings are `fixed`, and invocation absent (ready) or matching `prepared|launched`. An accepted reviewer report is merged in the same CAS that clears invocation and moves to repair, closure, or track clear; no accepted report remains in a `*-full` ready state.

- `targetFingerprint` binds HEAD, index tree, tracked/untracked hashes, changed-file list, route receipt hash, workflow generation, cycle, and frozen criteria.
- Every reviewer result is accepted only against the same target fingerprint observed after process quiescence.
- Every product edit uses the existing `cycle` as the finite repair budget, increments `targetRevision`, clears existing checks/checked-change/proof fields, and invalidates only review coverage causally affected by that edit. Exhausting `config.runner.maxCycles` is `blocked/exhausted`.
- Confirmed effects are persisted before the next stage. Replay starts at the exact durable stage and never repeats an accepted report or completed external effect.

Extend persisted `process` with `purpose: route|implementation|cleanup-review|code-review|proof`, `resumeLifecycle`, and nullable `resumeReviewStage`. The exhaustive legal mapping is: `route -> triaging + null`; `implementation -> implementing|reworking + null`; `cleanup-review -> implementing + one cleanup-* stage`; `code-review -> implementing + one review-* stage`; `proof -> proving + null`. Legacy mapping when `directReview` is absent is deterministic: `claimed|triaging|routed|waiting-human|spec-authoring` stays absent; `implementing|reworking` initializes review state only after the next valid implementation report; `checking|proving|publishing` persists `legacy-bypass` with `stage=null` because that run already crossed the old gate under its pinned workflow generation; terminal records remain immutable. For `safe-halt`, first prove the recorded process group absent, then restore the exact mapped lifecycle/stage. A purpose-less legacy process record has no persisted discriminator and, after absence is proven, terminates as `internal-error: direct-review-migration-unrecoverable`; it is never guessed. Missing/ambiguous purpose, route, workflow, resume stage, or fingerprint evidence uses the same terminal code.

### 3.3 Defect Ledger Merge

- Runner owns merge. Reviewer cannot delete an existing defect or alter its immutable `id/class/invariant/failure/introducedTargetRevision` fields.
- Full at revision R may introduce unique `open` defects with both revision fields R. A Runner repair CAS alone changes supplied `open|reopened -> fixed` and sets `statusTargetRevision=R+1`.
- Closure for revision R+1 may change only supplied `fixed -> verified|reopened`, setting `statusTargetRevision=R+1`; omitted supplied IDs are reopened. Closure may add a new `open` defect only when evidence names revision R+1 as the introducing repair.
- Only a Full or Closure report may set `open|reopened|fixed -> superseded`; it must name a distinct existing replacement ID at the same or newer revision. Chains must be acyclic and terminate at a non-superseded defect. The terminal replacement controls clearance.
- Clear means mandatory coverage is present and every non-superseded blocker/execution-risk is `verified`; improvements do not block. `approved` reports that violate this predicate are rejected.
- `closureRequestSha256` is the domain-separated hash of canonical JSON containing operation, target revision/fingerprint, sorted affected defect IDs, sorted supplied `fixed` repair-finding IDs/contracts awaiting verification, and mandatory coverage. It is persisted in the invocation and echoed by the report; Full requires null. Any mismatch rejects the report.
- Closure reports contain `repairFindingOutcomes` with exactly one sorted row for every fixed repair-finding ID hashed into the request and no others; Runner applies each explicit `verified|reopened` value. Full reports require an empty array. Missing, duplicate, reordered, or extra IDs reject the report.

### 3.4 Contained Reviewer Adapter

Extend existing `InjectedContainedReportOperation` in `src/v2/contained-report-operation.ts` to admit `cleanup-review|code-review`; add only a thin `ContainedImplementationReviewer` typed facade:

```ts
run({ operation, mode, reviewerSessionId, targetRevision, targetFingerprint,
      issue, frozenCriteria, routeReceipt, defects, affectedDefectIds,
      workflowGeneration, repairOnly, originalReportSha256,
      validationDiagnostic, originalReportBytes, signal })
  -> completed(report) | transport-failed | safe-halt | cancelled | internal-error
```

- `operation` is exactly `cleanup-review | code-review`.
- Before launch, persist `invocation.status=prepared` with the exact attempt/session/operation/mode/revision/fingerprint/Closure hash. Extend `CodexProcess` with a launch gate: after spawn it reports PID/PGID, the Runner CASes `prepared -> launched(pid,pgid)`, and only then permits prompt/stdin delivery; failed CAS terminates the child before prompt delivery. Recovery of `prepared` proves no launch gate was released and abandons it without budget debit. Recovery of `launched` first proves the exact process group absent, marks it abandoned, consumes that track's transport retry, and only then may relaunch. Accepted report and cleared invocation are one CAS. No process result is accepted from an unrecorded attempt.
- Both operations require `sandboxMode=read-only`, `worktreeAccess=read-only`, empty writable roots, `runnerPostcondition=report-only`, `network=deny`, empty hosts/MCP tools, `externalWrite=false`, approval `never`, and the existing allowlisted/scrubbed process environment. Contract tests inject GitHub/cloud credentials, network/MCP requests, external paths, worktree mutation, and mutation-plus-crash; every case fails closed.
- Full receives the complete bounded capsule. Closure receives only canonical defects, repair diff/fingerprint transition, affected IDs/contracts, and mandatory coverage.
- Runtime observes the worktree before and after every reviewer/report-repair process; any mutation is a safety terminal.
- Implementer and reviewer attempts/session IDs must differ. Code-review Full must use a fresh reviewer session independent from the implementation attempt. Closure reuses the same reviewer session ID in its prompt contract while still using a new contained process attempt.

## 4. Runner Sequence

For `direct` only:

1. Run the existing implementation operation under existing lifecycle/budgets with applicable TDD/debugging instructions derived from route artifact and repository evidence.
2. Validate implementation report and changed-file binding with the existing one report-only repair and one transport retry.
3. Run cleanup Full only when the bounded risk classifier identifies a concrete cleanup trigger; otherwise persist explicit `not-required`. `open` repair-now cleanup defects enter implementation; after the product edit the Runner marks them `fixed`, and affected Closure alone may mark them `verified`.
4. Run code-review Full through a fresh reviewer. `needs-work` with repairable blocker/execution-risk defects persists the ledger and returns to implementation. `rejected`, malformed after repair, or exhausted retry becomes a typed terminal failure.
5. After each repair, run affected-lens Closure in the same reviewer session. Closure may verify/reopen supplied defects; a genuinely repair-introduced blocker is admitted and repaired. Unchanged/no-progress Closure stops safely rather than looping.
6. Only `directReview.status=clear|legacy-bypass` reaches configured checks. Failed checks create one stable `check:<id>:<outputSha256>` repair finding and return to implementation without rerunning unrelated Full coverage.
7. Stage and mint `CheckedChange` only after all checks pass and review target fingerprint still matches.
8. Acceptance Proof `needs-rework` creates stable `proof:<proofId>:<findingHash>` repair findings, returns to implementation, and requires affected Closure plus fresh checks before another proof.
9. Review and checks bind the uncommitted worktree. After checks, the Runner stages exactly the reviewed files and mints `CheckedChange`; proof validates that staged snapshot. Only after proof passes does existing publication create one commit (no amend), then reconcile push, PR, comment, and labels through existing intents/postconditions.

No stage may map technical/check/review/proof repair to `awaiting-user`. Only `external-block` with confirmed missing capability maps to `blocked/external`; owner contention remains `requeued` before effects.

Repair-finding deduplication keys are exact: cleanup/code-review use canonical defect ID; checks use `<check id>:<outputSha256>`; proof uses `<proofId>:<findingSha256>`. Runner merges identical keys, preserves provenance/source/introduced revision, and permits `open|reopened -> fixed -> verified|reopened`; Closure omission reopens a supplied fixed finding. Sorted supplied fixed finding IDs and affected contracts are part of the Closure correlation hash and must be reflected in the report's affected defects/coverage before verification.

Budget transitions are exact and run-scoped per review track: cleanup and code-review each own one report-repair bit and one transport-retry bit; neither resets on accepted report, Closure, or target revision. A malformed report CAS consumes report repair before the repair-only launch; a second malformed report exhausts. A launched attempt lost to transport/crash consumes transport retry before replacement; a second exhausts. A merely prepared/unreleased launch consumes neither. Accepted results consume neither. Every product repair, including cleanup/review/check/proof repair, increments the existing run `cycle`; `maxCycles` exhaustion is terminal. No-progress is detected when a Closure reopens the same IDs without a target revision/fingerprint change and terminates safely without consuming unrelated budgets.

## 5. TDD Slices And Contract Test Ledger

| Invariant | First public RED proof | Exit proof |
| --- | --- | --- |
| Exact review report/schema and canonical defect ledger | `test/v2-code-review-report.test.ts` | known vectors, unknown-key/supersession/session negatives |
| Durable stage/reviewer/budget/revision validation | `test/v2-direct-delivery.test.ts` plus `test/v2-run-store.test.ts` | every legal state and impossible-state table |
| Reviewer is contained read-only and target-bound | `test/v2-runtime-reviewer.test.ts` | argv/policy/session/fingerprint and mutation negatives |
| Direct route never invokes spec operations | public `runIssue` fake E2E | operation trace contains implementation/review/check/proof only |
| Findings/check/proof rework enters correct repair and Closure | public `runIssue` fault matrix | stable IDs, same reviewer session, affected coverage only |
| Report/transport budgets are independent and durable | crash/replay table at every prepared/abandoned/result/CAS boundary | exact resume without stale report adoption or duplicate accepted report |
| CheckedChange is minted only after clear review and green checks | deferred gates test | no proof/publication before both gates settle |
| Clean packed consumer executes the full direct path | `test/v2-package-consumer.test.ts` fake process | packaged schemas/operations/modules, no local skills |
| Existing publication remains exactly-once | `test/v2-run-issue.test.ts` fault injection before/after commit, push, PR, comment, labels and each intent/CAS | observed postcondition prevents duplicate effect |

Execution slices:

- [x] Slice 1: exact report/ledger contracts and sealed schema parity.
- [x] Slice 2: durable direct-delivery state and validation/migration from the current direct lifecycle.
- [x] Slice 3: contained cleanup/code reviewer adapter and report-only repair.
- [x] Slice 4: Runner Full→repair→Closure orchestration before checks.
- [x] Slice 5: checks/proof findings feed the same seam; publication remains unchanged.
- [x] Slice 6: packed-consumer E2E, docs, and exact restart matrix: implementation launch/result/CAS; implementation report-repair intent/result/CAS; cleanup and code-review prepared/abandoned/result/acceptance CAS; check start/result/CAS; proof start/result/CAS; publication intent/effect/postcondition/CAS for commit, push, PR, comment, and labels. Assert stage, budgets, fingerprint, session, ledger, and effect counts after every replay.

## 6. Validation And Review

- Focused tests for each slice, then `npm run typecheck`, `npm test`, `npm run check:workflow`, `npm run verify:workflow`, and `npm pack --dry-run --json`.
- No repository lint or architecture-check script exists; use `docs/deep-dive.md`, ADR 0001, and the final architecture/ownership lens.
- High-risk checkpoint after durable state + reviewer adapter; final independent code review after integration.
- Do not run `npm run smoke:live` without explicit user authorization.
- Final handoff packet must include the direct E2E receipt, restart-matrix result, route→review→checks→proof→publication bindings, review defect closure, files grouped by role, skipped validation, residual risks, and commit/evidence link.

## 7. Halt Conditions

- Halt if review/cleanup requires product behavior not authorized by the direct route.
- Halt if reviewer independence cannot be proven from Runner-issued session/attempt identities.
- Halt if exact restart requires weakening existing checked-change/proof/publication freshness.
- Halt if #1229 requires implementing frozen spec authority or complex-path behavior owned by #1230/#1231.

## 8. Review Evidence

- Review profile: high.
- Architecture/Execution Full: Needs Work; nine findings repaired; affected Closure: Approved.
- Failure/Contracts Full: Needs Work; nine findings repaired through bounded affected Closures; final Closure: Approved.
- Settled contracts added by review: canonical existing state owners, legacy migration, commit timing, exact track composites, defect transitions, report correlation, launch-gated invocation recovery, repair-finding merge, budget semantics, generated workflow source, publication crash matrix, and final handoff packet.
- Implementation Decision Delta: Slice 2 added an exact terminal review projection because repository terminal lifecycles otherwise could not retain the required defect/restart evidence. It changes representation only, not routing, budgets, or terminal semantics; affected-lens Closure is required before integration.
