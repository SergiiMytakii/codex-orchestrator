---
title: "Codex Orchestrator v2 Spec 2: autonomous recovery"
created_at: "2026-07-16T22:53:24+03:00"
source_type: "plan"
source_plan: "/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-16/1655-agent-auto-v2-rewrite.md"
source_issues:
  - "None"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_profile: "high"
review_reasons:
  - "Recovery changes durable lifecycle generations, retry budgets, process quiescence, and package-version cycle identity."
  - "Publication reconciliation must prevent duplicate commits, pushes, PRs, comments, and label transitions after ambiguous delivery or crash."
review_outcome: "Waived"
review_verdict: "Not run; independent artifact and code review waived by user"
review_coverage: "Root executable self-checks cover state ownership, retry accounting, process quiescence, publication idempotency, and Interface stability"
approved_content_sha256: "01bd32ff1f234fa9fa6f479412911b7925ed4067d84e835c63b03d627f057727"
source_plan_sha256: "e6dd64cdc7dbd3bec1c2734782b314443335822e8523591758230c71c6d2f6aa"
---

## 1. Execution Context

- **Goal:** Deepen the settled V2 tracer into a bounded, resumable `RunIssue` lifecycle that repairs ordinary agent failures in the same worktree and reconciles every runner-owned publication effect exactly once.
- **Source Material:** Plan slice 3 in `/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-16/1655-agent-auto-v2-rewrite.md`, master spec `1906-agent-auto-v2-master.md`, and completed Spec 1 `1907-agent-auto-v2-core-tracer.md`.
- **Approved Scope:** Same-worktree check/proof rework; one schema-guided malformed implementation/proof report repair; one unchanged-baseline transport retry; five total implementation/proof cycles; durable resume; package-version-safe next-cycle snapshots; exact intent reconciliation for claim, commit, push, PR, comment, and labels; exhaustive candidate CLI JSON/exit mapping.
- **Out of Scope:** Browser/Android/iOS evidence collection; Setup; daemon polling; live GitHub mutation; live smoke; self-improvement; public bin/export cutover; Legacy migration; multi-host ownership.
- **Simplest Viable Path:** Keep `RunIssue` as the only policy owner, extend its durable record with bounded counters and cycle inputs, resume the newest nonterminal record for the exact repository/issue/worktree, and add observation methods only at real Git/GitHub seams.
- **Primary Risk:** Repeating an effect whose delivery succeeded but whose confirmation write failed, or starting a new Codex attempt while the previous process/output/worktree is not quiescent.

## 2. Risk Controls

- **Source of Truth:** `RunIssue` alone chooses lifecycle transitions, cycle/repair/transport counters, rework prompts, publication intents, remote observation, and reconciliation. `run-store.ts` only validates and atomically persists caller-supplied generations.
- **Safety Constraints:** No real GitHub repository, daemon, live smoke, package publication, or external production command. Tests use temporary Git/bare remotes and in-memory GitHub adapters.
- **Contract Constraints:** Public `runIssue({ targetRoot, issueNumber })`, `proveChange({ proofId, issue, frozenCriteria, checkedChange })`, nominal `CheckedChange`, and sanitized `ProofReceipt` shapes remain unchanged. No platform/storage parameters cross those Interfaces.
- **Concurrency / State Constraints:** One host-global owner stays held until every process, check, proof, store write, and invoked side effect settles. Retry starts only from a verified baseline and never exceeds configured budgets.
- **Forbidden Scope:** No generic workflow graph, retry framework, event-sourcing layer, multi-host protocol, force push, compatibility state reader, prose-error routing, or caller-owned reconciliation.
- **Review Decision:** All independent review checkpoints are user-waived. At each checkpoint root runs the named executable matrix and records outcome `Waived`; no self-check is represented as reviewer approval.
- **Final Handoff Requirements:** Report implemented recovery contract, counters and idempotency invariants, self-check checkpoints, validation, skipped live gates, accepted shared-auth risk, residual risks, commits, and files by role.

## 3. Confirmed Targets And Contracts

- `src/v2/run-store.ts` — capability-neutral durable record validation/CAS; extend cycle, repair, transport, attempt identity, issue snapshot/criteria identity, and exact intent data without transition policy.
- `src/v2/run-issue.ts` — sole recovery/rework/publication reconciliation owner; retain the stable public call.
- `src/v2/runtime.ts` — concrete Git/GitHub observation adapters and cycle-aware contained implementation/proof attempts.
- `src/v2/acceptance-proof.ts` and `src/v2/proof-store.ts` — proof-internal report repair and same-binding resume only; no lifecycle capability.
- `src/v2/cli-contract.ts` — versioned JSON envelope and total status-to-exit mapping for the candidate surface.
- `test/v2-run-store.test.ts`, `test/v2-run-issue.test.ts`, `test/v2-acceptance-proof.test.ts`, `test/v2-codex-process.test.ts`, and focused new V2 tests — public Interface and Adapter proofs.
- Commands: `npm run build`, focused `node --test` against compiled V2 tests, `npm run typecheck`, `npm test`, `npm pack --dry-run --json --ignore-scripts`, `git diff --check`.

## 4. Contract Test Ledger

| Invariant | First RED proof | Status |
| --- | --- | --- |
| Existing matching nonterminal state resumes in the same worktree/run instead of claiming or creating a second run. | `runIssue` crash-resume Interface matrix | green |
| Failed checks and `needs-rework` proof feed exact findings to a new implementation cycle in the same worktree; cycle 5 exhausts without publication. | bounded same-worktree rework Interface test | green |
| One malformed report repair and one unchanged-baseline transport retry use separate counters and do not consume an implementation cycle; changed baseline blocks retry. | repair/transport counter matrix | green |
| No retry, terminal transition, or owner release occurs before process/check/proof/store/effect quiescence. | deferred/safe-halt/orphan matrix | green |
| Each publication intent is persisted before invocation and reconciled from exact local/remote observation after restart; matching effects are reused and divergence fails closed. | before/after every effect crash matrix | green |
| A package/schema change on resume starts a new recorded cycle and snapshot; an active snapshot remains immutable. | package-version resume test plus packed snapshot proof | green |
| Every `RunIssueResult` maps to one versioned CLI JSON status and exact exit code without prose parsing. | exhaustive CLI contract test | green |
| Store/proof capabilities cannot choose lifecycle or mutate each other's state. | strict schema/capability tests | green |

## 5. Execution Slices

### Progress Discipline

- [x] Update leaf checklist and ledger statuses during execution.
- [x] Begin every behavior slice with a failing public-seam test and preserve the observed RED reason.
- [x] Use local checkpoint commits only after exit gates pass; Slices 1-4 shared the same state-machine files, so they were committed as one settled implementation checkpoint. Never push.
- [x] Stop if implementation requires changing the approved Module Interfaces or granting proof/setup a run-record capability.

### Slice 1 — Durable resume and legal lifecycle

- [x] **Test/Proof First:** Add RED tests that seed each nonterminal lifecycle/intent and call only `runIssue`; assert exact run/worktree reuse, no duplicate claim, legal next transition, terminal replay, and fail-closed identity/config/worktree mismatch.
- [x] Extend `RunRecordV1` with bounded `cycle`, `reportRepairs`, `transportRetries`, immutable issue/frozen-criteria identity, current attempt/package/schema identity, and exact recoverable phase evidence.
- [x] Make `RunIssue` find and resume the unique matching record after owner acquisition and authorization; reject duplicate/ambiguous records and state that cannot be reconciled.
- [x] Keep transition legality private to `RunIssue`; store tests prove only shape, generation CAS, and state invariants.
- [x] **Exit Gate:** focused run-store/runIssue resume suite, typecheck, architecture scan, and `git diff --check` pass.

### Self-Check Checkpoint 1 — state ownership

- [x] Root self-check hunts illegal transitions, counter drift, duplicate run creation, stale package/criteria reuse, proof capability leakage, and lock release before settlement. Independent review outcome remains `Waived`.

### Slice 2 — Same-worktree autonomous repair

- [x] **Test/Proof First:** Add RED public tests for check failure -> rework -> pass, proof `needs-rework` -> rework -> pass, exact five-cycle exhaustion, malformed implementation/proof report repair, clean transport retry, changed-baseline refusal, cancellation, and package-version next-cycle identity.
- [x] Pass typed cycle/rework/repair context to contained implementation/proof agents without changing `runIssue` or `proveChange` Interfaces.
- [x] Persist counters and findings before launching the next attempt; clear stale checks/proof identity when returning to implementation.
- [x] Keep report repair separately bounded at one and transport retry separately bounded at one; neither increments implementation cycle until a new implementation attempt is actually admitted.
- [x] **Exit Gate:** focused rework/repair/transport and process-quiescence suites pass with exact durable counters.

### Slice 3 — Exact publication reconciliation

- [x] **Test/Proof First:** Add RED crash points immediately before invocation, after matching effect but before confirmation CAS, and after confirmation for claim labels/comment, deterministic commit, lease-protected push, draft PR, handoff comment, and terminal labels.
- [x] Extend concrete Adapters only with required observations: local commit parent/tree/message, remote branch SHA, open draft PR head/base/marker, issue comments by marker/body digest, and complete label state.
- [x] On resume, reuse only exact matching effects; invoke only when absent and safe; fail closed on unexpected commit/remote SHA/PR marker/comment digest/label divergence; never force push.
- [x] Persist one intent before each effect and clear it only after exact observation confirms completion.
- [x] **Exit Gate:** complete crash/idempotency matrix proves one commit/push/PR/handoff/terminal-label effect and no later effect after divergence.

### Self-Check Checkpoint 2 — publication safety

- [x] Root self-check hunts ambiguous-delivery duplication, missing authorization refresh, intent clearing before observation, force-push paths, stale remote reads, comment/PR marker collisions, and CAS failure after effect. Independent review outcome remains `Waived`.

### Slice 4 — Candidate CLI outcome contract and reconciliation

- [x] **Test/Proof First:** Add RED exhaustive table over every `RunIssueResult` variant and blocked kind; assert versioned JSON bytes and exit `0 | 20 | 21 | 70 | 130`.
- [x] Implement one pure candidate result-envelope renderer and total exit mapper in `cli-contract.ts`; daemon/self-improvement consumption remains future work.
- [x] Rerun immutable Interface-shape, containment, packed-consumer, and no-old-runtime-import checks.
- [x] **Exit Gate:** all focused V2 tests, full tests, typecheck, pack dry-run, architecture scan, and diff check pass.

## 6. Halt Conditions

- [x] Stop if a retry cannot prove prior process/output/worktree quiescence or exact unchanged baseline.
- [x] Stop if persisted intent cannot be reconciled from exact local/remote state without guessing delivery.
- [x] Stop if a matching run has foreign repository/issue/worktree/base/criteria identity or duplicate active records exist.
- [x] Stop if exact recovery requires force push, destructive reset, real GitHub mutation, or changing stable Module Interfaces.
- [x] Stop if package-version change would execute old recorded hashes with new package bytes.

## 7. Validation And Done Criteria

- [x] Focused RED/GREEN tests cover every ledger row.
- [x] `npm run typecheck` passes.
- [x] Full `npm test` passes.
- [x] `npm pack --dry-run --json --ignore-scripts` contains the candidate recovery modules and unchanged V1 public bin.
- [x] `git diff --check` passes.
- [x] Architecture scan finds no old coordinator/graph/app-server/migration import under `src/v2`.
- [x] Independent cleanup/code review is explicitly `Waived`; root self-check fixes are integrated and affected/full validation rerun.
- [x] Every checklist/ledger row is green, blocked with evidence, or explicitly not applicable.

## 8. Implementation Review State

- **Profile:** high.
- **Plan:** Independent artifact, checkpoint, cleanup, and final code review waived by the user. Root executes two named self-check matrices plus final validation.
- **Pass History:** Independent passes: none; outcome `Waived`. Root self-check checkpoint 1 covered state/counter/capability ownership; checkpoint 2 covered exact effect observation and ambiguous-delivery restart; final self-check covered all 64 focused V2 tests and 774 repository tests.
- **Verified Defects:** None.
- **Accepted Risks:** `S2-REVIEW-WAIVER-001` — independent review omitted by direct user instruction; executable self-checks are evidence but not approval.
- **Open Defects:** None.

### 8.1 Execution Evidence

- **Implementation Outcome:** GREEN. Check/proof failures re-enter the same worktree, cycle 5 exhausts, implementation and proof report repair are separately bounded, clean transport gets one retry, and package/skill changes advance the durable cycle.
- **Recovery Outcome:** GREEN. Terminal replay, interrupted claim, interrupted implementation, and publication restart all preserve one run. Matching commit/push/PR/comment/labels are observed and reused; divergence safety-blocks without force push.
- **Self-Check Fixes:** Transport budget no longer resets between cycles; GitHub reads inside claim/publication are normalized to resumable transport evidence; proof attempts enforce unique IDs and one repair/retry purpose; final effect confirmation remains behind exact observation.
- **Validation:** Focused V2 `64/64`; full repository `774/774`; `npm run typecheck`; `git diff --check`; architecture import scan; packed-consumer; `npm pack --dry-run --json --ignore-scripts`; real `npm run test:v2-containment`.
- **Skipped Live Gates:** Real GitHub/live smoke, daemon, mobile runtime, package publication, and public cutover are outside Spec 2.
- **Checkpoint Commits:** `7e44502` — combined Slices 1-4 implementation checkpoint because the same state-machine files own all four vertical behaviors. Documentation reconciliation follows separately.

## 9. Final Action

After completion, update this checklist and the master ledger/status, report the exact checkpoint commits and validation, and state explicitly that browser/mobile proof, Setup, live smoke, self-improvement, and public cutover remain future specs.
