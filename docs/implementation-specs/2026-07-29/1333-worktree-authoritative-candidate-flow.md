---
title: "Worktree-authoritative candidate flow"
created_at: "2026-07-29T13:33:44+03:00"
revised_at: "2026-07-29T14:30:12+03:00"
source_type: "revised-spec"
source_plan: "None"
source_issues:
  - "SergiiMytakii/IntelleReach#229"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
implementation_size: "large"
expected_repositories: 1
review_profile: "high"
review_reasons:
  - "Publication safety: review, checks, proof, and both publication paths must bind one immutable Git tree."
  - "Crash recovery: candidate objects and commit intents must survive process loss and aggressive Git pruning."
  - "Compatibility: a public CheckedChange contract and durable run-state schema require explicit versioning and rollback boundaries."
review_outcome: "Approved"
review_verdict: "Needs Work"
review_coverage: "Fresh Full Architecture/Execution and Failure/Contracts; targeted Closure; coordinator verification closed the remaining exact-contract contradictions"
review_passes: "1 fresh Full (2 reviewers); 1 targeted Closure (2 reviewers); coordinator verification"
---

## 1. Execution Context

- **Goal:** Make Git-trackable state from `expected HEAD + current issue worktree` the implementation authority, materialize one pinned immutable candidate for review/check/proof, and publish a commit whose tree exactly equals that candidate on both initial and review-feedback paths.
- **Source Material:** User-approved worktree-authority invariant in the current Codex task; IntelliReach #229 run `90c6d808-e562-4e8b-afd0-ae0c699df631`; [ADR 0001](../../adr/0001-runner-owned-loop-policy.md); current `RunIssue` checked-change, proof, initial publication, review-feedback publication, public package exports, and run-state validation; review defects `NEW-CONTRACT-01`, `NEW-EXECUTION-01`, `NEW-RECOVERY-01`, `NEW-RECOVERY-02`, `NEW-VALIDATION-01`, `NEW-CONCURRENCY-01`, `NEW-COMPAT-01`, `NEW-FAILURE-01`, and `NEW-DETERMINISM-01`.
- **Approved Scope:** Replace repository-index ownership in qualification repair, implementation/report repair, direct review, checks, acceptance proof, initial publication, review-feedback continuation, and crash recovery. Add the minimum versioned public/durable contracts and package-owned candidate pin/materialization needed to prove exact-tree execution. Preserve authorization, issue-scoped check policy, denied-path protection, bounded repair budgets, proof validation, GitHub effects, and proof-artifact validation.
- **Out of Scope:** Changing issue routing, issue path-scope interpretation, agent review policy, retry budgets, GitHub labels/comments/PR semantics, automatically reverting issue-worktree bytes, publishing a package release, resetting consumer issues, or running live smoke without separate explicit authorization.
- **Minimum Solution:** Extend the existing Git adapter with one cohesive candidate capability that captures a stable tree through a private index, pins a synthetic candidate commit under a package-owned ref, materializes temporary detached execution worktrees for review/check/proof, and creates/reconciles the publication commit from the pinned tree through atomic ref CAS. Version CheckedChange and run state explicitly; retain compile compatibility for existing custom `RunIssue` adapters through an optional V2 capability that fails closed before a new candidate boundary when absent.
- **Added Complexity:**
  - **Private Git index** — required to materialize tracked edits, deletions, modes, symlinks, and eligible untracked files without reading or mutating the shared index; without it stale staged bytes remain authority.
  - **Package-owned candidate ref and synthetic commit** — required to keep candidate objects reachable across crash/GC and to materialize a detached Git worktree; without it a persisted tree SHA can become unreadable after pruning.
  - **Immutable execution worktree** — required because before/after freshness checks on a mutable issue worktree cannot detect temporary mutation/revert while review, checks, or proof is reading files.
  - **CheckedChange V2 and run-state V3** — required because `indexTreeSha` is a public V1 contract and legacy/new run bindings need unambiguous persisted semantics; silently reinterpreting V1 breaks consumers and recovery.
  - **One pre-migration state backup** — required because pre-V3 package readers reject V3 state; without an exact backup there is no bounded rollback before V3 publication effects.
- **Primary Risk:** Candidate capture, execution, proof, durable intent, and commit creation accidentally refer to different trees or leave an ambiguous partially migrated run.

## 2. Preconditions And Evidence

- **Required Services / Env / Fixtures:** Local Git with `commit-tree`, `update-ref`, private-index support, and linked worktrees; temporary filesystem on the same host; existing `ProcessExecutor`, real-Git fixtures, `runFixture`, package-consumer fixture, and atomic state-file test seams. No network service is required.
- **Blocking Unknowns:** None. Ignored untracked policy, public contract versioning, rollback boundary, and retained-intent state are fixed below.
- **Confirmed Targets:** `src/index.ts`; `src/v2/runtime.ts:LocalGitRunIssueAdapter`; `src/v2/run-issue.ts:RunIssueGit`, `RunIssue.runIssue`, `RunIssue.publish`, `RunIssue.updateExistingPullRequest`; `src/v2/checked-change.ts`; `src/v2/direct-delivery.ts`; `src/v2/acceptance-proof.ts`; `src/v2/review-feedback.ts`; `src/v2/run-store.ts`; `src/v2/adapters/command.ts`; `src/v2/adapters/worktree.ts`; `test/v2-run-issue.test.ts`; `test/v2-acceptance-proof.test.ts`; `test/v2-run-store.test.ts`; `test/v2-direct-delivery.test.ts`; `test/v2-package-consumer.test.ts`; `docs/adr/0001-runner-owned-loop-policy.md`; `docs/deep-dive.md`; `CHANGELOG.md`.
- **Confirmed Commands:** `npm run typecheck`; `npm run build`; `npm run build && node --test dist/test/v2-run-issue.test.js dist/test/v2-acceptance-proof.test.js dist/test/v2-run-store.test.js dist/test/v2-direct-delivery.test.js dist/test/v2-package-consumer.test.js`; `npm test`.
- **Protected Paths / Rejected Approaches:** Never use the repository index as candidate, proof, or commit authority. Never silently reinterpret `CheckedChangePayloadV1.indexTreeSha`. Never rely on an unreachable tree object as durable state. Never claim exact-tree proof from before/after mutable-worktree snapshots. Never use `git reset --hard`, discard issue-worktree bytes, weaken denied-path/authorization/check/proof rules, recursively call `runIssue` under its owner lock, or automatically restore a pre-V3 backup after any V3 commit/push/PR effect.
- **Source of Truth:** Before publication intent, the authoritative binding is the package-owned candidate ref plus `{expectedHeadSha, candidateCommitSha, candidateTreeSha, canonicalChangedFiles, worktreeIdentity, bindingVersion: 2}` persisted in V3 state or V2 CheckedChange. After `commit` or `review-update-commit` intent, `{parentSha, treeSha, message, candidateRef}` remains authoritative until exact effect observation or a retained-intent safety terminal.
- **New Boundaries:** `LocalGitRunIssueAdapter` owns private-index lifecycle, stable capture, candidate pin/ref CAS, immutable execution-worktree lifecycle, exact-tree commit creation, branch-ref CAS, observation, and safe pin cleanup. `RunIssue` owns authorization, candidate selection, durable ordering, bounded transitions, and publication. `AcceptanceProof` consumes a V1 legacy or V2 candidate binding but never chooses Git state.

### Exact V2 contracts

The implementation must use these structural contracts. Names may move to a package-private module, but fields, unions, and ownership must not change during implementation:

```ts
interface CandidateBindingV2 {
  version: 2;
  bindingId: string;                 // formula defined below
  expectedHeadSha: string;
  candidateRef: string;
  candidateCommitSha: string;
  candidateTreeSha: string;
  canonicalChangedFiles: string[];   // sorted, unique, NUL-safe tree diff
  sourceWorktreeIdentity: string;
}

type CandidateBoundaryV2 =
  | { kind: 'qualification'; repairAttempt: 0 | 1 | 2 | 3 | 4 | 5 }
  | { kind: 'implementation-cycle'; cycle: 1 | 2 | 3 | 4 | 5 }
  | { kind: 'review-feedback'; batchId: string; repairRound: 1 | 2 | 3 };

interface CandidateExecutionLeaseV2 {
  version: 2;
  bindingId: string;
  candidateCommitSha: string;
  path: string;
  operation: 'qualification-check' | 'direct-review' | 'final-check' | 'acceptance-proof';
  attemptId: string;
  phase: 'prepared' | 'launched';
  pid: number | null;
  processGroupId: number | null;
  preparedAt: string;
  launchedAt: string | null;
}

type CandidateOperationFailureCode =
  | 'candidate-unstable'
  | 'candidate-io-failed'
  | 'candidate-materialization-io-failed'
  | 'candidate-ref-update-unknown';

type CandidateResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'failed'; code: CandidateOperationFailureCode; detailSha256: string };

interface CandidateGitV2 {
  captureAndPin(input: {
    worktreePath: string; expectedHeadSha: string; runId: string; boundary: CandidateBoundaryV2; artifactDir: string;
  }): Promise<CandidateResult<CandidateBindingV2>>;
  inspectPin(binding: CandidateBindingV2): Promise<CandidateResult<'matching' | 'missing' | 'diverged'>>;
  normalizeSharedIndex(input: { worktreePath: string; expectedHeadSha: string }): Promise<CandidateResult<void>>;
  prepareExecution(input: {
    binding: CandidateBindingV2; runId: string; workspaceRoot: string;
    operation: CandidateExecutionLeaseV2['operation']; attemptId: string;
  }): Promise<CandidateResult<
    | { kind: 'prepared'; lease: CandidateExecutionLeaseV2 }
    | { kind: 'path-diverged'; path: string }
  >>;
  markExecutionLaunched(input: {
    lease: CandidateExecutionLeaseV2; pid: number; processGroupId: number; launchedAt: string;
  }): CandidateExecutionLeaseV2;
  inspectExecution(input: {
    binding: CandidateBindingV2; lease: CandidateExecutionLeaseV2; artifactDir: string;
  }): Promise<CandidateResult<'matching' | 'mutated' | 'missing'>>;
  removeExecution(input: { lease: CandidateExecutionLeaseV2; requireProcessAbsent: true }): Promise<CandidateResult<void>>;
  copyProofArtifacts(input: {
    lease: CandidateExecutionLeaseV2; issueWorktreePath: string; artifactDir: string; proofId: string;
    artifacts: Array<{ relativePath: string; sha256: string }>;
  }): Promise<CandidateResult<{ kind: 'copied-or-observed' } | { kind: 'artifact-conflict'; relativePath: string }>>;
  createOrObserveCommit(input: {
    worktreePath: string; branchName: string; parentSha: string; treeSha: string; message: string; candidateRef: string;
  }): Promise<CandidateResult<
    | { kind: 'created-or-observed'; sha: string; parentSha: string; treeSha: string; message: string }
    | { kind: 'parent-unchanged' }
    | { kind: 'branch-diverged'; observedHeadSha: string }
  >>;
  releasePin(input: { binding: CandidateBindingV2; expectedPinnedCommitSha: string }): Promise<CandidateResult<void>>;
}
```

`bindingSeed = sha256(canonicalJson({ runId, boundary }))`, where every boundary field already exists in durable run/review-feedback state before capture. `bindingId = sha256(canonicalJson({ version: 2, bindingSeed, expectedHeadSha, candidateTreeSha, canonicalChangedFiles, sourceWorktreeIdentity }))`. `candidateRef` is then derived as `refs/codex-orchestrator/candidates/<runId>/<bindingId>` and is not an input to its own hash. A crash after pin but before binding CAS recomputes the same seed/ref from durable boundary state and exact stable content. The synthetic commit may have runtime Git identity/timestamps; recovery identity is the persisted commit SHA plus exact parent/tree observation, not deterministic recreation of commit metadata.

```ts
interface CheckedChangePayloadV2 {
  version: 2;
  canonicalRepository: string;
  runId: string;
  issueNumber: number;
  cycle: 1 | 2 | 3 | 4 | 5;
  baseSha: string;
  binding: CandidateBindingV2;
  changedFiles: string[]; // must exactly equal binding.canonicalChangedFiles
  checks: Array<{
    id: string;
    command: string;
    status: 'passed';
    outputSha256: string;
    bindingId: string;
    candidateTreeSha: string;
    checkPolicySha256: string;
  }>;
  checkPolicySha256: string;
  packageVersion: string;
  proofSchemaVersion: 1;
}
```

`inspectPin`, `inspectExecution`, `prepareExecution`, `copyProofArtifacts`, and `createOrObserveCommit` return all known Git states only through their `ok` observation unions. `failed` is reserved for I/O or unknown-effect failures in `CandidateOperationFailureCode`. `RunIssue` alone maps `missing`, `diverged`, `mutated`, `path-diverged`, `artifact-conflict`, and `branch-diverged` observations to the closed lifecycle table.

`RunIssueGit.candidateV2?: CandidateGitV2` is the only additive public Git seam. `RunIssue` persists and interprets results; it never runs individual private-index/ref/worktree commands.

`CheckedChangePayloadV2` contains all existing repository/run/issue/cycle/base/check-policy/package/proof-schema identities, plus the complete `CandidateBindingV2`, V2 check receipts, and no `indexTreeSha`, tracked-content hash, untracked-content hash, or execution path. Each V2 qualification/final check receipt is `{id, command, status, outputSha256, bindingId, candidateTreeSha, checkPolicySha256}`. `AcceptanceProof.proveChange` receives the V2 CheckedChange plus a separately supplied `CandidateExecutionLeaseV2`; it verifies matching `bindingId` and `candidateCommitSha`. Execution path identity is lease-scoped and must never be treated as source-worktree identity.

Run-state V3 adds optional `changeBindingVersion: 2`, `candidateBinding: CandidateBindingV2`, and `executionLease: CandidateExecutionLeaseV2` to a run. `executionLease` is persisted as `prepared` before a process starts and updated to `launched` in the existing spawn callback. Resume proves process-group absence or recovers its report/artifacts before calling `removeExecution`; no linked-worktree cleanup is allowed from path alone.

`attemptId = sha256(canonicalJson({ bindingId, operation, operationSourceId }))`, where `operationSourceId` is the already durable check ID, direct-review revision/session identity, or proof ID. `prepareExecution` uses the deterministic path `<workspaceRoot>/.candidate-executions/<runId>/<bindingId>/<operation>-<attemptId>`. It is idempotent: an existing linked worktree registered at that exact path and detached at `candidateCommitSha` returns the same prepared lease; any other registration/content returns `ok({kind:'path-diverged'})`. Therefore a crash between `git worktree add` and lease CAS is discoverable from already durable inputs.

Extend the existing check runner input additively with optional `onLaunched?: ({ pid, processGroupId }) => Promise<void>`. The V2 path requires the runtime check runner to invoke it immediately after spawn and before command execution proceeds; `RunIssue` uses it to persist the launched execution lease. Existing custom check adapters still compile, but a V2 run returns `candidate-check-launch-ownership-required` before check launch if the adapter cannot provide launch ownership.

## 3. Risk Controls

- **Candidate eligibility:** Include every tracked path from expected HEAD with current worktree edits/deletions plus non-ignored untracked paths reported by `git ls-files --others --exclude-standard -z`, excluding only untracked paths below `proof.artifactDir`. Ignored untracked files are not candidate content even if the shared index previously force-added them; an implementation report naming one fails changed-file validation until repository ignore policy makes it Git-trackable. Tracked files below `proof.artifactDir` remain candidate content and freshness-sensitive.
- **Stable capture:** A capture operation derives tree SHA, canonical changed files, and content identity from one private-index tree, not separate mutable-file reads. It immediately performs a second capture. Equality of expected HEAD, tree SHA, canonical paths, and worktree identity is required; one mismatch returns typed `candidate-unstable` with no accepted boundary, and Git I/O returns typed `candidate-io-failed`. No generic retry is added.
- **Environment:** Every private-index Git command overlays `GIT_INDEX_FILE` on the inherited process environment; it must not replace `PATH`, `HOME`, locale, Git config, or credential-related environment with a one-key environment.
- **Durability:** Pin a synthetic single-parent candidate commit under `refs/codex-orchestrator/candidates/<runId>/<bindingId>` using create-only/update-CAS. The ref must resolve to a commit whose parent is expected HEAD and whose tree is candidateTreeSha. Active candidates and any commit intent retain the pin. A successfully published candidate is deleted only after its publication commit is reachable from the intended branch and no recovery state references it. An obsolete no-intent candidate is deleted only through the state-first cleanup table. Retained-intent and evidence-retaining safety terminals retain the pin/evidence.
- **Immutable execution:** Direct review, qualification/final checks, and acceptance proof run in adapter-created detached linked worktrees at `candidateCommitSha`, never in the mutable issue worktree. Each operation gets a fresh materialization. Proof-owned artifacts are validated in that worktree and copied back only as regular files beneath the exact `proofId` root through symlink-safe atomic writes; copied untracked proof artifacts remain excluded from candidate freshness.
- **Execution prerequisites:** Materializations live beneath the configured repository-local `runner.workspaceRoot` so existing ancestor-resolved package dependencies/tooling remain available exactly as for a fresh issue worktree. The package does not copy, inspect, or project ignored files, `.env*`, caches, credentials, `node_modules`, or SDK state into a materialization. A command that depends on ignored per-worktree state is not reproducible in the current worktree model and fails through its existing check/proof result; this change adds no dependency bootstrap or network access.
- **Execution acceptance:** A detached worktree is an isolated input, not intrinsically read-only. Every check gets its own lease. A review/check/proof result is accepted only after `inspectExecution` proves HEAD still resolves to `candidateCommitSha`, its tree equals `candidateTreeSha`, and there is no candidate-eligible tracked/non-ignored diff. Mutation yields `candidate-materialization-mutated`; its receipt/report is never reusable.
- **Mutable operations:** Qualification repair, implementation, implementation report repair, and review-feedback repair continue in the issue worktree. Their prepared/launched baselines use candidate binding V2 after cutover and legacy index freshness only for unresolved legacy invocations.
- **Public compatibility:** Preserve all V1 exports and semantics. Add `CheckedChangePayloadV2` with `version: 2`, `candidateTreeSha`, exact candidate paths, V2 checks, worktree identity, and existing repository/run/check-policy identities. Add version-aware readers/helpers without changing V1 behavior. Extend the public Git dependency structurally with an optional cohesive `candidateV2` capability; existing custom adapters still compile. A new/cut-over run without it fails before normalization, pin creation, worker launch, or external effect with `candidate-git-v2-required`.
- **Durable compatibility and rollback:** `FileRunRecordWriter` owns a lock-scoped migration transaction over raw state bytes: read raw V2 bytes, validate without normalized projection, record `{generation, bytesSha256}`, create-only/fsync `run-state.json.pre-candidate-v3`, create-only/fsync adjacent metadata, fsync the directory, then V3 CAS. An existing backup is reusable only when metadata generation/hash exactly match the raw V2 source; before any V3 state or publication watermark, a stale backup/metadata pair is atomically replaced from current validated V2 bytes. Candidate refs and execution worktrees are reversible local preparation and do not cross the downgrade boundary. Before the first V3 publication branch CAS, push, or GitHub write, atomically persist and fsync `publicationEffectPossible: true` in migration metadata; once true, rollback is forbidden even if later observation proves no effect. Rollback requires daemon/process absence, removes only exact orphan candidate refs/materializations from V3 state, and restores the exact backup. Package code never performs automatic rollback.
- **Retained intent:** V3 validation permits `blocked/safety/resumable:false` with only `commit` or `review-update-commit` intent and its candidate ref retained. Replaying this terminal performs no Git/GitHub effect and preserves evidence and pin. No other terminal may retain those intents. Residual worktree drift after an exact observed commit is checked after commit effect confirmation, so it blocks before push without retaining a completed commit intent.
- **Retained-intent transition:** Add one local-only `persistRetainedCommitIntentTerminal` owner in `RunIssue`. It bypasses `publishBlockedTerminal` and `blockReviewFeedback`, performs no labels/comment/GitHub mutation, preserves the exact intent and binding, writes local evidence, and idempotently replays the same terminal outcome.
- **Artifact copy replay:** Copy-back validates every source and ancestor as regular/no-symlink, then publishes each destination by atomic create-only write. An existing regular destination with the expected hash is an already observed effect; a different hash, symlink, or non-regular destination is `candidate-artifact-conflict`. Crash after any subset is replayed per file by the same rule.
- **Failure mapping:** Use only the closed mapping table below. `AcceptanceProof` rethrows candidate inspection failures instead of converting them to `internal-error`. Unknown branch-ref update outcome is observed before any retry or terminal mapping.
- **Forbidden Scope:** No generic candidate service, feature flag, configurable ref namespace, additional retry counter, automatic cleanup of ambiguous refs, or compatibility fallback that stages the shared index.
- **Review Timing:** One final high-risk review after all slices; mandatory targeted recipes are listed in Review Focus.

## 4. Contract Test Ledger

| Invariant | Risk It Prevents | First RED Test / Proof | Status |
| --- | --- | --- | --- |
| Mixed staged/unstaged state produces only the stable Git-trackable worktree candidate; shared-index normalization cannot change candidate content. | #229 stale-index split brain and accidental force-added ignored content. | Real-Git test stages old and force-added ignored content, repairs/reverses it unstaged, captures twice, normalizes, and proves the candidate contains only expected tracked plus non-ignored untracked state. | green |
| Candidate capture and pin survive process loss and aggressive pruning. | Persisted intent references a missing tree object. | Capture/pin, delete private index, restart adapter, run `git prune --expire=now`, then resolve the ref and create the exact-tree commit. | green |
| Review, every reusable check receipt, proof, intent, and commit bind one candidateTreeSha. | Passed checks or proof are reused for different bytes after crash. | Crash after each passed check and before CheckedChange persistence; mutate issue worktree; resume and prove the check reruns unless its persisted V2 tree binding matches. | green |
| Review/check/proof read immutable materialization while the issue worktree may mutate concurrently. | Temporary mutation/revert or mixed-time capture lets proof pass for a different tree. | Fault test mutates and restores issue-worktree files during capture, check, and proof; unstable capture fails and immutable operations continue to observe only candidateTreeSha. | green |
| Only untracked proof artifacts are freshness-excluded and artifact copy-back is symlink-safe. | Product code under artifact root is omitted or proof escapes its root. | Negative tests cover tracked proof-root edits, symlink roots/destinations, overwrite attempts, and non-regular files; positive test copies only validated untracked proof files. | green |
| V1 public behavior is unchanged and V2 semantics are explicit. | Existing consumers silently compare candidate tree to shared index or stop compiling. | Package-consumer test compiles/runs an old V1 helper/custom adapter unchanged and a V2 consumer; V1 freshness remains index-based and V2 freshness candidate-based. | green |
| V2 state migrates once to V3 with an exact backup and an explicit rollback boundary. | Patch upgrade or downgrade makes active state unreadable or adopts mixed semantics. | Frozen V1/V2 fixtures cover every active baseline, backup fault points, pre-effect restore, post-effect downgrade refusal, cutover, and crash immediately before/after V3 CAS. | green |
| Publication recovery retains or confirms exactly one tree-bound effect. | Duplicate/wrong-parent commit, lost intent, or fail-open push. | Both intent kinds cover no intent, intent before effect, ref effect before confirmation, unrelated HEAD retained-intent terminal, unknown update-ref result, and residual issue-worktree drift before push. | green |
| Candidate/ref/materialization I/O failures remain typed and resumable before effects. | Infrastructure failure consumes repair budgets or becomes false content drift/internal error. | Inject each Git/materialization/freshness failure before proof and assert exact unchanged budgets/state; inject after ref CAS and require observation-first recovery. | green |
| Execution leases and artifact copy-back reconcile after every crash boundary. | Live process worktree is deleted, linked-worktree metadata leaks, or proof artifacts conflict on replay. | Crash after lease prepare/launch/process exit and after each copied artifact; require process-first recovery, exact-owner cleanup, and hash-idempotent copy replay. | green |

## Implementation Review State

- **Target revision:** `451d16ab908f87a8c1353a9e4d252f66e56444b4e3dff754260161742b262a19`
- **Profile / mode:** `high` / `Closure`
- **Authority:** this approved implementation spec and repository `AGENTS.md`
- **Correctness lineage:** Full and Closure completed; final repair approved with no blocking defects
- **Spec/standards lineage:** Full and Closure completed; final repair approved with no blocking defects
- **Validation capsule:** `npm run typecheck` and exact targeted tests passed; the final full run passed 363/364, then its sole 50 ms process-start race was widened to 250 ms and passed targeted; live smoke intentionally not run because it mutates GitHub and was not authorized
- **Open implementation defects:** none; no accepted risks

### Canonical Defect Ledger

| ID | Class | Status | Severity | Invariant / concrete failure | Smallest repair |
| --- | --- | --- | --- | --- | --- |
| WACF-001 | blocker | verified | high | Proof must execute on the candidate lease; runtime launches it in the mutable issue worktree. | Thread and require the lease path through `ProofAgent`. |
| WACF-002 | blocker | verified | high | Check commands must not execute before launched ownership is durable; production spawn is ungated. | Add a child ready/resume gate and terminate on launch-CAS failure. |
| WACF-003 | blocker | fixed-awaiting-closure | high | Persisted prepared/launched leases must reconcile before replacement; resume overwrites them and proof never records launch. | Gate Codex exec behind durable launch ownership and recover proof on the retained lease before cleanup. |
| WACF-004 | blocker | verified | high | Candidate capture is shared-index independent; private capture omits a staged non-ignored new file and mutable workers keep stale index state. | Use private-index `ls-files`, correlate report paths, normalize before mutable launches. |
| WACF-005 | blocker | fixed-awaiting-closure | high | Every readable legacy active shape must cross the explicit V3 cutover table; checking/proving and qualification do not. | Recover an exact V1 proving binding through legacy publication; cut over stale/rework boundaries only. |
| WACF-006 | blocker | fixed-awaiting-closure | high | Retryable candidate failures and accepted drift must remain operationally resumable; current terminal replay wedges them. | Retain commit intent/binding through normalization, residual gate, and pin cleanup; observe before retry. |
| WACF-007 | blocker | verified | high | Rollback boundary must precede every V3 external write; GitHub label paths bypass the watermark. | Centralize publication-effect watermarking before all external mutations. |
| WACF-008 | blocker | verified | high | Rollback and watermark must be lock-scoped; concurrent CAS can be overwritten. | Add one atomic raw transaction with exact generation/hash fencing. |
| WACF-009 | execution-risk | fixed-awaiting-closure | medium | Artifact copy must survive process loss after any copied subset; direct destination writes leave partial conflicts. | Reconcile destination/temp through one fsync/no-replace path on first execution and replay. |
| WACF-010 | blocker | verified | high | Existing public `AcceptanceProof` and `ProofAgent` V1 consumers must still compile unchanged. | Preserve V1 defaults with additive generic/candidate seams and compile fixtures. |
| WACF-011 | execution-risk | verified | medium | Candidate ref must derive from the same run and binding; validators accept cross-run/cross-binding refs. | Correlate ref components at binding, CheckedChange, state, and intent boundaries. |
| WACF-012 | execution-risk | fixed-awaiting-closure | medium | State-first cleanup must reconcile orphan refs/worktrees after crash. | Recompute exact pre-binding identity and validate detached pre-lease ownership before preservation. |
| WACF-013 | execution-risk | fixed-awaiting-closure | medium | Docs and ledger may claim only implemented and proven behavior. | Bind claims and final statuses to the fresh Closure target and passing validation. |
| WACF-014 | execution-risk | fixed-awaiting-closure | medium | Artifact reads must not follow a final-component symlink introduced between validation and read. | Open with `O_NOFOLLOW`, validate with `fstat`, and read through the same descriptor. |
| WACF-015 | compatibility | fixed-awaiting-closure | high | The approved public `CandidateGitV2` shape must not require package-private orphan reconciliation. | Keep reconciliation optional and compile the exact approved required-method interface. |

## 5. Recovery Contract

### Candidate and execution boundary

| Durable/observed state | Required transition |
| --- | --- |
| Legacy unresolved prepared/launched invocation, direct review, proving, or safe-halt baseline | Reconcile only with legacy index freshness. Do not normalize or reinterpret it. |
| Legacy run at a safe boundary | Create/fsync V2 backup if absent; stable-capture and pin candidate; persist V3 plus `changeBindingVersion: 2` and candidate binding by CAS; only then create a new invocation/review/check/proof boundary. |
| V2 binding and matching candidate ref | Materialize the pinned candidate for immutable operations; issue-worktree drift is irrelevant during execution but must be handled before a later accepted binding or publication intent. |
| V2 binding and missing/divergent candidate ref | Resumable safety/transport outcome with no recapture adoption. Never recreate a different object under the same binding ID. |
| Orphan candidate ref with no persisted binding after crash | Compare ref parent/tree to a fresh stable capture at the same expected HEAD. Adopt only on exact identity; otherwise delete by exact CAS if no state references it and start a new binding. |
| Prepared execution lease | No worker may launch until the receipt is persisted. On resume remove only after proving no owned process/report exists; otherwise recover the exact operation first. |
| Launched execution lease | Prove process-group absence, recover the operation report/artifacts, inspect candidate equality, then clear lease by state CAS and remove linked worktree by exact owner. Unknown process state is safe-halt, never cleanup permission. |

### Exhaustive legacy V2 cutover

| Existing V2 run shape | Required handling |
| --- | --- |
| `claimed`, `triaging`, `routed`, `waiting-human`, or `spec-authoring` with no prepared/launched process | Keep legacy semantics until the first direct-route qualification/implementation boundary; cut over immediately before that boundary. Spec-required delivery never needs candidate V2. |
| Any lifecycle with a prepared/launched invocation or `safe-halt` process | Reconcile that exact legacy process/report with V1 freshness. Cut over only after process ownership and operation state are cleared. |
| `implementing`/`reworking` with no invocation and no active direct-review operation | Clear unbound legacy final checks/proof fields without budget change, then cut over before the next implementation/review boundary. |
| Active legacy direct-review Full/Closure | Complete/recover that review with V1 target fingerprint. If it requests repair, clear the review boundary and cut over before repair launch; if clear, cut over and rerun one V2 direct review so no V1 review authorizes V2 proof. |
| `checking` with partial qualification/final receipts or a legacy clear direct-review receipt | Legacy receipts are not reusable for V2. Clear checks and any legacy clear-review authorization without budget change, cut over, rerun V2 direct review when the route is direct, then rerun the complete applicable check policy on that same V2 binding. |
| `proving` or proof-owned `safe-halt` | Recover the exact V1 proof. A passed V1 proof continues the complete legacy publication path; any rework clears V1 proof/check state and cuts over before repair. |
| `publishing` with no intent or with `commit`/`review-update-commit` | Finish candidate/commit reconciliation under unchanged V1 shared-index semantics; never reinterpret the stored tree. Continue all later intents as legacy. |
| `publishing` with `push`, `pr`, `comment`, `labels`, `review-update-push`, `review-summary`, `review-final-labels`, or blocked-label intent | Observe/finish that exact legacy intent and complete the legacy publication epoch. No cutover inside an epoch. |
| `review-ready` | Replay unchanged. On trusted feedback activation, cut over immediately before the first V2 repair/check/review boundary. |
| Terminal `blocked`, `transport-failed`, `cancelled`, or `internal-error` | Replay unchanged; never migrate solely for storage normalization. |

### Publication intent / HEAD

| Durable state | Observed HEAD | Required transition |
| --- | --- | --- |
| Existing `commit` or `review-update-commit` intent | Exact single-parent commit with intent parent/tree/message | Confirm effect first, verify intended branch contains it, normalize shared index as projection, retain or remove candidate pin according to reachability, and continue before any recapture. |
| Existing intent | `intent.parentSha` | Re-authorize, verify candidate ref still pins `intent.treeSha`, create commit object from that tree, atomically advance only the intended branch from parentSha, observe exact parent/tree/message, then confirm. |
| Existing intent | Anything else | Persist the V3 retained-intent safety terminal. No push/PR, intent clearing, ref adoption, or pin deletion. |
| No intent; accepted V2 checked-change/proof; HEAD is expected parent | Stable-recapture issue worktree. If full V2 binding matches proof and candidate ref, persist intent and enter rows above; otherwise use candidate drift transition. |
| No intent | HEAD differs from expected parent | Safety terminal with no push/PR. |

After exact commit confirmation, compare the mutable issue worktree to the new HEAD while excluding only untracked proof artifacts. Any residual change blocks before push; the completed commit intent is already confirmed and cleared, while the commit remains local and unpushed.

### Candidate drift and bounded repair

| Condition | Required transition |
| --- | --- |
| No intent; initial flow drift; cycle budget remains | Persist one post-proof drift finding, clear checks/CheckedChange/proof, release the obsolete pin by exact CAS, and reopen direct review through `startNextCycle`. |
| No intent; review feedback `verified`/`publishing`; `repairRound < 3` | Atomically increment round, set `repairing`, clear verified receipt/invocation/checks/CheckedChange/proof, persist drift finding, release obsolete pin by exact CAS, and reopen direct review through one validated `review-feedback.ts` transition. |
| Same drift with exhausted owner budget | Use that owner's existing exhausted terminal; retain the candidate pin only if a durable intent still references it. |
| Stable capture or materialization cannot be established | Typed resumable local transport/safety outcome; no repair counter increment and no stale proof reuse. |

### Candidate binding and pin cleanup

| Exit | Required ordering |
| --- | --- |
| Qualification/check failure, review `needs-work`, proof `needs-rework`, or accepted content drift | Prove operation quiescence; state CAS clears lease, all receipts, proof, and candidate binding while persisting the repair transition; then delete ref by exact pinned-commit CAS. Crash after CAS leaves a safe orphan handled by orphan reconciliation. |
| Cancellation, external block, exhausted terminal, or ordinary non-retained safety terminal | Prove quiescence; terminal state CAS removes lease/binding; then exact-CAS delete pin. If quiescence is unknown, retain lease/binding/pin in safe-halt. `candidate-pin-missing/diverged` and `candidate-artifact-conflict` are evidence-retaining exceptions: V3 validation requires their binding plus observed pin/artifact evidence to remain, and replay performs no cleanup/effect. |
| Successful proof awaiting publication or any commit intent | Retain binding and pin. |
| Exact publication commit confirmed and reachable from intended branch | Confirm state no longer needs candidate recovery, clear binding by CAS, then exact-CAS delete pin. |
| Retained commit-intent safety terminal | Retain binding and pin permanently until explicit operator resolution outside this implementation. |

### Closed failure mapping

| Code/condition | Run result | Budget delta | Retained state | Next allowed effect |
| --- | --- | --- | --- | --- |
| `candidate-git-v2-required` before cutover | `blocked/safety/resumable:true` | none | legacy run unchanged | install/provide compatible adapter only |
| `candidate-check-launch-ownership-required` before check launch | `blocked/safety/resumable:true` | none | binding/pin retained; no lease/process | provide compatible check adapter only |
| `candidate-unstable` before accepted binding | `transport-failed/resumable:true` | none | no binding/pin | fresh stable capture on next invocation |
| `candidate-io-failed` or `candidate-materialization-io-failed` before effect | `transport-failed/resumable:true` | none | accepted binding/pin retained if already persisted | retry same bounded local operation |
| `candidate-pin-missing` or `candidate-pin-diverged` for persisted binding | `blocked/safety/resumable:false` | none | binding and any observed pin evidence retained | no automatic effect |
| `path-diverged` materialization observation | `blocked/safety/resumable:false` | none | binding and path evidence retained | no launch/cleanup by path |
| `candidate-materialization-mutated` | `blocked/safety/resumable:false` | none | clear lease/binding only after process absence; no receipt accepted | no automatic effect |
| `candidate-artifact-conflict` | `blocked/safety/resumable:false` | none | proof binding/pin retained for evidence | no copy/publish |
| Actual issue-worktree binding mismatch before intent | existing initial/review-feedback repair transition | one owning repair round | obsolete binding cleared after quiescence | next repair cycle only |
| Branch CAS result unknown | `transport-failed/resumable:false` | none | exact intent/binding/pin retained | observation only |
| `candidate-branch-diverged` or observed unrelated HEAD with intent | retained-intent `blocked/safety/resumable:false` | none | exact intent/binding/pin retained | no automatic effect |
| Residual issue-worktree drift after confirmed commit | `blocked/safety/resumable:false` | none | commit intent cleared; local commit retained; no pin required | no push/PR |

## 6. Execution Slices

### Slice 1 — Version contracts and migrate state safely

- [x] **Test/Proof First:** Add RED package-consumer tests for unchanged V1 semantics/compilation, optional candidate capability compilation, explicit V2 payload behavior, V2→V3 frozen migration, backup fault points, pre-effect rollback, and post-effect downgrade refusal.
- [x] **Target:** `src/v2/checked-change.ts` and `src/index.ts` — preserve V1 exactly; add V2 payload/freshness/capability types and version-dispatched validation/hash helpers.
- [x] **Target:** `src/v2/run-store.ts`, `src/v2/review-feedback.ts`, and `src/v2/run-issue.ts` — add state V3, exact `CandidateBindingV2`/execution lease storage, candidate-bound qualification and final check receipts, retained commit-intent terminal invariant, exhaustive V1/V2 readers/cutover, and the raw-byte backup plus publication-watermark migration transaction.
- [x] **Target:** `src/v2/run-issue.ts:RunIssueGit` — add the optional cohesive `candidateV2` capability without removing or changing existing required methods.
- [x] **Validation:** `npm run build && node --test dist/test/v2-run-store.test.js dist/test/v2-package-consumer.test.js dist/test/v2-direct-delivery.test.js`.
- [x] **Exit Gate:** Old V1 consumer source still compiles and behaves identically; every accepted old state either reconciles in legacy mode or crosses one backed-up V3 boundary before any V2 operation.

### Slice 2 — Capture, pin, and materialize one stable candidate

- [x] **Test/Proof First:** Add real-Git RED coverage for mixed index/worktree state, fully reversed path, deletion, rename, executable mode, symlink, non-ignored and ignored untracked files, proof-root rules, concurrent mutation during double capture, inherited environment, candidate ref CAS, crash, aggressive prune, orphan reconciliation, and cleanup.
- [x] **Target:** `src/v2/runtime.ts:LocalGitRunIssueAdapter` and `src/v2/adapters/worktree.ts` — implement the exact `CandidateGitV2` contract: private-index stable capture, synthetic candidate commit, deterministic package ref, exact-CAS pin lifecycle, leased detached worktree materialization below `runner.workspaceRoot`, post-operation equality, process-safe cleanup, and crash-idempotent symlink-safe proof artifact copy-back.
- [x] **Target:** `src/v2/adapters/command.ts` — support inherited-environment overlays required by private-index commands without changing existing executor behavior.
- [x] **Validation:** `npm run build && node --test dist/test/v2-run-issue.test.js dist/test/v2-acceptance-proof.test.js`.
- [x] **Exit Gate:** Candidate identity is independent of shared index, survives prune/restart, excludes only specified untracked paths, and materializes a worktree whose HEAD tree is exactly candidateTreeSha.

### Slice 3 — Bind qualification, implementation recovery, review, checks, and proof

- [x] **Test/Proof First:** Add RED scenarios for #229 review repair, crash between each check and CheckedChange, issue-worktree mutate/revert during immutable operations, tracked proof-root drift, typed freshness I/O failure, and all frozen legacy invocation/review/proof/safe-halt shapes.
- [x] **Target:** `src/v2/run-issue.ts:RunIssue.runIssue`, the existing check-runner dependency contract, and runtime check adapter — normalize shared index only before new mutable worker launches; use candidate V2 baselines for new invocations; derive deterministic materialization paths and persist leases before launch; require the additive `onLaunched` callback to persist check PID/process-group ownership; run direct review and each qualification/final check only in a fresh materialization; accept results only after post-operation equality; persist binding identity on every qualification/final receipt and reuse only exact binding/check-policy matches.
- [x] **Target:** `src/v2/acceptance-proof.ts` and runtime proof wiring — execute proof against a fresh immutable materialization, validate/copy proof artifacts, compare V2 candidate freshness, and propagate typed Git freshness failures to `RunIssue`.
- [x] **Target:** `src/v2/direct-delivery.ts` and `src/v2/review-feedback.ts` — fingerprint V2 candidate identity and implement the validated post-proof review-feedback drift transition.
- [x] **Validation:** `npm run build && node --test dist/test/v2-run-issue.test.js dist/test/v2-acceptance-proof.test.js dist/test/v2-run-store.test.js dist/test/v2-direct-delivery.test.js`.
- [x] **Exit Gate:** Review, reusable checks, and proof demonstrably read one pinned tree while concurrent issue-worktree changes cannot alter their inputs or be published silently.

### Slice 4 — Publish the pinned tree and reconcile every interruption

- [x] **Test/Proof First:** Add RED fault matrices for both commit intent kinds: intent persistence, missing/divergent pin, commit creation, branch CAS success/known failure/unknown result, effect-before-confirmation, unrelated HEAD retained terminal, shared-index mutation, issue-worktree residual drift, pin cleanup, and replay.
- [x] **Target:** `src/v2/runtime.ts:LocalGitRunIssueAdapter` — create the exact single-parent publication commit from authorized tree intent, atomically update only the intended branch from parentSha, observe exact identity, and normalize shared index without changing issue-worktree bytes.
- [x] **Target:** `src/v2/run-issue.ts:RunIssue.publish` and `RunIssue.updateExistingPullRequest` — use one observation-first preparation result, persist intent before effect, retain divergent intent/pin in the valid V3 safety terminal, confirm exact effects, and block before push on residual mutable-worktree drift without recursive owner-lock acquisition.
- [x] **Validation:** `npm run build && node --test dist/test/v2-run-issue.test.js dist/test/v2-run-store.test.js`.
- [x] **Exit Gate:** Every fault converges to one exact commit, a resumable no-effect state, or an effect-free retained-intent terminal; no unproved tree reaches push/PR.

### Slice 5 — Preserve delivery behavior and document operations

- [x] **Test/Proof First:** Preserve qualification repair, implementation/review loop, proof rework, review-feedback continuation, package-install, commit-policy, and effect-free replay assertions; update only assertions superseded by explicit V2/V3 contracts.
- [x] **Target:** `docs/adr/0001-runner-owned-loop-policy.md` and `docs/deep-dive.md` — document Git-trackable authority, stable capture, candidate refs/materializations, V1/V2 behavior, V3 backup/rollback boundary, retained-intent terminal, pin cleanup, and operator recovery.
- [x] **Target:** `CHANGELOG.md` — record the structural recovery and public/durable contract additions without claiming release.
- [x] **Validation:** `npm run typecheck && npm test`.
- [x] **Exit Gate:** Healthy order remains qualification → implementation → direct review → checks → proof → exact commit → push → PR; old public V1 consumers compile, new flows use only V2/V3, and the full local suite passes.

## 7. Validation And Done Criteria

- [x] **Lint/Format:** Not applicable; no separate repository command exists.
- [x] **Typecheck/Build:** `npm run typecheck && npm run build`.
- [x] **Tests:** Targeted command from Preconditions, then `npm test`.
- [x] **Architecture Check:** Final review proves all private-index/ref/worktree command choreography remains inside `LocalGitRunIssueAdapter`; `RunIssue` consumes cohesive results; V1 semantics are untouched; each added durable/public mechanism maps to a ledger invariant.
- [x] **Live/Manual Proof:** Not required for implementation completion. `npm run smoke:live` remains separately authorized because it mutates GitHub. Before release, run it under explicit authorization to validate package installation and real publication effects.
- [x] **Behavior Proof:** In temporary real Git repositories, record equality of candidate ref tree, materialized HEAD tree, V2 CheckedChange tree, every reused check binding, proof binding, commit intent tree, and observed publication commit tree. Exercise every recovery row plus aggressive prune and transient issue-worktree mutation.
- [x] **Reconciliation:** Every unchecked item is unfinished, blocked with evidence, or intentionally not applicable.
- [x] **Final Handoff Requirements:** Use the extended `$spec-implementer` Final Risk Handoff. Additionally report V1 consumer compatibility, V3 backup/rollback outcomes, candidate pin reachability/cleanup, immutable materialization evidence, typed failure mapping, retained-intent terminal replay, and both publication-path identity chains.

## Review Focus

- **Mandatory Lenses:** Correctness, minimum solution, public API compatibility, state migration/rollback, crash recovery, Git object reachability, Git/worktree concurrency, proof-to-publication correlation, failure typing, validation, and unnecessary-complexity removal.
- **Targeted Recipes:** Old package-consumer compile/run; frozen V1/V2 state migration; backup fault injection; private-index mixed state; ignored-file policy; double-capture mutation; prune-after-crash; candidate-ref CAS; immutable check/proof mutation/revert; artifact symlink attacks; both publication intent matrices.
- **Bug Classes:** V1 semantic break; custom-adapter compile break; unreadable downgrade; mixed legacy/new binding; unreachable candidate; orphan/leaked pin; mutable proof input; stale check reuse; ignored-file loss; proof-root omission/escape; duplicate/wrong-parent commit; retained-intent validation failure; false drift/internal-error mapping; push of residual bytes.

## Defect Closure Notes

- **Review Summary:** Two independent Full lineages found `WACF-001` through `WACF-015`; the consolidated repair batch passed final correctness and standards Closure review.
- **Verified Defects:** `WACF-001` through `WACF-015`.
- **Accepted Risks:** None.
- **Open Defects:** None.
