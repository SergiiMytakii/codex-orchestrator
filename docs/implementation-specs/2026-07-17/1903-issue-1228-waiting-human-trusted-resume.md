---
title: "Issue 1228 - durable waiting-human and trusted resume"
created_at: "2026-07-17T19:03:02+03:00"
source_type: "issue"
source_plan: "None"
source_issues:
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/1225"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/1228"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
implementation_size: "large"
expected_repositories: 1
review_profile: "high"
review_reasons:
  - "Cross-trust-boundary GitHub comments and collaborator permissions decide whether a durable autonomous run may resume."
  - "Crash recovery spans comment publication, label transitions, answer freezing, permission revalidation, and rerouting; duplicate or stale effects can resume the wrong product outcome."
  - "The ticket changes shared durable state, retry/idempotency rules, daemon discovery, config/setup, and the route-to-continuation seam."
review_outcome: "Approved"
review_verdict: "Approved"
review_coverage: "Architecture/Execution and Failure/Contracts mandatory lenses covered; all supplied defects verified by affected-lens Closure"
---

## 1. Execution Context

- **Goal:** Publish one durable marker-bound product question only after an approved `awaiting-user` route, accept exactly one current-WRITE-or-higher answer, and resume the same run through a fresh triage cycle without duplicate GitHub effects.
- **Source Material:** Parent planning context #1225; child ticket #1228; completed #1226 workflow closure; completed #1227 route contract and commit `2898e9e`; `docs/adr/0001-runner-owned-loop-policy.md`; `CONTEXT.md`.
- **Approved Scope:** Exact `agent:waiting-human` config/setup/status/daemon behavior; immutable question and answer receipts; trusted comment/permission evaluation; bounded clarification; crash-safe comment/label/freeze/resume reconciliation; append-only waiting history; same-run reroute using the frozen answer.
- **Out of Scope:** Direct implementation/review/proof (#1229), spec author/review/freeze (#1230), complex implementation (#1231), final packed-consumer integration/live smoke (#1232), arbitrary manual-label configuration, and changes to Acceptance Proof semantics.
- **Simplest Viable Path:** Extend only `RoutedContinuationRegistry.awaitingUser()` with a waiting-state CAS capability and typed waiting outcomes. Both first dispatch and persisted `waiting-human` replay enter the same `RunIssue.continueWaitingHuman()` call path, which invokes one deep `WaitingHumanCoordinator`. `RunIssue` remains the only lifecycle owner and performs one explicit trusted-answer resume transition back to `triaging`; `RouteCoordinator` then receives the frozen answer as source evidence.
- **Primary Risk:** An old, edited, untrusted, conflicting, stale-permission, or unrelated comment resumes product work, or a crash duplicates a question/label effect and loses the exact run/question binding.

## 2. Preconditions And Evidence

- **Required Services / Env / Fixtures:** Unit/integration fakes only. Production uses the existing Runner-owned `gh` credentials. No Agent process receives GitHub credentials. No live smoke is required or authorized by #1228.
- **Blocking Unknowns:** None. GitHub REST issue comments provide immutable user/comment IDs plus `created_at`/`updated_at`; repository collaborator permission is available from `GET repos/{owner}/{repo}/collaborators/{username}/permission` through Runner-owned `gh api`. Its base `permission` is `admin|write|read|none`; `write` is the authoritative threshold and includes maintain/custom roles whose base permission is WRITE. `role_name` is not authorization input.
- **Confirmed Targets:** `src/v2/config.ts:AgentAutoConfigV1`; `src/v2/setup.ts:defaultConfig`; `src/v2/adapters/issues.ts:GitHubIssueAdapter`; `src/v2/adapters/gh-issue-adapter.ts:GhCliIssueAdapter`; `src/v2/run-store.ts:RunRecordV1`; `src/v2/route-decision.ts:validateRouteTransition`; `src/v2/run-issue.ts:RunIssue`; `src/v2/runtime.ts:createV2Runtime`; `src/v2/candidate-cli.ts:executeProductionDaemon`; `src/v2/route-continuations.ts:RoutedContinuationRegistry`.
- **Confirmed Commands:** Slice 1: `npm run build --silent && node --test dist/test/v2-waiting-human-contract.test.js dist/test/v2-config-contract.test.js dist/test/v2-setup.test.js dist/test/v2-setup-runtime.test.js dist/test/v2-setup-cli.test.js dist/test/v2-gh-issue-adapter.test.js`; Slice 2: `npm run build --silent && node --test dist/test/v2-waiting-human-coordinator.test.js dist/test/v2-run-store.test.js`; Slice 3: the same coordinator command; Slice 4: `npm run build --silent && node --test dist/test/v2-route-decision.test.js dist/test/v2-run-issue.test.js dist/test/v2-candidate-cli.test.js`; Slice 5: `npm run build --silent && node --test dist/test/v2-package-consumer.test.js dist/test/v2-cutover-contract.test.js`; final `npm run typecheck`, `npm test`, `npm run verify:workflow`, and `npm pack --dry-run --json`.
- **Protected Paths / Rejected Approaches:** Never read or edit `.env*`; no `authorAssociation`, reactions, edited comments, ambient Agent credentials, or comment text without the exact prefix as authorization; no runtime read from consumer/target skills; no live GitHub smoke; no replacement of the #1227 route parser/hash contract.
- **Ownership / New Boundaries:** `WaitingHumanCoordinator` owns waiting question/answer policy and waiting-only effect reconciliation behind the exact `run(input,state)` Interface below. `RunIssue` alone owns lifecycle and supplies a CAS closure over the active run; `GitHubIssueAdapter` is transport only. Deletion test: deleting the coordinator would spread marker, permission, grouping, budget, and crash-reconciliation policy across runtime/CLI/RunIssue, so the Module earns its Seam. Do not add another Adapter abstraction beyond the existing in-memory and `gh` adapters.

### Config V2 Cutover

The config schema string remains `codex-orchestrator.agent-auto`, but the exact version becomes `2`. `github.labels` gains required key `waitingHuman` with exact default `{ name:"agent:waiting-human", color:"5319e7", description:"Waiting for an authorized product answer." }`. All five configured label names must be distinct. Runtime accepts only version 2. `setup configure` is the sole version-1-to-2 migration: after acquiring setup ownership it re-reads exact V1 bytes, proves no active/ambiguous V2 owner and no OPEN issue with the configured V1 running label, proves the four preserved names plus default waiting name are distinct, preserves every V1 field, adds only `version:2` and `waitingHuman`, and atomically writes config last. Collision returns typed `unsupported-schema` with reason `Config V1 label names collide with agent:waiting-human.` and performs no write. Dry-run reports `migrate-config-v1-to-v2`; success returns new typed setup outcome `migrated`; `setupOutcomeExitCode(migrated)` is `0`. A crash before config rename leaves V1 intact; after rename V2 is complete. `prepare-labels` then creates the missing waiting label idempotently.

V1 operational behavior is exact and does not call runtime/daemon loops: `doctor` and `status` render schema `codex-orchestrator.agent-auto-setup-result`, version 1, result `{status:"legacy-detected",reason:"Config V1 requires setup migration."}` and exit 20. `run` renders schema `codex-orchestrator.agent-auto-run-result`, version 1, result `{status:"migration-required",fromVersion:1,requiredAction:"setup --target <absolute-target>"}` and exits 20. `daemon --once` renders that same single run-result and exits 20; ordinary daemon also renders it once and exits 20 instead of polling invalid config. `RUN_ISSUE_STATUSES`, `RunIssueResult`, and `runIssueExitCode` include `migration-required`. Tests cover active owner/running issue, collision, repeated migration, byte-stable repeat, exact CLI envelopes/exits, missing label, and crash-before/after atomic rename.

### Frozen Waiting Contracts

Create `src/v2/waiting-human.ts` as the sole parser/hash/rendering owner for these exact V1 contracts:

```ts
type RepositoryPermission = 'none' | 'read' | 'write' | 'admin';

interface WaitingQuestionV1 {
  version: 1;
  generation: 1 | 2;
  questionId: string;
  questionSha256: string;
  routeDecisionSha256: string;
  workflowGenerationHash: string;
  priorQuestionSha256: string | null;
  conflictHashes: string[];
  marker: string;
  answerPrefix: string;
  bodySha256: string;
  recommendation: string;
  question: string;
}

interface WaitingQuestionReceiptV1 {
  question: WaitingQuestionV1;
  commentId: string;
  commentUrl: string;
  authorId: string;
  author: string;
  createdAt: string;
  observedAt: string;
}

interface TrustedAnswerReceiptV1 {
  version: 1;
  questionId: string;
  questionSha256: string;
  commentId: string;
  commentUrl: string;
  authorId: string;
  author: string;
  permission: 'write' | 'admin';
  permissionCheckedAt: string;
  commentCreatedAt: string;
  commentUpdatedAt: string;
  observedAt: string;
  normalizedAnswer: string;
  normalizedSha256: string;
  duplicateCommentIds: string[];
}
```

`questionId` is `q-` plus the first 20 lowercase hex characters of SHA-256 over domain `codex-orchestrator-question-id-v1\0` and canonical JSON `{runId,generation,routeDecisionSha256,workflowGenerationHash}`. Construct hashes acyclically:

1. Build exact semantic preimage `{version:1,generation,questionId,routeDecisionSha256,workflowGenerationHash,priorQuestionSha256,conflictHashes,recommendation,question}`. `conflictHashes` is sorted/unique.
2. `questionSha256` is domain `codex-orchestrator-question-v1\0` plus canonical JSON of that semantic preimage.
3. `marker` is exactly `<!-- codex-orchestrator:waiting-question:<questionId>:<questionSha256> -->`; `answerPrefix` is exactly `Answer <questionId>:`.
4. Render exact UTF-8 body, including the final LF: `<marker>\n\n<question>\n\nRecommendation: <recommendation>\n\nReply with exactly this prefix:\n<answerPrefix>\n`.
5. `bodySha256` is ordinary SHA-256 of those exact body bytes. It is not part of the semantic preimage.

Generation 1 uses the approved triage candidate recommendation/question, `priorQuestionSha256:null`, and `conflictHashes:[]`. Generation 2 has exactly one of two sources: (a) a conflict uses fixed Runner text `recommendation="Resolve the conflict with one authoritative answer."`, `question="Conflicting authorized answers were received. What single product outcome should this run implement?"`, the generation-1 hash as `priorQuestionSha256`, and sorted distinct answer hashes as `conflictHashes`; or (b) a fresh independently approved `awaiting-user` route after an insufficient but trusted answer uses that candidate's recommendation/question, the prior question hash, and `conflictHashes:[]`. A third question is forbidden and yields non-resumable `blocked/exhausted`.

Known vector: run ID `11111111-1111-4111-8111-111111111111`, generation 1, route hash 64 `a` characters, workflow hash 64 `b` characters, recommendation `Choose A.`, and question `A or B?` produce question ID `q-adbe0439f3b75af520bf`, question hash `d0c26a94d5e5f98a38aac6f150ce0162f0dc8c56d6590ca4ca453f89095cd23d`, and body hash `2c50a37864c26b93d0050c20f8b0f0c7466c442e971f362077f3c10ab13141bb`.

Normalize only the answer text after the exact prefix: convert CRLF/CR to LF, apply Unicode NFC, trim leading/trailing Unicode whitespace on every line, remove leading/trailing empty lines, and join with LF. Do not case-fold or collapse internal whitespace. Empty normalized text is insufficient. Hash domain is `codex-orchestrator-answer-v1\0` plus exact normalized UTF-8 bytes. Sort candidate comments by numeric GitHub database ID represented as a decimal string; reject non-decimal REST IDs. Equivalent trusted answers share `normalizedSha256`; the earliest ID is canonical and later IDs are sorted in `duplicateCommentIds`. More than one trusted hash is a conflict and creates generation 2; a second conflict exhausts clarification without freezing an answer.

### Durable Waiting Execution

Add optional `waitingHuman` to `RunRecordV1`, strict-parsed by `src/v2/waiting-human.ts`:

```ts
type WaitingHumanExecutionV1 = {
  version: 1;
  clarificationAttempts: 0 | 1;
  permissionRetries: 0 | 1;
  effectRetries: { questionComment: 0 | 1; waitLabels: 0 | 1; resumeLabels: 0 | 1; revokeLabels: 0 | 1 };
  history: Array<{
    routeReceipt: RouteReceiptV1;
    question: WaitingQuestionV1;
    questionReceipt: WaitingQuestionReceiptV1 | null;
    answerReceipt: TrustedAnswerReceiptV1 | null;
    conflictHashes: string[];
  }>;
} & (
  | { phase: 'question-ready'; question: WaitingQuestionV1 }
  | { phase: 'question-comment-intent'; question: WaitingQuestionV1 }
  | { phase: 'question-published'; questionReceipt: WaitingQuestionReceiptV1 }
  | { phase: 'wait-labels-intent'; questionReceipt: WaitingQuestionReceiptV1 }
  | { phase: 'awaiting-answer'; questionReceipt: WaitingQuestionReceiptV1 }
  | { phase: 'answer-frozen'; questionReceipt: WaitingQuestionReceiptV1; answerReceipt: TrustedAnswerReceiptV1 }
  | { phase: 'resume-labels-intent'; questionReceipt: WaitingQuestionReceiptV1; answerReceipt: TrustedAnswerReceiptV1 }
  | { phase: 'resume-ready'; questionReceipt: WaitingQuestionReceiptV1; answerReceipt: TrustedAnswerReceiptV1 }
  | { phase: 'revoke-labels-intent'; questionReceipt: WaitingQuestionReceiptV1; answerReceipt: TrustedAnswerReceiptV1; reason: 'permission-revoked' }
  | { phase: 'resumed'; trustedAnswer: TrustedAnswerReceiptV1 }
  | { phase: 'history-only'; terminalOutcome: { status:'blocked'; kind:'external'|'safety'|'exhausted' } | { status:'cancelled' } }
);
```

Budgets are independent. Each GitHub effect consumes only its named retry after an authoritative unsatisfied postcondition; permission transport/ambiguous/stale receipts consume only `permissionRetries`; clarification consumes only `clarificationAttempts`. No budget may borrow from another. `history` is append-only and at most two entries. `resumed` is valid only with lifecycle `triaging`, `routed`, `implementing`, or `spec-authoring`; active variants through `revoke-labels-intent` require lifecycle `waiting-human` and an active awaiting-user receipt; `history-only` is required with terminal `blocked|cancelled` when waiting history exists, and its embedded outcome must equal the run terminal outcome's status/kind. The parser rejects every other lifecycle/phase pair. Active question/answer fields bind the last history inputs, current route decision, run identity, and pinned workflow generation. A frozen answer never changes after later comments or edits.

Every terminal transition from waiting uses one `RunIssue.archiveWaitingAndTerminal()` CAS. It derives the current question from `question` or `questionReceipt.question`, includes a nullable publication receipt for pre-comment failure, includes the frozen answer whenever present, and appends one history entry keyed by `questionSha256`. If the same hash is already last, every non-null field must equal and no duplicate is appended; any mismatch safety-blocks. That same CAS writes `phase:'history-only'`, the exact terminal outcome projection, lifecycle/outcome evidence, and clears no immutable receipt. There is no intermediate state where current question/answer evidence is absent. This rule applies from `question-ready`, all effect intents, `awaiting-answer`, `answer-frozen`, and `resume-ready`.

`WaitingHumanCoordinator` has this exact Interface:

```ts
interface WaitingHumanState {
  read(): Promise<WaitingHumanExecutionV1 | undefined>;
  compareAndSwap(expected: WaitingHumanExecutionV1 | undefined, next: WaitingHumanExecutionV1): Promise<boolean>;
}
type WaitingHumanResult =
  | { status:'awaiting-answer'; questionId:string; answerPrefix:string }
  | { status:'resume-ready'; answer:TrustedAnswerReceiptV1 }
  | { status:'retryable'; owner:'github-effect'|'permission'; code:string }
  | { status:'blocked'; kind:'external'|'safety'|'exhausted'; resumable:boolean; code:string; evidence:string[] }
  | { status:'cancelled' };
run(input:RoutedRunContext, state:WaitingHumanState, signal:AbortSignal): Promise<WaitingHumanResult>;
```

`route-continuations.ts` changes only `awaitingUser` to accept the state capability and return `WaitingHumanResult`; direct/spec signatures remain frozen. `RunIssue.continueWaitingHuman()` is the one call path for both newly routed and persisted waiting runs. It maps `awaiting-answer` to public `{status:'awaiting-user',questionId,answerPrefix,evidencePath}` without terminal state (exit 0), `retryable` to public resumable `transport-failed` without terminalizing waiting state (exit 70), `blocked` to the exact terminal blocked outcome (exit 20), `cancelled` to cancelled, and `resume-ready` to the trusted transition. Repeated public replay returns the same awaiting-user receipt without effects.

### Effect Recovery Table

| Effect phase | Persist before invoke | Success postcondition | Rejection / unknown delivery | Authoritative drift | Exhaustion |
| --- | --- | --- | --- | --- | --- |
| `question-comment-intent` | Full question/marker/body hash | Exactly one REST comment with exact marker/body, numeric-string ID, immutable author ID, and unedited timestamps | Observe first. Ambiguous observation leaves phase/counter unchanged and returns retryable. Authoritative absence CAS-increments `questionComment` before one reinvoke. | Multiple marker comments, body/hash mismatch, or pre-question timestamp -> non-resumable safety block. | Authoritative absence after consumed retry -> resumable external block; never publish labels. |
| `wait-labels-intent` | Exact relevant label postcondition | OPEN + auto + waiting, without running/blocked/review/manual | Same observe-before-reinvoke rule using `waitLabels`. | Closed/auto removed/manual/review/conflicting claim -> non-resumable safety cancellation. | Resumable external block while retaining question evidence. |
| `resume-labels-intent` | Frozen answer and exact relevant label postcondition | OPEN + auto + running, without waiting/blocked/review/manual | Same observe-before-reinvoke rule using `resumeLabels`. | Revoked issue authority -> non-resumable safety block. | Resumable external block; frozen answer remains immutable. |
| revocation after resume labels | `revokeLabels` intent | auto + blocked, without running/waiting/review | Same observe-before-reinvoke rule using `revokeLabels`. | Conflicting terminal/manual/review state is preserved and run cancels without overwriting it. | Non-resumable safety block with reconciliation evidence. |

All CAS increments happen before reinvocation. No rejected Promise is assumed delivered or undelivered. The host-global owner remains held until observation/CAS settles.

### GitHub Observation And Permission Seam

Extend `GitHubIssueComment` with decimal-string `author.id` and exact `updatedAt`. Production comment pagination uses `gh api --paginate --slurp` with a jq projection that converts REST numeric comment/user IDs to decimal strings before Node JSON parsing; unsafe numbers and non-decimal IDs fail closed. Change `postComment()` to return the observed `GitHubIssueComment`; production posts then rereads by marker when `gh issue comment` does not expose the REST ID. Add `getRepositoryPermission(login, expectedAuthorId)` returning `{ permission:'none'|'read'|'write'|'admin', checkedAt, userId }`; production calls `gh api repos/<owner>/<repo>/collaborators/<login>/permission`, uses only base `permission`, requires response `user.id === expectedAuthorId`, maps 404 to authoritative `none`, maps 403/429/5xx/transport to retryable, and maps malformed/unknown 2xx to safety block. `role_name` is ignored. Tests use a fake command executor to prove exact argv, pagination/projection, IDs above `Number.MAX_SAFE_INTEGER`, timestamps, 404/403/malformed mapping, post-reread, and user-ID mismatch.

The coordinator performs one `listAllComments()` observation, then permission-checks only exact-prefixed, unedited (`createdAt === updatedAt`), post-question (`createdAt > questionReceipt.createdAt`) candidates. A permission receipt must be at or after the observation timestamp and its immutable user ID must match the comment. Base `write|admin` is trusted; lower permission means an initial candidate is ignored. Immediately before resume labels, and again after their postcondition is observed, re-read the exact canonical comment and issue and re-check the same immutable author ID/current login/permission. Transport/ambiguous/stale retains waiting/resume intent and retries without Agent work. Authoritative permission below WRITE after freeze persists revocation-label intent, reconciles to auto+blocked without running/waiting, and ends non-resumable `blocked/safety`; restoring labels or permission never resurrects that run. After the final WRITE+ check no external wait occurs before the local reroute CAS.

### Same-Run Resume Contract

Extend the #1227 route owner rather than bypassing it. `route-decision.ts` adds one explicit `validateTrustedAnswerResumeTransition(previous,next,waitingHuman)` that permits only:

```text
waiting-human + verified awaiting-user receipt + resume-ready trusted answer
  -> triaging + initialRouteExecution() + no active routeReceipt
```

The prior receipt and question/answer are first appended to immutable history and phase becomes `resumed`; all other receipt removal remains rejected. `RunIssue` atomically persists the fresh issue snapshot, `triaging`, `initialRouteExecution()`, cleared active receipt, and retained history after the resume-label postcondition and final permission/comment revalidation. The next triage prompt includes `trustedAnswer=<canonical TrustedAnswerReceiptV1>` and `priorWaitingRoute=<decisionSha256>`. If triage again yields approved `awaiting-user`, the coordinator creates generation 2; direct/spec dispatch proceeds normally. Lifecycle matrix is exact: active waiting variants only with `waiting-human`; `resumed` with `triaging|routed|implementing|spec-authoring`; terminal outcomes retain immutable history but no active question. This is the only same-run reroute path.

Known-live owner contention is a typed pre-run requeue, as #1228 requires. Extend `owner-control-lock.ts` to distinguish `live-contention` from malformed/foreign/ambiguous ownership. `RunIssueResult` adds `{status:'requeued',reason:'owner-contention',evidencePath}` with exit 0; daemon leaves labels/state untouched and may revisit on its next poll. Foreign host/boot, malformed owner, ambiguous liveness, or token mismatch remain safety blocks. No other blocked result becomes requeued.

## 3. Contract Test Ledger

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| Setup/config require exactly one configured `agent:waiting-human` label in addition to existing labels. | Consumer silently treats waiting as blocked or runnable. | RED `v2-config-contract: waiting label is required and exact-key validated`; setup golden. | green |
| A question is bound to run, route decision, workflow generation, generation number, exact marker/body, and one observed comment. | Unrelated or duplicate comment resumes a run. | RED `v2-waiting-human-contract: known hash vector and marker collision matrix`. | green |
| Only unedited post-question exact-prefix comments with current WRITE+ permission participate. | Old, edited, association-only, or untrusted input authorizes product work. | RED adversarial candidate table in `test/v2-waiting-human-coordinator.test.ts`. | green |
| Equivalent answers choose earliest numeric comment ID; different hashes conflict; frozen receipt is immutable. | Nondeterministic answer choice or late edit changes product authority. | RED grouping/freeze/replay tests. | green |
| Every comment/label effect persists intent phase before invocation and reconciles marker/postcondition after crash. | Duplicate question or wrong labels after daemon restart. | RED crash matrix at every waiting phase. | green (question/wait-label phases) |
| Permission/effect/clarification budgets are independent and exhaustion has exact resumability. | One transient class steals retries or becomes a product question. | RED separate-budget matrix. | green |
| Waiting daemon discovery requires a matching durable waiting record and marker; generic blocked issues never resume. | Daemon revives an unrelated or manually blocked run. | RED candidate daemon fixture. | green |
| Trusted resume archives the old receipt, restores exact labels, and reruns triage with the frozen answer before product work. | Product implementation starts under the stale awaiting-user receipt. | RED public `runIssue` event trace through question -> answer -> reroute. | green |
| Closure/auto removal/manual-or-review conflict/repository mismatch/conflicting claim cancels without resurrection. | Revoked authority is regained by label restoration. | RED revocation and no-resurrection matrix. | green |
| Question hashing is acyclic and byte-exact for both generation sources. | Executor invents body bytes or self-referential hashes. | RED known vector and generation-2 fixed-template vectors in `test/v2-waiting-human-contract.test.ts`. | green |
| Waiting coordinator has one CAS Interface and exact outcome mapping on initial dispatch and replay. | Replay bypasses the coordinator or terminalizes retryable waiting. | RED `initial and persisted waiting use the same continuation path` in `test/v2-run-issue.test.ts`. | green |
| `resumed` history-only state is valid through reroute/direct/spec and active variants are rejected there. | Strict parser cannot represent post-resume state or accepts stale active authority. | RED lifecycle/parser matrix in `test/v2-run-store.test.ts`. | green |
| Immutable author ID survives login changes and is revalidated after resume labels. | Permission is checked for a different account or revoked after effect. | RED `same login with different user ID is rejected and renamed same user is revalidated` in `test/v2-waiting-human-coordinator.test.ts`; command: Slice 3 command. | green |
| V1 config migrates atomically to exact V2 only without active ownership/running claims and five distinct labels. | Package upgrade makes valid consumer state unreadable, aliases waiting to authorization, or races a run. | RED `setup configure migrates exact V1 once and rejects waiting-label collision` in `test/v2-setup.test.ts`; command: Slice 1 command. | green |
| Known live owner contention requeues while ambiguous ownership fails closed. | Ordinary contention becomes blocked or ambiguous ownership runs twice. | RED `known live owner requeues without labels while ambiguous owner blocks` in `test/v2-run-issue.test.ts`; command: Slice 4 command. | green |
| REST IDs remain exact above `Number.MAX_SAFE_INTEGER`. | Earliest-answer ordering or identity binding changes by numeric rounding. | RED `REST projection preserves oversized comment and user IDs as decimal strings` in `test/v2-gh-issue-adapter.test.ts`; command: Slice 1 command. | green |
| Revocation intent and terminal history are strict durable variants. | Crash after permission revoke cannot reconcile labels or parser drops immutable waiting evidence. | RED `revocation intent survives restart and terminal history rejects active phases` in `test/v2-run-store.test.ts`, plus `terminal CAS archives question exactly once from wait-label, resume-label, and revoke-label intents` in `test/v2-run-issue.test.ts`; commands: Slices 2 and 4. | planned |
| Permission retry exhaustion is independent and leaves no model/effect work. | Repeated ambiguous auth borrows an effect/clarification retry or resumes anyway. | RED `permission retry exhaustion blocks without consuming effect or clarification budgets` in `test/v2-waiting-human-coordinator.test.ts`; command: Slice 3 command. | green |
| V1 operational commands have one typed migration-required output. | Daemon polls invalid config or CLI exits inconsistently. | RED `V1 run and daemon emit one migration-required result and exit 20` in `test/v2-candidate-cli.test.ts` plus `migrated setup outcome exits zero` in `test/v2-setup-cli.test.ts`; commands: Slices 1 and 4. | green |

## 4. Risk Controls

- **Source of Truth:** `WaitingHumanExecutionV1` is the only waiting state; GitHub labels/comments are projections and external effect receipts. `RunIssue` remains the only lifecycle owner; `route-decision.ts` remains the route-transition owner.
- **Safety Constraints:** Agent processes receive no GitHub credentials; all permission reads/comments/labels are Runner effects. Never trust association/reactions/comment edits. Revalidate OPEN, canonical repository, `agent:auto`, exact question marker, no `agent:manual`/`agent:review`, matching claim, and current permission before resume.
- **Contract Constraints:** Existing route artifact/receipt hashes remain byte-compatible. Waiting adds an append-only history and one explicit resume transition; it may not weaken normal receipt immutability or #1227 budgets.
- **Concurrency / State Constraints:** Host-global owner lock remains held across each coordinator invocation. Every external effect follows the recovery table. Only proven same-host/same-boot live contention returns `requeued`; ambiguous ownership remains safety-blocked.
- **Forbidden Scope:** No direct/spec pipeline implementation, no generic workflow engine, no third question generation, no low-permission cancellation before an answer was frozen, no live smoke, no compatibility fallback to old config/state.
- **Early Review Gate:** After the waiting contract/coordinator slices are green and before CLI/daemon integration, run a high-risk `$code-review` checkpoint focused on duplicate side effects, comment ordering, current permission, receipt immutability, retry isolation, and the sole resume transition.
- **Final Handoff Requirements:** Return contract implemented, checkpoint findings/fixes, invariant-to-test proof, full validation, skipped live checks, residual risks, and files grouped by contract/coordinator/integration/tests/docs. A separate report file is not required.

## 5. Write Scope Summary

- `src/v2/waiting-human.ts` — Create; strict V1 contracts, hashing, rendering, normalization, grouping, and parsers.
- `src/v2/waiting-human-coordinator.ts` — Create; waiting state machine, GitHub observation/effect reconciliation, permission and clarification budgets.
- `src/v2/config.ts`, `src/v2/setup.ts`, `src/v2/setup-runtime.ts`, `src/v2/setup-cli.ts` — Update; exact config V2, fenced V1 migration, `migrated` outcome/exit, configured label, and doctor/setup label proof.
- `src/v2/adapters/issues.ts`, `src/v2/adapters/gh-issue-adapter.ts` — Update; timestamps, returned comment identity, current collaborator permission.
- `src/v2/run-store.ts`, `src/v2/route-decision.ts`, `src/v2/route-continuations.ts` — Update; strict waiting persistence, typed coordinator state/result seam, and sole trusted-answer resume transition.
- `src/v2/owner-control-lock.ts` — Update; distinguish proven live contention from ambiguous ownership without weakening CAS/token safety.
- `src/v2/run-issue.ts`, `src/v2/runtime.ts`, `src/v2/candidate-cli.ts`, `src/v2/cli-contract.ts` — Update; coordinator registration, waiting result/replay, exact daemon discovery, same-run reroute.
- `test/v2-waiting-human-contract.test.ts`, `test/v2-waiting-human-coordinator.test.ts`, `test/v2-gh-issue-adapter.test.ts` — Create; contract vectors, adversarial answers, budgets, crash matrix, and exact production adapter commands/parsing.
- `test/v2-setup-cli.test.ts` and existing focused V2 config/setup/store/run/candidate CLI tests — Update only where their public fixtures/contracts change.
- `README.md`, `docs/deep-dive.md`, `CONTEXT.md`, `CHANGELOG.md` — Update only for #1228 waiting/trusted-resume behavior; do not document sibling pipelines as complete.

## 6. Execution Slices

### Progress Discipline

- [x] Update this checklist and Contract Test Ledger from `planned -> red -> green` during execution.
- [x] Leave blocked work unchecked with a concrete `Blocked:` note. No implementation work remained blocked.
- [x] Confirmed not triggered: repo reality did not require replacing #1227 route hashes/parser, giving an Agent GitHub authority, or adding a third question.
- [x] Keep each slice vertical and prove RED through the named public Interface before implementation.

### Slice 1 - Exact waiting authority and config contract

- [x] **Test/Proof First:** Add failing known-vector/parser/normalization/grouping tests and failing config/setup golden tests for `agent:waiting-human`.
- [x] Implement `waiting-human.ts`; extend exact config/default label/doctor checks and comment/permission transport types.
- [x] Prove old/edited/no-prefix/empty/association-only comments cannot become candidates.
- [x] **Exit Gate:** run the exact Slice 1 command from Confirmed Commands; old route known-answer vectors remain unchanged.

### Slice 2 - Durable question publication and waiting labels

- [x] **Test/Proof First:** Add a failing coordinator event trace for `question-ready -> persisted comment intent -> exact observed comment -> persisted label intent -> agent:auto + agent:waiting-human`, plus crash-before/after each effect.
- [x] Implement `WaitingHumanCoordinator` first-question path and strict waiting-state persistence.
- [x] Reconcile marker collision, duplicate marker, body/hash drift, partial label update, transient transport, and owner restart without duplicate effects.
- [x] **Exit Gate:** run the exact Slice 2 command; the coordinator reaches `awaiting-answer` exactly once and replay performs no second comment/label effect.

### Review Checkpoint 1 - Waiting authority

- [x] Run one independent high-risk `$code-review` after Slices 1-2 stabilize, before resume integration.
- **Review Focus:** auth/permission freshness; duplicate side effects; ordering and partial failure; numeric comment ordering; hash/domain separation; immutable receipts; independent budgets; source-of-truth ownership; no Agent GitHub authority.

### Slice 3 - Trusted freeze, conflict, and revocation

- [x] **Test/Proof First:** Add failing adversarial table for exact-prefix candidates, same-hash duplicates, conflicting hashes, stale/transport permission, post-freeze permission revocation, generation-2 clarification, and exhausted second conflict/insufficient reroute.
- [x] Freeze only the earliest canonical trusted answer from one atomic comment observation; persist duplicates and permission receipt.
- [x] Keep transient/ambiguous/stale permission in waiting with no model/effect; ignore initially low-permission candidates; cancel only when a previously frozen author is authoritatively below WRITE at resume revalidation.
- [x] Create at most one new immutable question generation for conflict or a second approved awaiting-user route.
- [x] **Exit Gate:** run the exact Slice 3 coordinator command; trusted/untrusted/conflict/budget matrix passes and late comments/edits do not change a frozen receipt.

### Slice 4 - Same-run labels, reroute, and daemon discovery

- [x] **Test/Proof First:** Add failing public `runIssue` trace from approved waiting route through question publication, daemon replay, trusted answer, resume-label effect, archived prior receipt, fresh triage with trusted answer, and a resulting direct/spec route; assert no implementation before the fresh route.
- [x] Add the sole trusted-answer transition in `route-decision.ts`; wire coordinator through `RunIssue`/runtime and add typed CLI result/replay.
- [x] Daemon may invoke waiting resume only for an OPEN auto issue whose durable record is `waiting-human` and whose exact marker/label pair matches; generic blocked/manual/review/mismatched records are skipped or cancelled as specified.
- [x] Reconcile closure, auto removal, manual/review conflict, repository mismatch, conflicting claim, owner contention, and crash before/after answer freeze and resume labels.
- [x] **Exit Gate:** run the exact Slice 4 command; fake daemon-to-reroute E2E passes with one run ID, one question generation, one frozen answer, no duplicate effect, and no stale-route product edit.

### Slice 5 - Documentation and packed contract proof

- [x] **Test/Proof First:** Extend packed-consumer assertions to prove the new runtime files/config label are shipped without local skills; this is packaging proof, not the final #1232 mission E2E.
- [x] Update docs/changelog only for implemented #1228 behavior.
- [x] Run focused tests, `npm run typecheck`, `npm test`, `npm run verify:workflow`, and `npm pack --dry-run --json`.
- [x] **Exit Gate:** run the exact Slice 5 command plus all final commands; all #1228 criteria have green proof or a concrete blocked note; live smoke remains explicitly skipped because the ticket says it is a separate release gate.

## 7. Halt Conditions

- [x] Confirmed not triggered: trusted resume remained append-only and preserved #1227 route hash/parser bytes.
- [x] Confirmed not triggered: GitHub comment identity/timestamps and collaborator permission are obtained through the Runner-owned adapter.
- [x] Confirmed not triggered: no contained Agent receives `gh`/credentials and association/reactions/edits grant no authority.
- [x] Confirmed not triggered: daemon resume distinguishes matching durable waiting state from generic blocked/manual state.
- [x] Confirmed not triggered: automated acceptance did not require live GitHub mutation; live smoke remains the separate release gate.

## 8. Validation And Done Criteria

- [x] **Lint/Format:** Not applicable; repository has no lint script.
- [x] **Typecheck:** `npm run typecheck`.
- [x] **Tests:** focused waiting/config/setup/run/daemon tests, then full `npm test` (231/231).
- [x] **Architecture Check:** Not applicable; repository has no architecture-check script. Used `docs/deep-dive.md`, ADR 0001, and final code-review ownership lens.
- [x] **Workflow/Package:** `npm run verify:workflow`; `npm pack --dry-run --json`.
- [x] **Live/Manual Validation:** Not applicable for AFK #1228; `npm run smoke:live` is explicitly skipped because it mutates real GitHub state and remains a later release gate.
- [x] **Behavior Proof:** One fake-backed daemon flow publishes one question, accepts one current-WRITE+ answer, restores exact labels, reroutes the same run with the frozen answer, and survives every durable-boundary restart without duplicate effects.
- [x] **Final Reconciliation:** Every acceptance criterion maps to a green automated proof or explicit blocked note; no sibling-ticket behavior is absorbed.
- [x] **Final Handoff Requirements:** Report contract implemented, high-risk checkpoint, main invariants, review findings/fixes, validation, skipped checks, residual risks, and files by role.

## 9. Defect Closure Notes

- **Execution Decision Delta (2026-07-17):** The approved `resumed` lifecycle list ended at `implementing|spec-authoring`, while the existing direct path necessarily continues through `reworking|checking|proving|publishing|review-ready`; `history-only` likewise represented only blocked/cancelled. That made successful trusted direct delivery impossible without dropping immutable waiting history. The minimal representational correction retains `resumed` through all non-waiting delivery phases and projects immutable `history-only` through every terminal lifecycle. No authorization, route, budget, or effect policy changed. Public same-run reroute and terminal-history tests are the proof.

- **Final Code Review Closure (2026-07-17):** Independent review found and closed: second approved awaiting-user activation, orphan waiting-label eligibility, no-wait final authority boundary, final permission retry persistence, revocation-label retry/conflict reconciliation, V1 running-claim recheck under setup ownership, and the routed-to-waiting lifecycle transition for generation 2. Two proposed findings were disproved with direct jq and caller-flow evidence. Typecheck and the full suite passed after closure.

- **Review Summary:** Seven Adapter passes across two fresh sessions: two parallel Full reviews, two Architecture/Execution Closures, and three Failure/Contracts Closures. Verified: `NEW-EXEC-01`, `NEW-DET-01`, `NEW-ARCH-01`, `NEW-ARCH-02`, `NEW-EVID-01`, `NEW-VAL-01`, `NEW-EXEC-02`, `NEW-CONTRACT-01`, `NEW-STATE-01`, `NEW-PERSISTENCE-01`, `NEW-FAILURE-01`, `NEW-AUTH-01`, `NEW-AUTH-02`, `NEW-CONCURRENCY-01`, `NEW-PERSISTENCE-02`, and `NEW-LEDGER-01`.
- [x] Every stable Defect Ledger ID is verified; no accepted execution risk remains.
- **Open Defects:** None.

## 10. Final Action

After approval, execute this spec only through `$spec-implementer`. Preserve its checklist, Contract Test Ledger, Implementation Review State, Review Plan, and Defect Ledger. Create one focused commit referencing #1228 only after all gates pass; then post marker-idempotent GitHub evidence and close #1228 before starting a dependent ticket.
