---
title: "Issue 1227 - typed triage and durable route decision"
created_at: "2026-07-17T18:10:00+03:00"
source_type: "issue"
source_issues:
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/1225"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/1227"
status: "completed"
execution_model: "single-agent"
spec_mode: "standard"
review_profile: "high"
review_reasons:
  - "Changes the durable Runner lifecycle and introduces an AI-owned routing artifact before every product edit."
  - "A false waiting decision or non-durable route can either block autonomous delivery or let implementation start under mutable authority."
---

## 1. Execution Context

- **Goal:** After claim and before any product edit, run package-owned read-only triage, validate and hash its exact artifact, independently review only a candidate `awaiting-user` decision, and persist one durable route that downstream direct/spec/waiting consumers can resume without rerunning triage.
- **Source Material:** #1227; approved #1226 workflow-generation and `triage-route-v1` contracts; `src/v2/run-issue.ts`; `src/v2/run-store.ts`; `src/v2/runtime.ts`; `src/v2/triage-route.ts`; `docs/adr/0001-runner-owned-loop-policy.md`.
- **Approved Scope:** `triaging` and `routed` lifecycle stages; exact V1 migration; contained triage and ambiguity-review operations; route artifact/receipt hashing; bounded malformed/rejected-candidate repair; independent retry budgets; downstream continuation registry; adversarial ambiguity corpus; no-product-edit-before-route proof.
- **Out of Scope:** GitHub waiting labels/questions/answers (#1228), cleanup/code-review direct delivery (#1229), spec author/review/freeze (#1230), complex implementation (#1231), and packed mission integration (#1232).
- **Simplest Viable Path:** Add one Runner-owned `RouteCoordinator` between worktree creation and implementation. It invokes operation snapshots from the run's pinned workflow generation, returns typed internal outcomes, and persists a strict `RouteReceiptV1`; `RunIssue` may enter a downstream continuation only from lifecycle `routed` with a verified receipt.
- **Primary Risk:** A technical choice, malformed artifact, crash, or reviewer disagreement incorrectly becomes a human question or permits implementation before a durable route.

## 2. Preconditions And Evidence

- #1226 is locally complete and supplies immutable `triage`, `ambiguity-review`, schemas, profiles, and operation policies.
- `triageRouteOutputSchema()` and `validateTriageRoute()` are frozen transport/semantic authority for the triage payload.
- Existing baseline lifecycle begins `claimed -> implementing`; this ticket inserts `triaging -> routed` and moves implementation authorization behind the routed continuation seam.
- Exact migration is two-stage. `run-store` performs structural parsing only: terminal 2.0.1 history remains readable; every nonterminal 2.0.1 record without `workflowGeneration` keeps the #1226 typed `workflow-generation-unrecoverable` failure. A nonterminal #1226 record with a generation but no route is handed to named `RunIssue.migratePreRouteRun()`: only lifecycle `claimed`, no process, no pending intent after claim reconciliation, verified pinned generation, exact base HEAD/index tree, and empty tracked/untracked diff may CAS once to `triaging/triage-ready`. `git.snapshot()` supplies the full HEAD/index/tracked/untracked/worktree evidence. Any implementing-or-later or dirty record fails typed `route-migration-unrecoverable` without mutation.
- No `.env*`, network/MCP, GitHub write, commit, push, or live smoke is allowed in triage/reviewer operations.

## 3. Frozen Interfaces

### Durable route receipt

Create `src/v2/route-decision.ts` as the sole owner of exact types, parser, canonical hashing, and transition guards:

```ts
type DeliveryRoute = 'direct' | 'spec-required' | 'awaiting-user';

interface RouteArtifactRefV1 {
  operation: 'triage';
  attemptId: string;
  artifactSha256: string;
  generationHash: string;
}

interface AmbiguityReviewRefV1 {
  operation: 'ambiguity-review';
  attemptId: string;
  candidateSha256: string;
  artifactSha256: string;
  verdict: 'approved' | 'rejected';
  generationHash: string;
}

interface RouteReceiptV1 {
  version: 1;
  route: DeliveryRoute;
  triage: RouteArtifactRefV1;
  review: AmbiguityReviewRefV1 | null;
  artifact: TriageRouteV1;
  decisionSha256: string;
  decidedAt: string;
  assumptions: string[];
}
```

Hash bytes are exact: each domain is its listed ASCII bytes followed by one NUL byte `0x00`, followed by UTF-8 bytes from the existing exported `canonicalJson()` in `src/v2/containment.ts`. Domains are `codex-orchestrator-triage-artifact-v1`, `codex-orchestrator-ambiguity-review-v1`, and `codex-orchestrator-route-decision-v1`. The decision input is the complete receipt with `decisionSha256:""`. Hashes never cover the Codex report envelope, report-path newline, or raw transport bytes. `artifact` is the validated route-specific payload retained for restart and consumers. `direct` and `spec-required` require `review:null`; `awaiting-user` requires an approved review whose `candidateSha256` equals the triage artifact hash. Unknown keys, hash drift, generation mismatch, inactive payload mismatch, duplicate assumptions, and unapproved waiting decisions fail closed.

Known-answer vector: the canonical direct artifact `{"assumptions":[],"awaitingUser":null,"blocker":null,"direct":{"behaviors":["Change behavior."],"summary":"Small change.","verification":["Run test."]},"inspectedEvidence":[{"kind":"issue","location":"#1","summary":"Read the issue."}],"specRequired":null,"status":"direct","version":1}` hashes to `b9616d55da5ad1ef72b632cda35c61663294f682bcb4787fedc32d82e0519c31`. Review `{"candidateSha256":"b9616d55da5ad1ef72b632cda35c61663294f682bcb4787fedc32d82e0519c31","evidenceReviewed":["issue"],"findings":[],"recommendation":"Proceed.","verdict":"approved","version":1}` hashes to `a15f377edd58ccb08d215dbf85b214a73d83c684bf3a98b626d14cf7fb4ff356`. A direct receipt using that artifact, attempt `attempt-1`, generation `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, `review:null`, timestamp `2026-07-17T00:00:00.000Z`, and empty assumptions hashes to `975ea4ad8c87cbc3ccbe3aeed0637e1463f52c0295f6f2191c4a5f034c09c837`.

### Durable route execution state

Extend `RunRecordV1` with optional `routeExecution` and `routeReceipt`, validated as an exact pair:

```ts
type RouteExecutionV1 = RouteBudgetsV1 & (
  | { phase: 'triage-ready'; previousAttemptId: string | null }
  | { phase: 'triage-in-flight'; attemptId: string; startedAt: string }
  | { phase: 'candidate-ready'; candidate: TriageRouteV1; triage: RouteArtifactRefV1 }
  | { phase: 'review-in-flight'; attemptId: string; startedAt: string; candidate: TriageRouteV1; triage: RouteArtifactRefV1 }
  | { phase: 'malformed-repair-ready'; findings: string[] }
  | { phase: 'candidate-repair-ready'; candidate: TriageRouteV1; triage: RouteArtifactRefV1; review: AmbiguityReviewRefV1; findings: string[] }
  | { phase: 'repair-in-flight'; attemptId: string; startedAt: string; repairInput: MalformedRepairInputV1 | CandidateRepairInputV1 }
  | { phase: 'route-complete'; triage: RouteArtifactRefV1; review: AmbiguityReviewRefV1 | null }
);

type MalformedRepairInputV1 = { kind: 'malformed'; findings: string[] };
type CandidateRepairInputV1 = { kind: 'rejected-candidate'; candidate: TriageRouteV1; triage: RouteArtifactRefV1; review: AmbiguityReviewRefV1; findings: string[] };

interface RouteBudgetsV1 {
  version: 1;
  triageRepairs: 0 | 1;
  triageTransportRetries: 0 | 1;
  ambiguityTransportRetries: 0 | 1;
  candidateReviews: 0 | 1;
}
```

- lifecycle `triaging`: `routeExecution` required and `routeReceipt` absent;
- lifecycle `routed`: both required, `routeExecution.phase === 'route-complete'`, embedded refs equal the receipt refs, and receipt verified;
- lifecycle after `routed`: receipt remains immutable and required;
- lifecycle `claimed`: both absent except an exact safe migration writes `triaging` plus initial execution state atomically.

Counters are independent. Malformed triage and rejected waiting candidate consume only `triageRepairs`. Triage transport consumes only `triageTransportRetries`. Reviewer transport consumes only `ambiguityTransportRetries`. A reviewer verdict consumes `candidateReviews`, not transport or repair. No counter can be borrowed from another class.

Before each process launch, Runner CASes the exact `*-in-flight` phase with a fresh attempt ID. A validated direct/spec result is CASed atomically to `routed/route-complete`; a waiting result is CASed to `candidate-ready`; an approved review is CASed atomically to `routed/route-complete`; a rejected review is CASed to `candidate-repair-ready`; malformed output is never persisted and writes only `malformed-repair-ready/findings`. `repair-in-flight.repairInput` preserves the complete immutable prompt input. A repair transport retry atomically increments only the triage transport counter and returns to the matching repair-ready variant before relaunch.

`RunIssue`'s repository owner lock is the single-owner invariant: it is acquired before reading/resuming route state and held until `runIssue()` exits. #1227 replaces the reclaimable filesystem lock with a token-bound Git ref CAS in the one host-global bare control store `${orchestratorHome}/v2/owner-control.git`, initialized idempotently before daemon work. Every target clone and worktree uses that exact `--git-dir`; the ref is `refs/codex-orchestrator/owners/<sha256(canonicalRepository)>`. The exact owner JSON is written there as a Git blob; acquisition from no owner is `git update-ref <ref> <newBlob> 000...`, dead-owner reclaim is `git update-ref <ref> <newBlob> <observedOldBlob>`, and release is `git update-ref -d <ref> <ownBlob>`. Git's ref transaction is the linearization point: one contender wins; a stale contender fails, rereads, and can neither replace nor remove the winner. A same-host, same-boot record whose PID is alive remains `wait`; only a same-host, same-boot record whose PID is proven absent is reclaimable; foreign host/boot, malformed blob, canonical-repository mismatch, or ambiguous liveness remains `block`. Thus a second live Runner cannot observe or abandon an in-flight phase, while a post-crash owner can acquire and recover. Only that new owner may CAS an exact matching in-flight attempt ID to its recovery state, consume that operation's transport budget, and relaunch; reports from the abandoned attempt ID are never adopted. Every adoption CAS checks lifecycle, phase, and attempt ID. Exhausted budget blocks. Owner-ref blob creation/ref updates are Runner control metadata, never worktree/product edits, and tests clean the ref.

### Internal outcome contract

`src/v2/route-coordinator.ts` exports one typed result:

```ts
type RouteCoordinatorResult =
  | { status: 'succeeded'; receipt: RouteReceiptV1 }
  | { status: 'repairable'; code: 'triage-artifact-invalid' | 'waiting-candidate-rejected'; findings: string[] }
  | { status: 'retryable'; owner: 'triage' | 'ambiguity-review'; code: string }
  | { status: 'awaiting-user'; receipt: RouteReceiptV1 }
  | { status: 'cancelled' }
  | { status: 'blocked'; kind: 'external' | 'safety' | 'exhausted'; code: string; evidence: string[] };
```

`awaiting-user` is emitted only after a validated triage candidate and approved fresh ambiguity review. `succeeded` is used for direct/spec routes. Exhausted repair/retry is never silently converted to a question.

`src/v2/contained-report-operation.ts` owns one reusable read-only launcher for `triage | ambiguity-review`:

```ts
interface ContainedReportOperation {
  run(input: {
    operation: 'triage' | 'ambiguity-review';
    attemptId: string;
    runId: string;
    worktreePath: string;
    workflowGeneration: WorkflowGenerationReceipt;
    promptFacts: string[];
    signal: AbortSignal;
  }): Promise<
    | { status: 'completed'; attemptId: string; validatedPayload: unknown; artifactSha256: string }
    | { status: 'invalid'; attemptId: string; findings: string[] }
    | { status: 'retryable'; code: string }
    | { status: 'cancelled' }
    | { status: 'blocked'; kind: 'external' | 'safety'; code: string }
  >;
}
```

It extends `prepareContainedAttempt` to manifest-declared `report-only/read-only` operations, rejects any write/network/MCP/external authority, snapshots the worktree before and after, requires identical HEAD/index/tracked/untracked fingerprints, decodes the report envelope, validates the operation payload, and hashes only canonical validated payload bytes with the exact domains above. Invalid payload returns validation findings without retaining raw payload bytes. It returns the caller-persisted attempt ID; it never writes run state.

### Extension registry

Create `src/v2/route-continuations.ts`:

```ts
interface RoutedContinuationRegistry {
  direct(input: RoutedRunContext): Promise<RoutedContinuationResult>;
  specRequired(input: RoutedRunContext): Promise<RoutedContinuationResult>;
  awaitingUser(input: RoutedRunContext): Promise<RoutedContinuationResult>;
}

interface RoutedRunContext {
  runId: string;
  issue: PersistedIssueSnapshotV1;
  frozenCriteria: PersistedFrozenCriterionV1[];
  worktreePath: string;
  workflowGeneration: WorkflowGenerationReceipt;
  receipt: RouteReceiptV1;
}

type RoutedContinuationResult =
  | { status: 'completed' }
  | { status: 'retryable'; code: string }
  | { status: 'blocked'; kind: 'external' | 'safety' | 'exhausted'; code: string; evidence: string[] }
  | { status: 'cancelled' };
```

The context contains the complete validated route payload. A continuation cannot mutate lifecycle directly. `RunIssue` derives the only legal mapping `direct→implementing`, `awaiting-user→waiting-human`, `spec-required→spec-authoring` from the verified receipt and CASes that lifecycle before invoking the matching registry method; registry selection cannot influence the mapping. The method performs consumer work only after that CAS and reports its outcome. `retryable` leaves the already-selected downstream lifecycle in place and consumes a continuation-owned budget introduced by its ticket; blocked/cancelled use the existing terminal mapping from that downstream lifecycle. During this parent implementation, #1227 registers a `deferred` test adapter only in unit fixtures; production registration is completed by #1228/#1229/#1230 before #1232. There is no shipped `not-registered` terminal placeholder.

## 4. Triage And Ambiguity Rules

- Triage prompt must require inspected issue body/comments, relevant implementation/callers/tests, repository instructions, `CONTEXT.md`, domain docs, ADRs, and existing behavior; unavailable classes are recorded as inspected absence, not omitted.
- Technical implementation, architecture, test strategy, tooling, naming, formatting, and reversible engineering choices are always resolved autonomously.
- If repository/source evidence supports one interpretation, choose it and record the assumption. If one product outcome clearly dominates on safety, compatibility, or stated product goals, choose it and record why.
- `awaiting-user` requires at least two materially different observable product outcomes, evidence for each, explicit absence of an authorized source choice, recommendation, and one focused question. Wording-only variants fail validation.
- Every waiting candidate is reviewed by a distinct `ambiguity-review` attempt ID and operation snapshot; the reviewer receives the candidate hash and evidence but not the triage process/session identity.
- Rejected candidate gets one read-only triage repair with reviewer findings and an instruction that the result must be `direct`, `spec-required`, or a genuine typed blocker. A second waiting candidate is invalid and maps to exhausted, without publishing a question.
- Reviewer `blocked` is a typed external/safety outcome; it is not approval.
- The ambiguity reviewer receives the exact candidate artifact and `candidateSha256`, uses a fresh attempt ID distinct from the triage attempt, and its validated report must echo that hash. The coordinator rejects any mismatch before persistence.

## 5. State Transitions

```text
claimed --claim reconciled + clean worktree--> triaging
triaging --valid direct/spec artifact----------------> routed
triaging --valid waiting + approved fresh review----> routed
triaging --malformed or rejected candidate----------> triaging/repair-ready (one repair)
triaging --owner-local transport---------------------> triaging (owner budget only)
triaging --external/safety/exhausted-----------------> blocked
triaging --cancelled---------------------------------> cancelled
routed ----verified receipt + Runner-derived CAS----> downstream lifecycle ----> registered consumer
```

- Persist `triaging` before the first operation launch.
- Persist the full route receipt and lifecycle `routed` in one CAS; then derive the route-to-lifecycle mapping, CAS that downstream lifecycle, and only then invoke its continuation.
- On restart in `triaging`, use the discriminated phase. Completed candidate/reviewer evidence is reused only when embedded in durable state; an in-flight attempt is abandoned and rerun only after its owner retry budget is durably consumed. No product mutation is allowed and no orphan report is adopted.
- On restart in `routed`, verify the receipt and dispatch without rerunning triage/review.
- Cancellation atomically writes terminal lifecycle/outcome `cancelled`, retains no process ownership, consumes no repair/transport/review budget, and leaves no adoptable report. Crash before that CAS follows the exact in-flight abandonment rule; crash after it resumes terminal without relaunch.
- `runImplementation`, Git snapshot intended for implementation, checks, commit, push, PR, proof, and downstream state are unreachable until verified `routed` dispatch.

## 6. Write Scope And Consumer Ownership

- `src/v2/route-decision.ts`, `test/v2-route-decision.test.ts` — exact receipt/state/hash/transition contracts; owned only by #1227.
- `src/v2/contained-report-operation.ts`, `test/v2-contained-report-operation.test.ts` — package-owned report-only process seam and worktree non-mutation proof; owned only by #1227.
- `src/v2/route-coordinator.ts`, `test/v2-route-coordinator.test.ts` — triage/reviewer sequencing, phases, budgets, adversarial corpus; owned only by #1227.
- `src/v2/route-continuations.ts` — frozen downstream interface; owned only by #1227.
- `src/v2/run-store.ts`, `src/v2/run-issue.ts`, `src/v2/runtime.ts` and their existing tests — lifecycle persistence, contained agents, registration/dispatch; #1227 performs the shared integration once.
- `src/v2/runtime.ts`, `test/v2-runtime.test.ts` — token-bound owner-ref acquisition/reclaim/release via Git ref CAS; existing non-owner locks remain unchanged.
- #1228 owns new `waiting-human/**`, config/setup labels, answer receipts, and registers only `awaitingUser`.
- #1229 owns new `direct-delivery/**` and registers only `direct`.
- #1230 owns new `spec-delivery/**`, spec store/freeze records, and registers only `specRequired`.
- Consumers may import frozen #1227 types but must not edit route parsing, counters, or transition guards. If integration forces two consumers to edit the same implementation file, root records a Decision Delta and implements them serially; otherwise #1228/#1229/#1230 may run in parallel.

## 7. Execution Slices

### Slice 1 - Route contracts and migration

- [x] RED: exact receipt/hash/state parser tests, lifecycle matrix, terminal history, safe claimed migration, and unsafe 2.0.1 active-state failures.
- [x] GREEN: implement `route-decision.ts`; extend run-store exact validation and typed `RouteMigrationUnrecoverableError`.
- [x] Exit: route/store focused tests and typecheck green.

### Slice 2 - Contained coordinator

- [x] RED: clear simple, clear complex, source-inferable missing detail, technical choice, real product ambiguity, malformed artifact, rejected candidate, transport, crash, and independent-budget corpus.
- [x] GREEN: implement package-operation triage and fresh ambiguity-review agents plus `RouteCoordinator`; no external writes and one bounded repair.
- [x] Exit: every false-wait fixture routes direct/spec, real ambiguity alone reaches approved awaiting-user, and all failure classes consume only their owner budget.

### Slice 3 - Runner integration and frozen consumers

- [x] RED: event-order tests prove `state:triaging`, operation, `state:routed`, then first product snapshot/edit; restart in triaging/routed; revocation; dispatcher identity; no orphan artifact adoption.
- [x] GREEN: integrate coordinator after reconciled claim/worktree creation; persist route receipt atomically; dispatch through `RoutedContinuationRegistry`.
- [x] Exit: no product edit is observable before durable route, direct baseline behavior remains reachable only through the direct continuation, and the three consumer registrations have disjoint ownership.

## 8. Validation And Done Criteria

### Contract Test Ledger

| Contract | First RED test / public seam | Required proof |
|---|---|---|
| Hash domains and receipt integrity | `route hash known-answer vectors use NUL domain separation` / exported route hash functions | The three fixed digests above; envelope/raw-byte changes do not alter a validated-payload hash. |
| Lifecycle parser matrix | `run store accepts only claimed, triaging, routed, downstream and terminal route invariants` / `validateRunStateFile` | `route-complete` is mandatory for routed/downstream; impossible receipt/execution pairs fail. |
| Safe migration | `migratePreRouteRun CASes only a clean claimed generation` / `RunIssue.migratePreRouteRun` | claimed-clean succeeds once; dirty, process, intent, wrong generation, implementing-or-later fail without mutation. |
| Launch/adoption CAS | `route coordinator persists in-flight before launch and adopts only matching attempt` / coordinator state adapter | crash before/after each CAS; stale and concurrent result adoption rejected. |
| Single-owner recovery | `two clones share host-global owner control ref and only one reclaims an in-flight run` / runtime owner-ref adapter plus `RunIssue.runIssue` state adapter | two distinct clones point at the same `${orchestratorHome}/v2/owner-control.git`; live same-boot PID waits; proven-dead owner is replaced only with observed-old OID; foreign/ambiguous owners block; barrier pauses A after reading dead OID, B installs live OID, then proves A's stale CAS/release fail; only B owns recovery and the abandoned-attempt budget is consumed once. |
| Malformed repair | `malformed triage persists findings only and repairs once` / coordinator + contained operation | no raw invalid payload persisted; complete prompt reconstructs after restart. |
| Rejected-candidate repair | `rejected waiting candidate preserves complete repair input` / coordinator | candidate/ref/review/findings survive ready, in-flight, transport retry, and restart. |
| Independent budgets | `each route failure consumes only its owning budget` / coordinator | boundary tests for triage repair, triage transport, review transport, and candidate review; no borrowing. |
| Cancellation | `route cancellation is terminal and budget-neutral across the persistence crash boundary` / coordinator + run store | crash immediately before/after terminal CAS has deterministic resume behavior. |
| Containment | `report-only launcher rejects authority drift and product mutation` / `ContainedReportOperation.run` | read-only/report-only manifest policy required; before/after snapshots identical. |
| Dispatch ordering | `run issue routes durably before downstream lifecycle and consumer work` / `RunIssue.runIssue` | ordered events: triaging, operation(s), routed/complete, downstream CAS, consumer. |

- [x] `npm run check:workflow` and `npm run verify:workflow` were green on the settled repository snapshot; the final source-comparison rerun later observed an unrelated concurrent change in `$CODEX_HOME/docs/agents/coding-skill-routing.md`, while the immutable bundled workflow still passed `verify:workflow`.
- [x] `npm run typecheck`.
- [x] Focused route/store/coordinator/run-issue/runtime tests.
- [x] `npm test` (200/200) and `npm pack --dry-run --json` (252 files).
- [x] `git diff --check`.
- [x] Independent high-profile correctness and spec/standards reviews converge with no open execution-risk defect.
- [x] Live smoke skipped: ticket requires no external mutation.
- [x] Final handoff includes the lifecycle migration table and continuation ownership map above; known-answer artifact hashes, the adversarial ambiguity corpus, and independent budget tests are green. Decision Delta: none; downstream consumer implementation and continuation retry budgets remain owned by #1228/#1229/#1230 as frozen in this spec.

## 9. Implementation Review State

- **Authority Artifact Kind:** approved-spec.
- **Authority Artifact Path:** `docs/implementation-specs/2026-07-17/issue-1227-typed-triage-durable-route.md`
- **Profile:** high.
- **Review Plan:** two independent Full artifact reviews (Architecture/Execution and Failure/Contracts), consolidated repair, affected-lens Closure. Implementation uses an early checkpoint after Slice 2 and final cleanup/code-review gates because the state machine and AI authority boundary are high risk.
- **Defect Ledger:** `R1227-ARCH-01..06`, `R1227-CONTRACT-01..07`, `CLEANUP-ROUTE-001..002`, `R1227-FINAL-01..05`, and `R1227-FINAL-001..006` verified closed. Final affected-lens Closures confirmed durable route safe-halt, comments on claimed restart, post-route authorization, verified migration generation, route/lifecycle binding, sanitized triage read views, and confirmed owner-ref release. No open execution-risk defect remains.

## 10. Final Action

- [ ] One focused local commit for #1227 after final validation/review.
- [ ] Add marker-idempotent GitHub completion evidence and close #1227 before enabling parallel implementation of #1228/#1229/#1230.
