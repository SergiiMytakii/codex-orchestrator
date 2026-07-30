---
title: "Issue #1243 canonical Run state and recovery cutover"
created_at: "2026-07-30T11:33:00Z"
revised_at: "2026-07-30T12:08:00Z"
source_type: "issue"
source_plan: "None"
source_issues:
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/1243"
status: "completed"
execution_model: "single-agent"
spec_mode: "full"
implementation_size: "large"
expected_repositories: 1
review_profile: "high"
review_reasons:
  - "Durable recovery: every report, mutable worker, check, proof, and publication effect changes owner in one clean state cutover."
  - "Trust and concurrency: unsupported bytes and the preflight-to-owner-lock race must remain completely effect-free."
review_outcome: "Approved"
review_verdict: "Approved"
review_coverage: "Parallel high-profile Full, repaired-revision fresh Full, and targeted Closure over Architecture/Execution, Failure/Contracts, determinism/evidence, sequencing/ownership, validation, safety, and completion"
review_passes: "2 Full rounds (2 reviewers each); 1 targeted Closure with affected continuation"
completion_proof: "1134-issue-1243-proof.md"
---

## 1. Execution Context

- **Goal:** Replace parallel operation-specific lifecycle owners with one exact
  `codex-orchestrator.run-state` aggregate containing at most one
  `ActiveAttempt` and one `PendingEffect`, while preserving current direct,
  spec, waiting-question, proof, publication, and post-PR behavior.
- **Source Material:** GitHub #1243 as implementation authority; #1242 only for
  parent invariants and explicit exclusions; [B0 baseline](1132-issue-1243-b0.md);
  `CONTEXT.md`; ADR 0001 and ADR 0002; current `src/v2/`, adapters, and tests.
- **Approved Scope:** Clean-cut the durable state schema; centralize process
  identity/result adoption/absence/cleanup; make operation-specific records
  semantic Run data only; move proof recovery into Run state; replace all
  effect intents with one pending-effect owner; preserve resource locks, pins,
  materializations, and device leases as finite resources.
- **Out of Scope:** #1244 same-Run spec delivery; #1245 removal of qualification,
  Full/Closure, and post-PR semantic lifecycle; compatibility readers,
  migrations, converters, backups, dual-write, version negotiation, release,
  push, production daemon restart, and live smoke.
- **Minimum Solution:** Make `RunRecord` the sole phase/budget/receipt authority;
  store one generic operation-neutral attempt and one typed finite effect on it;
  keep operation result validators at their existing semantic seams; keep
  repository/atomic locks, candidate materialization, and device leases outside
  progression; delete every superseded owner in the same slice that adopts the
  replacement.
- **Added Complexity:** None. The generic attempt and pending effect replace
  existing parallel owners; they do not wrap or coexist with them.
- **Primary Risk:** A stale preflight read or an operation-specific invocation
  survives the cutover and permits duplicate launch, result adoption, cleanup,
  or effect settlement.

## 2. Preconditions And Evidence

- **Required Services / Env / Fixtures:** Node.js and local Git only. Reuse
  `runFixture`, atomic-file fault seams, candidate real-Git fixtures, contained
  report fixtures, process identity/PID reuse fixtures, daemon discovery
  fixtures, and proof fixtures. No network or live GitHub mutation is required.
- **Blocking Unknowns:** None. #1243 fixes the schema identifier, owner
  cardinality, rejection timing, and clean-break policy.
- **Confirmed Targets:** `src/v2/run-store.ts`; new replacement module
  `src/v2/active-attempt.ts`; new shared process observation module
  `src/v2/process-identity.ts`; `src/v2/run-issue.ts`; `src/v2/runtime.ts`;
  `src/v2/codex-process.ts`; `src/v2/candidate.ts`;
  `src/v2/contained-report-operation.ts`; `src/v2/route-coordinator.ts`;
  `src/v2/spec-delivery.ts`; `src/v2/direct-delivery.ts`;
  `src/v2/review-feedback.ts`; `src/v2/acceptance-proof.ts`;
  `src/v2/proof-store.ts` (delete); `src/v2/cli-contract.ts`; `src/v2/cli.ts`;
  `src/index.ts`; affected `test/v2-*.test.ts`; ADR 0001. Repository search
  confirms `internal-workflow/` has no Run-state or recovery contract; worker
  operation/report schemas are therefore preserve-and-verify, not generated
  write scope for #1243.
- **Confirmed Commands:**
  `npm run build --silent && node --test dist/test/v2-run-store.test.js dist/test/v2-run-issue.test.js dist/test/v2-acceptance-proof.test.js dist/test/v2-contained-report-operation.test.js dist/test/v2-check-runtime.test.js dist/test/v2-codex-process.test.js dist/test/v2-cli.test.js dist/test/v2-config-contract.test.js dist/test/v2-candidate-contract.test.js dist/test/v2-route-coordinator.test.js dist/test/v2-spec-delivery.test.js dist/test/v2-direct-delivery.test.js dist/test/v2-review-feedback-contract.test.js dist/test/v2-runtime-codex.test.js`;
  `npm run typecheck`; `npm run check:workflow && npm run verify:workflow`;
  `npm test`.
- **Protected Paths / Rejected Approaches:** Do not read or use
  `docs/deep-dive.md`; do not edit #1235/#1242; no legacy reader, migration,
  converter, backup, reset path, version field, dual-write, compatibility
  runtime, workflow engine, queue, cache, classifier, retry coordinator,
  generic plan interpreter, or operation-mode switch inside process recovery.
- **Source of Truth:** A fresh exact-schema state reread after repository owner
  lock is the only progression authority. The preflight receipt contains only
  classification and raw-byte SHA-256 for race detection; decoded preflight
  state is never passed to CAS, phase selection, budget spend, launch, cleanup,
  or effects.
- **New Boundaries:** `src/v2/active-attempt.ts` owns the deep, operation-neutral
  `prepare -> launch -> observe -> adopt -> cleanup -> clear` transition
  interface and exact validator. `src/v2/process-identity.ts` owns portable
  process-start observation. `RunRecord.activeAttempt` is the only worker/check
  process owner and `RunRecord.pendingEffect` is the only unfinished
  local/Git/GitHub effect owner. `RunIssue` chooses semantic operations and
  validates/adopts their results. Candidate materialization and device lease
  identities are resources referenced by the attempt, not process or phase
  owners.

### Exact public unsupported-state contract

```ts
type RunIssueResult =
  | { status: 'state-schema-unsupported' }
  | /* the other current result branches */;
```

`renderRunResultJson` emits exactly
`{"result":{"status":"state-schema-unsupported"},"schema":"codex-orchestrator.agent-auto-run-result","version":1}`
through the existing `canonicalJson` key ordering.
No reason, path, evidence ID, or raw-state hash is public. Direct CLI exit is
`20`, matching an operator-actionable blocked safety condition. Daemon continues
the remaining frozen candidates and aggregates this result through the existing
maximum exit-code rule. `RUN_ISSUE_STATUSES` and exhaustive switches include the
new status. A race that never stabilizes returns
`{ status: 'requeued', reason: 'state-changed' }`, exit `0`, with no evidence or
other effect.

### Exact preflight and post-lock contract

`RunRecordWriter.inspect()` returns one internal receipt:

```ts
type RunStateInspection =
  | { status: 'absent'; rawSha256: null }
  | { status: 'supported'; rawSha256: string; state: RunStateFile }
  | { status: 'unsupported'; rawSha256: string };
```

The decoded `state` is omitted from the preflight value passed into progression;
only `status/rawSha256` survive as the race receipt. Initially `unsupported`
returns before repository owner-lock acquisition. After the lock, `inspect()`
is called again. Equal identity progresses from that fresh decoded state. On
`absent -> supported`, `supported -> absent`, or supported A -> supported B, the
Runner performs exactly one additional post-lock inspection: two equal
post-lock receipts progress from the second fresh value; another change returns
`requeued/state-changed`. Any post-lock `unsupported` returns
`state-schema-unsupported`. The owner-control write is allowed only in this
race case; issue/Git/GitHub/evidence/worktree/cleanup/launch/budget effects stay
zero.

### Exact ActiveAttempt contract

`ActiveAttempt` has no product phase or retry counter. Its `operationId` is an
opaque, non-empty semantic ID validated by the caller; the kernel never switches
on it. Each prepared attempt persists a fresh non-semantic UUID
`incarnationId`; `attemptId = sha256(canonicalJson({ runId, operationId,
operationSourceId, incarnationId }))`, where `operationSourceId` is already durable Run data
(route revision, spec revision/session, implementation cycle/report-repair bit,
review target/session/format-repair index, check ID plus policy hash, or proof ID
plus report-repair bit).

- `prepared` owns exact attempt paths and optional candidate materialization or
  device-lease references; it has no PID.
- `launched` adds `{host, bootId, pid, processGroupId,
  processStartIdentity}`, where the last field is exactly
  `{kind:'linux-start-ticks', value:string}` on Linux or
  `{kind:'unavailable', platform:'darwin'}` on Darwin. The Darwin sentinel can
  never prove `same`. After `prepared`, the caller revalidates current claim
  authorization immediately before every `launched` CAS. Revocation closes and
  settles the start gate with zero semantic spend. `CodexProcess` and
  configured-check supervision obtain process-start identity before the gate
  opens and persist this transition before stdin/command execution. Unknown
  identity rejects the gate and settles the child without semantic work.
- `observed` is written only after process observation is `absent` or `reused`
  **and** process-group observation is `absent`; leader absence/reuse with a
  live or unknown PGID remains launched and permits observation only. Observed
  records either `result: null` or exact
  `{path, sha256}` under the attempt-owned root. `same` yields without state
  change; `unknown` fails closed and permits observation only.
- `adopted` is CAS-written atomically with the operation's semantic receipt and
  exactly-once budget receipt. CAS loss rereads: the same result identity already
  present is replay success with zero spend; unchanged attempt retries the CAS
  boundedly; different identity fails closed.
- Attempt-owned cleanup belongs only to `ActiveAttempt`, never
  `PendingEffect`. Missing-result replacement and adopted-result clearing both
  require resource/process cleanup postcondition `confirmed`; cleanup failure
  retains the attempt and forbids replacement. `clear` removes the attempt only
  after that confirmation.

`src/v2/process-identity.ts` uses Linux `/proc/<pid>/stat` start ticks for exact
`same | reused | absent | unknown` leader identity. Darwin's available `ps
lstart` is only second-precision and `ps command` does not preserve argv
boundaries, so neither is allowed to prove `same`: a missing PID is `absent`, a
present PID whose freshly read PGID differs from the persisted PGID is
`reused`, and a present PID with the same PGID is fail-closed `unknown`. Group
observation is independently `live | absent | unknown`; therefore Darwin
recovery yields while the old group is live/unknown and can observe/replace only
after exact old-PGID absence. The production gate cannot start the worker before
launch CAS; parent-pipe closure exits a spawned-but-unpersisted gate process
without product effects. Adversarial tests give two same-second processes both
an identical flattened `ps command` with different argv boundaries and require
`unknown`, never `same`; a different observed PGID requires `reused`.

### Exact effect and resource ownership map

Every `PendingEffect` has `effectId`, one discriminant, exact identity payload,
and one explicit `RunIssue` handler. The handler sequence is intent CAS ->
invoke-or-observe -> exact postcondition -> settle CAS. Unknown invocation
outcome retains the same effect and permits observation only.

| Before owner/effect | Final classification | Exact postcondition |
| --- | --- | --- |
| claim label intent | `claim-labels` | fresh issue labels equal the authorized running projection |
| claim comment / handoff comment | `claim-comment` / `handoff-comment` | exact marker and body SHA exist once |
| waiting `question-comment-intent` | `waiting-question-comment` | exact question marker/body SHA exists once |
| waiting wait/resume/revoke label intents | `waiting-wait-labels` / `waiting-resume-labels` / `waiting-revoke-labels` | fresh labels equal each exact projection |
| initial commit/push/PR intents | `initial-commit` / `initial-push` / `draft-pr` | exact parent-tree-message commit; exact remote SHA; exact head/base/marker PR |
| final issue labels | `final-labels` | fresh labels equal review-ready projection |
| blocked-label intent | `blocked-labels` | fresh labels equal blocked projection without restoring revoked authorization |
| review activation labels | `review-activation-labels` | fresh labels equal active feedback projection |
| review update commit/push | `review-update-commit` / `review-update-push` | exact parent-tree-message commit; exact fast-forward remote SHA |
| review summary | `review-summary` | exact marker/body SHA exists once on the same PR |
| review final/blocked labels | `review-final-labels` / `review-blocked-labels` | fresh labels equal exact terminal projection |
| initial/continuation issue worktree creation | `worktree-create` / `continuation-worktree-create` | adapter inspection is exact `matching` for branch/base/published head |
| terminal/outcome evidence write | `outcome-evidence` | exact path and bytes SHA from persisted `{runId, code, summary, recordedAt}`; terminal/outcome CAS clears the effect only after identical bytes are observed |

Atomic Run CAS is state persistence, not a pending effect. Candidate capture,
pin/ref, materialization, artifact copy, shared-index normalization and release
remain finite candidate resources with existing exact inspect/reconcile/cleanup
postconditions. Device leases remain finite proof resources. Attempt report and
proof/evidence artifacts are attempt-owned content-addressed resources written
atomically. Repository/atomic locks are finite coordination resources. Immutable
workflow generation remains a package content-addressed resource protected by
its package publisher lock; it owns no Run phase, semantic budget, or worker
process. None of these resource records may contain product progression or a
second PID/PGID owner.

## Contract Test Ledger

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| Only exact `codex-orchestrator.run-state` bytes are readable; no version key or unknown key is accepted. | Old/unknown bytes enter a partial compatibility path. | `v2-run-store`: exact schema round-trip and old/unknown rejection | planned |
| Unsupported bytes return `state-schema-unsupported` before owner lock with zero filesystem, state, evidence, Git, GitHub, cleanup, or launch writes. | Rejection mutates the repository or masks old state. | Real-file `v2-run-issue`: preserve exact raw bytes and writable-root snapshot; assert owner acquire count 0 and no sibling artifact | planned |
| State is reread after owner lock and preflight bytes never drive progression. | TOCTOU replacement starts or resumes the wrong Run. | Real-file `v2-run-issue`: absent/supported/unsupported and A/B replacements during owner acquire; only two equal post-lock receipts progress | planned |
| Each Run has at most one `ActiveAttempt`; accepted semantic result is adopted once and replay/CAS/infrastructure spends zero. | Duplicate process or budget spend after crash/PID reuse. | Public `RunIssue` cases for report, implementation/format repair, check, review and proof across prepared-before-launch, authorization revocation before launch CAS, spawned-before-launch-CAS, same, unknown, absent, reused, leader absent/reused with live/unknown PGID, result-before-adoption, CAS loss before/after adoption, unique replacement incarnation and cleanup failure | planned |
| Each Run has at most one `PendingEffect`; observation settles the exact effect before the next is prepared. | Duplicate or skipped Git/GitHub effect. | Every effect-map row at before invocation, after invocation before observation, after observation before settle CAS, and replay | planned |
| Proof uses Run attempt/receipt data and no separate proof state/store. | Proof retry and process ownership diverge from Run. | `v2-acceptance-proof` plus production absence search for proof store/schema | planned |
| Failed daemon discovery never executes the prior candidate and another issue still runs. | Stale issue execution and repository-wide starvation. | `v2-cli`: injectable `executeDaemonTick` discards failed discovery, rediscovers next tick, and continues a frozen list after issue-local result | planned |

## 3. Execution Slices

All slice and contract-ledger items below are complete. The detailed checkboxes
are retained as the approved execution record; fresh evidence and the resolved
review defects are recorded in [the completion proof](1134-issue-1243-proof.md).

### Slice 1 — Lock all clean-cutover behavior with RED tests

- [ ] **Test/Proof First:** Add RED public `RunIssue`/CLI/daemon tests for the
  exact result/exit contracts, real-file writable-root proof, raw-identity race
  table, every ActiveAttempt crash branch, every PendingEffect crash point,
  proof-store removal behavior, and daemon freshness/isolation.
- [ ] **Target:** Tests and spec only. Do not write the new schema or any partial
  production owner while a legacy owner remains.
- [ ] **Validation:** Build and run the complete focused command; record that
  every new contract fails for the intended pre-cutover reason.
- [ ] **Exit Gate:** RED evidence exists for every ledger row and no production
  file contains the new schema/owners yet.

### Slice 2 — Atomic production state/owner/effect cutover

- [ ] **Target:** Add `src/v2/active-attempt.ts` and
  `src/v2/process-identity.ts` with exactly the interfaces above; update
  `codex-process.ts` and configured-check supervision to persist the launch
  identity before opening their start gates.
- [ ] **Target:** `src/v2/run-store.ts` — atomically replace the whole persisted
  shape with exact `codex-orchestrator.run-state`, final `RunRecord`, one
  `activeAttempt`, and one `pendingEffect`; delete migration, backup, rollback,
  version negotiation, legacy readers and old field validators in this same
  production change.
- [ ] **Target:** `src/v2/run-issue.ts`, `src/v2/runtime.ts`, CLI/daemon contracts
  — implement preflight and fresh post-lock inspection, exact public result,
  semantic result adoption, and every explicit pending-effect handler.
- [ ] **Target:** `src/v2/contained-report-operation.ts` and runtime adapters —
  route report workers, implementation and report repair, configured checks,
  review, and proof through the same attempt contract while leaving semantic
  validation in each existing operation module.
- [ ] **Target:** `src/v2/route-decision.ts`, `src/v2/spec-delivery.ts`,
  `src/v2/direct-delivery.ts`, `src/v2/review-feedback.ts`, and candidate types —
  delete operation-specific invocation/process fields and validators; reduce
  candidate execution lease to finite materialization identity with no
  prepared/launched/PID/progression fields.
- [ ] **Target:** `src/v2/acceptance-proof.ts` and `src/v2/run-issue.ts` — make
  proof execution stateless outside Run: active execution is
  `ActiveAttempt`; semantic counters/findings and terminal `ProofReceipt` are
  Run data; a passed receipt remains monotonic across cleanup failure.
- [ ] **Target:** `src/v2/proof-store.ts` and package exports/runtime wiring —
  delete the proof state schema, file/in-memory writers, runtime proof directory
  initialization, and all validators/tests that encode a parallel proof
  lifecycle.
- [ ] **Target:** `src/v2/run-store.ts`, `src/v2/run-issue.ts`, waiting/spec and
  post-PR semantic records — replace `PublicationIntent` and nested
  operation-specific intents with one finite typed `PendingEffect`; each
  explicit handler observes its exact postcondition before clearing and before
  preparing the next effect.
- [ ] **Target:** repository owner lock, `atomic-store.ts`, candidate adapter,
  and mobile lease integration — retain these as bounded safety resources;
  remove any phase/budget/process transition from their records and keep
  explicit cleanup postconditions.
- [ ] **Validation:** Run the full focused command after each coherent compile
  checkpoint, but do not treat an intermediate partial schema as shippable.
- [ ] **Exit Gate:** all ledger tests are GREEN; no old reader/store/owner or
  nested effect owner remains; proof has no store; every Run has zero/one
  attempt and zero/one effect; no generic step array/interpreter exists.

### Slice 3 — Daemon isolation, ADR, and structural proof

- [ ] **Test/Proof First:** Add RED daemon tests where discovery fails after a
  frozen list, one candidate owns a live/unknown/PID-reused attempt, and a later
  candidate remains processable.
- [ ] **Target:** extract narrow `executeDaemonTick` inside `src/v2/cli.ts` with
  injected discovery and existing serial candidate execution; discard a failed
  tick's candidates,
  rediscover next tick, bound one unresolved observation per issue, and continue
  over later frozen candidates after one issue returns a retry/safety outcome.
- [ ] **Target:** ADR 0001 — document the clean cutover, three owner kinds,
  exact schema identifier,
  attempt kernel limits, and retained resources; do not use or edit
  `docs/deep-dive.md`.
- [ ] **Target:** remove superseded tests/contracts. Do not regenerate
  `internal-workflow/`: repository evidence proves no worker-visible
  state/recovery contract changed. Run `check:workflow` and `verify:workflow`
  as no-drift regression proof.
- [ ] **Validation:** focused daemon/runtime/workflow contract tests, production
  absence searches, typecheck, then the full package suite because the changed
  state contract has repository-wide fan-out.
- [ ] **Exit Gate:** B0 remains unchanged; focused fault matrix and full suite
  pass; before/after report lists deleted owners/readers and only Run,
  ActiveAttempt, PendingEffect as lifecycle owners; V2 production LOC is below
  22704 and `src/v2/run-issue.ts` is below 4142 lines.

## 4. Risk Controls

- **State cutover:** Unsupported bytes are never renamed, deleted, backed up,
  normalized, locked for progression, or accompanied by evidence/state/worktree
  output. Absence is the only initialization case.
- **Attempt kernel:** It accepts identity and process/result/cleanup observations
  only. Product phase, route, findings, candidate policy, semantic budgets,
  retry decisions, and publication sequence stay in `RunIssue`/operation result
  validators and never become attempt parameters or switches.
- **Atomic adoption:** An operation validates exact attempt-owned bytes first,
  then CAS-adopts the semantic result and budget receipt. CAS loss rereads and
  recognizes the same accepted identity; it does not relaunch or spend again.
- **Launch authorization:** The caller revalidates claim authorization after
  prepare and immediately before every durable launch CAS/start-gate release.
  Revocation launches no semantic work and spends no budget.
- **Process replacement:** Replacement requires exact result adoption or proved
  leader and process-group absence using host, boot, PID, PGID, and the exact
  platform-specific identity above. Linux start ticks may prove `same/reused`;
  Darwin's unavailable sentinel never proves `same`, so only missing PID or a
  freshly observed different PGID can classify the leader as absent/reused.
  Every replacement persists a fresh incarnation and therefore a distinct
  attempt/result root.
  Attempt cleanup is not cleared until its postcondition is confirmed.
- **Finite resources:** Repository/atomic locks coordinate access; candidate
  pins/materializations bind bytes; device leases bind proof targets. None can
  select phase, own semantic budget, or independently launch a process.
- **No coexistence:** The atomic production cutover cannot be considered GREEN
  while a replacement field and its superseded invocation, proof state, effect
  intent, reader, validator, or tests coexist.
- **Review Timing:** One independent implementation Full review after all #1243
  acceptance criteria are green, with mandatory structural-deletion, TOCTOU,
  PID identity, exact result adoption, and effect replay lenses.

## Write Scope Summary

- `src/v2/run-store.ts` — Update; exact state, Run, ActiveAttempt, PendingEffect.
- `src/v2/run-issue.ts` — Update; sole progression/adoption owner and preflight.
- `src/v2/runtime.ts` — Update; raw state preflight and process/effect adapters.
- `src/v2/acceptance-proof.ts` — Update; remove parallel proof lifecycle.
- `src/v2/proof-store.ts` — Delete.
- `src/v2/candidate.ts` — Update; materialization as finite resource only.
- Operation semantic modules and adapters — Update; delete durable invocation
  and nested effect ownership while retaining result validators.
- `src/v2/cli*.ts`, `src/index.ts` — Update; typed unsupported-state result and
  removal of superseded exports.
- `test/v2-*.test.ts` — Update; contract-ledger RED/GREEN and absence proof.
- `docs/adr/0001-runner-owned-loop-policy.md` — Update; accepted clean cutover.
- `internal-workflow/` and package workflow sources — No writes; verify no drift
  because no worker-visible operation/report contract changes in #1243.

## Halt Conditions

- Repository evidence requires any legacy reader/migration/backup/dual-write or
  a compatibility runtime.
- Correct recovery requires a phase-aware workflow engine, queue, cache, retry
  coordinator, classifier, or generic plan interpreter.
- An operation-specific process/effect owner cannot be deleted in the same
  slice as its replacement.
- Effect-free unsupported-state rejection cannot occur before owner lock, or a
  fresh authoritative post-lock reread cannot be guaranteed.
- Preserving authorization, containment, candidate/tree trust, CheckedChange,
  proof, or terminal semantics would require changing #1243 authority.

## Review Focus

- **Mandatory Lenses:** Architecture/Execution; Failure/Contracts;
  determinism/evidence; sequencing/ownership; validation; safety.
- **Targeted Recipes:** Exact-schema and TOCTOU fault injection; process
  identity/PID reuse; result adoption/CAS replay; pending-effect postcondition
  replay; production owner/reader absence search.
- **Bug Classes:** stale preflight progression, duplicate launch, PID reuse,
  double semantic spend, lost accepted result, cleanup-before-adoption,
  duplicate effect, nested lifecycle owner, hidden legacy reader.

## Defect Closure Notes

- **Review Summary:** Consolidated repair after parallel high-profile Full;
  repaired contracts require independent fresh verification before approval.
- **Verified Defects:** `SPEC-CUTOVER-01`, `SPEC-AUTH-01`, `SPEC-TOCTOU-01`,
  `SPEC-ATTEMPT-01`, `SPEC-PROCESS-01`, `SPEC-EFFECT-01`,
  `SPEC-EVIDENCE-01`, `SPEC-PUBLIC-01`, `SPEC-FILESYSTEM-01`,
  `SPEC-VALIDATION-01`, `SPEC-DAEMON-01`, `SPEC-GENERATED-01`, and
  `SPEC-COMPLETION-01`.
- **Accepted Risks:** None.
- **Open Defects:** None.

Duplicate reviewer IDs with different failure mechanisms are superseded by the
canonical records in this table.

| Canonical ID | Source reviewer IDs | Class; invariant and failure | Repaired section | Verification evidence |
| --- | --- | --- | --- | --- |
| `SPEC-CUTOVER-01` | `NEW-SEQUENCING-01` (atomicity) | Blocker; exact schema cannot coexist with legacy owners or it becomes a shallow wrapper. | Atomic Slice 2 | One production cutover and no-coexistence exit gate |
| `SPEC-AUTH-01` | `NEW-SEQUENCING-01` (launch auth) | Blocker; revocation after prepare must prevent launch and semantic spend. | ActiveAttempt launched transition; Launch authorization | Public RunIssue revocation cases for every operation family |
| `SPEC-TOCTOU-01` | `NEW-CONCURRENCY-01` (preflight) | Blocker; raw state replacement must not drive stale progression. | Preflight/post-lock contract | Real-file A/B/absent/unsupported race table |
| `SPEC-ATTEMPT-01` | `NEW-CONCURRENCY-01` (attempt) | Blocker; result/CAS/replacement must not duplicate work or reuse an attempt root. | ActiveAttempt contract | Full attempt crash matrix and fresh incarnation case |
| `SPEC-PROCESS-01` | `NEW-ARCH-01` (process) | Blocker; PID reuse or a live/unknown descendant group must never count as quiescent. | Linux exact start ticks; Darwin fail-closed leader identity; PGID contract | Same-second flattened-argv collision must be unknown plus leader/group matrix |
| `SPEC-EFFECT-01` | `NEW-ARCH-02`, `NEW-CONTRACTS-02` | Blocker; every unfinished mutable effect has one owner and exact postcondition. | Effect/resource map | Every table row at four crash points |
| `SPEC-EVIDENCE-01` | `NEW-ARCH-02` (evidence) | Blocker; outcome evidence bytes must not drift across crash before terminal CAS. | `outcome-evidence` effect row | Write/observe/terminal-CAS replay cases |
| `SPEC-PUBLIC-01` | `NEW-CONTRACT-01`, `NEW-CONTRACTS-01` | Execution risk; unsupported state needs one canonical public payload and exit/daemon behavior. | Public unsupported-state contract | Parsed and exact canonical JSON plus exit 20/max aggregation |
| `SPEC-FILESYSTEM-01` | `NEW-VALIDATION-01` (real effects) | Blocker; recorder-only proof can miss owner/filesystem writes. | Ledger and preflight contract | Exact raw bytes and writable-root snapshot, owner count zero |
| `SPEC-VALIDATION-01` | `NEW-VALIDATION-01` (search) | Execution risk; absence commands must find durable legacy owners without matching unrelated adapters/intents. | Architecture Check | Named-symbol search and durable-record-local field search |
| `SPEC-DAEMON-01` | `NEW-DETERMINISM-02` | Execution risk; stale discovery or one issue result must not block later candidates. | Slice 3 daemon seam | Injectable tick freshness/isolation tests |
| `SPEC-GENERATED-01` | `NEW-SCOPE-01` | Execution risk; ungrounded generated writes cause churn. | Confirmed targets and Slice 3 | No internal workflow state contract; check/verify no drift |
| `SPEC-COMPLETION-01` | `NEW-COMPLETION-01` | Execution risk; structural simplification must include real deletion. | Slice 3 and Done Criteria | Exact B0 commands with both numeric decreases plus absence proof |

## 5. Validation And Done Criteria

- [ ] **Lint/Format:** Not applicable; no separate repository command exists.
- [ ] **Typecheck/Build:** `npm run typecheck && npm run build`.
- [ ] **Tests:** Focused command from Preconditions, then `npm test`.
- [ ] **Architecture Check:** Run
  `rg -n "codex-orchestrator\\.agent-auto-state|rollbackCandidateMigration|markPublicationEffectPossible|pre-candidate-v3|ProofRecordWriter|ProofStateV1|acceptance-proof-state|ReviewInvocationV1|SpecInvocationV1|ReviewFeedbackImplementationInvocationV1|CandidateExecutionLeaseV2|repairInvocation" src/v2 --glob '*.ts'`;
  every legacy-owner pattern must return no production match. Run
  `rg -n "invocation|executionLease|^[[:space:]]+(process|intent)\\??:" src/v2/run-store.ts src/v2/waiting-human.ts src/v2/spec-delivery.ts src/v2/direct-delivery.ts src/v2/review-feedback.ts`
  and require no durable legacy field match. Run
  `rg -n "activeAttempt|pendingEffect|pid|processGroupId" src/v2/run-store.ts src/v2/active-attempt.ts`
  and inspect that PID/PGID exist only inside `ActiveAttempt`, while pending
  effect cardinality is a single optional Run field. Unrelated `SetupIntent`,
  `DaemonIntent`, and injected `CodexProcess` adapter fields are explicitly not
  forbidden. The before/after owner map separately lists retained
  locks/pins/materializations/device leases.
- [ ] **Deletion Metrics:** Re-run the B0 commands exactly; require V2
  production LOC `< 22704` and `src/v2/run-issue.ts` LOC `< 4142`. Numeric
  deletion supplements, and never replaces, structural absence proof.
- [ ] **Live/Manual Proof:** Not applicable in #1243; live scratch proof belongs
  to #1246.
- [ ] **Behavior Proof:** Existing direct, spec, waiting, proof, publication,
  and post-PR tests stay behaviorally green while fault tests prove exact
  schema, owner cardinality, result/effect replay, daemon freshness, and issue
  isolation.
- [ ] **Reconciliation:** Every unchecked item is unfinished, blocked with
  evidence, or intentionally not applicable.
- [ ] **Final Handoff Requirements:** Extended `$spec-implementer` Final Risk
  Handoff plus B0 reference, deleted-owner list, exact focused commands/results,
  skipped proof, and residual recovery risk.
