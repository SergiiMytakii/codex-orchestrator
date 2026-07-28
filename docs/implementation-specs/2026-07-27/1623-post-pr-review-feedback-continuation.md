---
title: "Continue a review-ready run from trusted pull-request feedback"
created_at: "2026-07-27T16:23:03+03:00"
source_type: "plan"
source_plan: "None — approved in the Codex conversation on 2026-07-27"
source_issues:
  - "None"
status: "implemented-with-coverage-gaps"
execution_model: "single-agent"
spec_mode: "full"
implementation_size: "large"
expected_repositories: 1
review_profile: "high"
review_reasons:
  - "Trust boundary: repository-authorized human feedback can resume contained implementation and cause GitHub writes."
  - "Durable recovery: a previously terminal run must resume across state migration, process interruption, commit, push, and comment reconciliation."
  - "External contract: GitHub GraphQL review-thread pagination and REST review/permission observations must remain correlated to one PR head."
review_outcome: "Approved"
review_verdict: "Approved"
review_coverage: "Architecture/Execution and Failure/Contracts; trust, migration, state transitions, process/worktree recovery, idempotent publication, and contract-test proof"
review_passes: "6; 2 Full / 4 Closure"
---

> Post-delivery supersession (2026-07-28): the certificate and canary gate recorded below were removed from runtime policy. The original implementation and review record is preserved unchanged for audit; the replacement contract is recorded in `docs/contract-test-ledgers/2026-07-28-runtime-containment-without-certification.md`.

## 1. Execution Context

- **Goal:** When a marker-bound draft PR created by a direct-delivery run receives new trusted unresolved review feedback, resume that same run, freeze one immutable feedback batch, repair it, perform affected Closure, rerun checks and Acceptance Proof, and fast-forward the same branch and PR back to `review-ready` without duplicate effects.
- **Source Material:** Approved 2026-07-27 conversation plan; repository revision `2d72827`; `README.md`; `docs/deep-dive.md`; `docs/agents/execution-routing.md`; `docs/adr/0001-runner-owned-loop-policy.md`; GitHub [GraphQL pull-request schema](https://docs.github.com/en/graphql/reference/pulls), [REST pull-request reviews](https://docs.github.com/en/rest/pulls/reviews), [REST pull-request review comments](https://docs.github.com/en/rest/pulls/comments), and [repository permission endpoint](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user).
- **Approved Scope:** Same-repository draft PRs created by a successful direct route; trusted unresolved inline review threads; trusted non-empty `CHANGES_REQUESTED` review bodies; frozen feedback receipts; controlled `review-ready` continuation; reuse of implementation, affected Closure, checks, `CheckedChange`, Acceptance Proof, and Runner-owned publication; same-branch fast-forward updates; daemon discovery of `agent:review`; mandatory updates to `README.md` and `docs/deep-dive.md`; affected public documentation and regression tests.
- **Out of Scope:** UI; webhooks; fork PRs; ordinary PR conversation comments; approvals; bot feedback; feedback from `read`, `triage`, or unknown permission; model-based pre-triage of whether a comment is actionable; automatic GitHub thread resolution; merge, rebase, amend, force-push, auto-merge, dismissal of reviews, requested-reviewer trust, new labels, a new worker operation, a second review engine, a sidecar feedback state file, live smoke execution without explicit user authorization, package release or registry publication.
- **Minimum Solution:** Extend the existing PR adapter to read exact GitHub review state; persist one review-feedback execution inside the existing run record; permit `RunIssue` to leave `review-ready` only after a trusted batch is frozen; map that batch to existing `DirectReview` repair findings; reuse current implementation/Closure/check/proof stages; add an update-only publication saga that verifies the previous and resulting remote SHAs and posts one marker-bound PR summary.
- **Added Complexity:**
  - `ReviewFeedbackExecutionV1` — required to freeze trusted GitHub input, deduplicate source IDs, retain the previous published SHA, bound three repair rounds, and recover effects; without it a restart can replay changed feedback or duplicate publication.
  - `ReviewFeedbackCoordinator` — required to keep collection, permission validation, canonical hashing, and final revalidation outside the already-large `RunIssue`; without it trust decisions and GitHub normalization leak across lifecycle branches.
  - Run-state schema version 2 with V1 read migration — required because strict V1 records reject the new durable execution and existing `review-ready` runs must remain resumable; without it upgrades either corrupt state compatibility or abandon prior runs.
  - Update-publication intents — required because the current initial `publish()` requires a commit whose parent is `baseSha` and may create a PR; without a distinct update path it cannot safely append a commit to an existing remote branch.
- **Primary Risk:** A stale, edited, unauthorized, duplicated, or wrong-PR review item could trigger code execution or an external write after the original run was considered terminal.

## 2. Preconditions And Evidence

- **Required Services / Env / Fixtures:** Node/npm dependencies already locked by the repository; `git` and authenticated `gh` only for production adapter use; deterministic unit fixtures for GraphQL pages, REST reviews, permission responses, run state, Git state, and interruption points. Tests must not require network or credentials.
- **Blocking Unknowns:** None. GitHub documents `PullRequest.headRefOid`, paginated `reviewThreads`, `PullRequestReviewThread.isResolved`, `isOutdated`, path/line and paginated comments; REST documents chronological reviews and calculated repository permission (`admin`, `write`, `read`, `none`).
- **Confirmed Targets:**
  - `src/v2/adapters/pull-requests.ts:GitHubPullRequestAdapter`, `GitHubPullRequestDetails`, `InMemoryGitHubPullRequestAdapter`.
  - `src/v2/adapters/gh-pull-request-adapter.ts:GhCliPullRequestAdapter`.
  - `src/v2/adapters/issues.ts:GitHubIssueAdapter.getRepositoryPermission` as the sole repository-permission owner.
  - `src/v2/run-store.ts:RunRecordV1`, `Lifecycle`, `PublicationIntent`, `validateRunStateFile`, `FileRunRecordWriter`.
  - `src/v2/direct-delivery.ts:DirectRepairFindingV1`, `beginDirectReviewRepair`, `prepareDirectReviewClosure`.
  - `src/v2/run-issue.ts:RunIssue.runIssue`, `startNextCycle`, `publish`, `authorized`.
  - `src/v2/runtime.ts:LocalGitRunIssueAdapter`, `createV2Runtime`; `src/v2/adapters/worktree.ts:GitWorktreeManager.ensureIssueWorktree`.
  - `src/v2/cli.ts:executeProductionDaemon`.
  - Existing tests `test/v2-run-store.test.ts`, `test/v2-direct-delivery.test.ts`, `test/v2-run-issue.test.ts`, `test/v2-cli.test.ts`; new focused adapter/contract/coordinator tests listed below.
- **Confirmed Commands:**
  - `npm run typecheck`
  - `npm run build --silent && node --test dist/test/v2-gh-pull-request-adapter.test.js dist/test/v2-review-feedback-contract.test.js dist/test/v2-review-feedback-coordinator.test.js dist/test/v2-direct-delivery.test.js dist/test/v2-run-store.test.js dist/test/v2-run-issue.test.js dist/test/v2-cli.test.js`
  - `npm test`
  - `npm run test:v2-containment`
  - `npm run verify:workflow`
  - `npm pack --dry-run --json`
  - `git diff --check`
- **Protected Paths / Rejected Approaches:** Never read, print, or edit `.env` or `.env.*`; do not give workers GitHub/SSH credentials; do not use `npm run smoke:live` without explicit authorization; do not add a webhook service, queue, second state file, configurable retry framework, new review worker, auto-resolve mutation, or force-push fallback.
- **Source of Truth:** GitHub is authoritative for current PR/head/thread/comment/permission observations; the atomic run state is authoritative for frozen batch identity, consumed source IDs, repair rounds, prior published head, effects, and verified outcomes; the local worktree is accepted only when it exactly matches the persisted branch and published head precondition.
- **New Boundaries:** `ReviewFeedbackCoordinator` exposes one deep Runner-owned seam: observe/freeze a batch from normalized adapter records, revalidate the active batch before privileged stages/effects, and project verified/published outcomes. It performs no worker launch, Git mutation, label mutation, or PR resolution.

## Risk Controls

- **Source of Truth:** Never infer unresolved state from REST comment shape: GraphQL `reviewThreads.isResolved` owns thread eligibility. Never infer trust from `authorAssociation`: `GitHubIssueAdapter.getRepositoryPermission(login, immutableUserId)` must return a fresh `write` or `admin` observation.
- **Safety / Contract / State Constraints:**
  - A continuation is eligible only for the single open draft PR whose owner/repository identity, `isCrossRepository=false`, head/base refs, node/number, and run marker match the persisted run and whose `headRefOid` equals the persisted published head.
  - Observe one coherent GitHub snapshot by reading exact PR identity/head before all GraphQL/REST pages and again after the last page. Retry without freezing if either boundary read differs; a second torn observation fails closed. Each eligible source must itself target the frozen head: a thread must be unresolved, `isOutdated=false`, and have root `commitId=observedHeadSha`; a submitted nonblank `CHANGES_REQUESTED` review must have `commitId=observedHeadSha`. Approvals, pending/dismissed reviews, resolved/outdated threads, bots, ordinary conversation comments, cross-repository sources, other-head sources, and consumed source IDs are excluded.
  - A thread finding contains only its nonblank trusted root comment. Untrusted replies are neither persisted as bodies nor passed to a worker; their IDs/content hashes may be retained only for snapshot drift detection. A review-body finding contains only a trusted review body. Every body exposed to a worker requires a fresh `write/admin` observation bound to that immutable author ID.
  - Batch identity is a domain-separated canonical hash of run ID, configured repository identity, PR node/number, observed head SHA, sorted finding snapshots, per-source commit SHA, immutable author IDs, content hashes/timestamps, and permission receipts. Source IDs are `pr-thread:<threadNodeId>` and `pr-review:<reviewNodeId>`.
  - Re-read every active trusted source, permission, PR identity, and expected epoch immediately before both label mutations, the first implementation launch, each later worker launch, commit, push, and summary comment. Deletion, trusted-body/timestamp drift, identity mismatch, permission revocation, unexpected PR/ref drift, or ambiguous observation fails closed before the next privileged action.
  - Revalidation has two explicit epochs. `pre-update` requires the persisted old published head and exact frozen source/derived thread state through commit and immediately before push. `post-push` requires the same PR/repository/refs/marker, the exact new pushed head, unchanged trusted source identity/body/author permission, and allows only GitHub-derived `isOutdated/isResolved` changes caused after the push; it never admits new source bodies into the active batch.
  - `review-ready` remains quiescent and effect-free when no eligible batch exists. Only one successful atomic transition may clear its terminal projection and activate one frozen batch.
  - Initial delivery `cycle` remains unchanged. `ReviewFeedbackExecutionV1.repairRound` owns a separate `1 | 2 | 3` budget. Round 1 is reserved in the activation CAS. A later round is reserved exactly once by the CAS that persists a completed Closure/check/proof `needs-work` result. Transport failures, the one report repair, cancellation, authorization failure, and crashes do not increment the round. A completed round-3 `needs-work` result becomes `blocked/exhausted` with `resumable:false`; no fourth round exists.
  - Every continuation clears prior checks, `checkedChangeSha256`, `proofId`, and `proofReceipt`; publication requires new receipts bound to the repaired content.
  - Update publication requires local HEAD and remote branch to equal the persisted previous published head before commit, a single-parent new commit, and remote equality with the new commit after push. Divergence blocks; no rebase, reset, amend, or force-push recovery is allowed.
  - A verified outcome is internal Closure evidence only. The Runner posts a summary but never resolves a GitHub thread or claims human approval.
- **Forbidden Scope:** No changes to product routing, spec-required delivery, waiting-human semantics, initial five-cycle budget, target config schema, labels, issue authority, worker credential containment, or release behavior beyond what is necessary to recognize and execute the approved post-PR continuation.
- **Review Timing:** One final high-profile review after all slices. Mandatory independent lenses are Architecture/Execution and Failure/Contracts; Closure is required for any high/critical defect affecting trust, durable migration, recovery, or publication idempotency.

### Outer And Nested State Transitions

| Starting State | Observation / Persisted Intent | Atomic Next State | Recovery / Result |
| --- | --- | --- | --- |
| V1 `review-ready` | First coherent PR snapshot after upgrade | V2 `review-ready` + nested `idle` baseline containing all currently eligible source IDs as consumed and the observed head; no label/GitHub/worker effect | Return the existing `review-ready`; only later source IDs are eligible. |
| V2 `review-ready` + `idle` | No new eligible source | No state change | Return the existing `review-ready`. |
| V2 `review-ready` + `idle` | Transient/torn first observation | No state or external effect; return existing typed transient read result | Daemon retries the same checkpoint. |
| V2 `review-ready` + `idle` | Stable eligible batch | One CAS sets nested `frozen`, reserves round 1, appends consumed IDs, calls `beginDirectReviewRepair`, clears terminal/check/proof receipts, sets outer `implementing`, and persists exact label intent `[agent:auto, agent:running]` | Reconcile label effect/read-back, clear intent, then launch implementation. A crash remains daemon-discoverable through `agent:auto`. |
| Active `frozen/repairing` | Transport/report retry | Same round and active phase, bounded by the existing per-batch reset counters | Recover existing invocation/process before retry. |
| Active `repairing` | Completed Closure/check/proof `needs-work` and round < 3 | One CAS reserves the next round and persists findings | Continue `implementing` on that round. |
| Active `repairing` | Completed `needs-work` at round 3 | Outer `blocked`, nested `blocked-exhausted`, `resumable:false` terminal projection | Exact blocked labels/evidence use existing terminal machinery; this batch can never launch another worker. |
| Active state | Source/permission/PR/worktree/process safety drift | Outer `blocked`, nested `blocked-safety`, `resumable:false` terminal projection | No later worker or publication effect and terminal replay never resurrects the batch. |
| Active `repairing` | Closure, checks, and proof all clear | Nested `verified`, outer `publishing`, exact update intent | Enter update-publication saga. |
| `publishing` | Commit/push/comment/label interrupted | Keep exact nested phase and top-level intent until postcondition is observed | Reconcile and adopt only an exact permitted state; otherwise safety-block. |
| `publishing` | New head, summary, and exact `[agent:review]` observed | Nested history marks batch `published`, active batch becomes null/`idle`, outer returns `review-ready` with fresh terminal outcome | Later distinct sources may start another batch. |

No new top-level `review-feedback` lifecycle is added. Existing outer lifecycles and terminal machinery remain authoritative; nested feedback phases supply continuation-specific history.

Both continuation-specific blocked projections are deliberately non-resumable. Recovery requires a new explicitly authorized product workflow outside this spec; `runIssue` only replays their durable terminal outcome and daemon polling performs no worker or GitHub effect.

### Canonical Finding And Worker Projection

- `DirectRepairFindingV1.id` and `sourceId` are both the stable source ID (`pr-thread:<threadNodeId>` or `pr-review:<reviewNodeId>`); `provenance` is `pr-review`; `targetRevision` is the current clear `DirectReview.targetRevision`; `status` starts `open`.
- `summary` is deterministically rendered from source kind, URL, optional `path:line`, and the trusted body after CRLF→LF normalization with no semantic rewriting. `affectedContracts` is sorted and contains `pr-review` plus `path:<normalized-path>` for inline threads.
- The implementation worker receives one sorted frozen array `{id, sourceUrl, path, line, body}` containing trusted bodies only. `reworkFindings` receives the same deterministic summaries. No other review-thread text is serialized into a prompt.

### Phase-Specific Worktree Recovery

| Phase | Permitted Local / Remote State | Recovery |
| --- | --- | --- |
| Baseline or before activation | Existing issue branch/worktree is clean, index equals HEAD, local HEAD and remote equal old published head | Restore an absent worktree only via the existing local issue branch after proving it equals remote/old head. Any dirty/index/head divergence blocks. |
| Active before/during worker | HEAD remains old published head; nested implementation invocation is `prepared` or `launched`; process-owned worktree changes follow the persisted baseline | `prepared` interrupted before a durable launch acknowledgement safety-blocks without relaunch. For `launched`, prove process-group absence, recover and validate the attempt-owned report artifact when present, and continue from that result. If no valid report exists, relaunch in the same round only when the worktree exactly equals the persisted baseline; changed/ambiguous state safety-blocks. Never clean/reset/delete changes. |
| Verified before commit | HEAD equals old published head; staged tree/content equals fresh CheckedChange and proof | Persist commit intent before effect. |
| Commit delivery unknown | HEAD is either the old parent or exactly one single-parent child matching intended parent, tree, and message | Retry only from old parent; adopt exact matching child; any other state blocks. |
| Push delivery unknown | Local HEAD is exact new child; remote is either old parent or exact child | Push only from old remote; adopt exact child; any other remote blocks. |
| Post-push / finalization | Local and remote equal exact new child; same PR exposes new head | Reconcile summary and labels only; never rewrite Git history. |

## Contract Test Ledger

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| A `review-ready` run with no new trusted feedback returns the existing outcome and performs no state or external write. | Polling converts a terminal checkpoint into repeated work. | `test/v2-run-issue.test.ts`: `review-ready replay remains effect-free without an eligible feedback batch` | green |
| Only unresolved thread roots and nonblank `CHANGES_REQUESTED` reviews from fresh `write/admin` identities enter a batch. | Untrusted discussion or weak association triggers implementation. | `test/v2-review-feedback-coordinator.test.ts`: `freezes only authorized eligible review sources` | green |
| One canonical source ID can be consumed once, while a later distinct source on the updated PR creates a new batch. | Duplicate repair and summary comments after daemon replay. | `test/v2-review-feedback-contract.test.ts`: `consumed sources are append-preserving and batch hashes are deterministic` | green |
| V1 state reads successfully and the first CAS emits valid V2 state without changing existing run semantics. | Package upgrade strands or rewrites prior runs. | `test/v2-run-store.test.ts`: `migrates V1 run state to V2 on the next atomic write` | green |
| Frozen source/body/author/permission/ref drift blocks before a worker or GitHub effect. | Edited or revoked authority acts after approval. | Coordinator drift/revocation tests plus implementation Closure `IMPL-REV-001`/`007` | green; fault-point matrix reviewed, not exhaustively injected |
| Post-PR repair uses `pr-review` findings and affected Closure, preserving the existing defect ledger. | A second review engine loses prior defects or silently marks feedback fixed. | `test/v2-direct-delivery.test.ts`: `maps PR findings through repair and affected Closure` | green |
| A continuation always mints new checks, CheckedChange, and Acceptance Proof receipts for the repaired target. | Previously approved evidence is reused after code changes. | In-memory continuation end-to-end plus run-store receipt binding tests | green |
| The update commit is a single fast-forward child of the last published head and the existing PR number remains unchanged. | Force-push, wrong parent, or accidental second PR. | In-memory continuation end-to-end and exact local/remote restoration test | green |
| Persisted intents reconcile interruption before/after commit, push, labels, and summary comment without duplicates. | Crash causes duplicate external effects or ambiguous success. | Activation unknown-delivery test plus implementation Closure `IMPL-REV-002`/`008` | partial; exhaustive update-effect injection remains absent |
| Three failed/reopened feedback rounds are the maximum and do not consume or overflow the original `cycle` field. | Infinite reviewer ping-pong or invalid cycle 6 state. | Contract validator rejects round four; end-to-end preserves original cycle | partial; no run-level round-three exhaustion fixture |
| Label writes occur only after immediate fresh revalidation and each persisted label intent is read back before continuation. | Permission revocation or crash around labels leaves unauthorized/unrecoverable state. | Activation unknown-delivery/revocation tests plus implementation Closure `IMPL-REV-001`/`002` | partial; final-label fault matrix remains absent |
| Boundary PR reads enclose all GraphQL/REST pages and every source targets the stable observed head. | Torn multi-endpoint snapshot mixes feedback from different PR revisions. | `test/v2-review-feedback-coordinator.test.ts`: `rejects torn observations outdated threads and other-head reviews` | green |
| First observation of a migrated V1 `review-ready` run baselines existing sources without executing them. | Upgrade retrospectively runs old feedback with no consumed history. | V1→V2 migration test and reviewed bootstrap transition | partial; no dedicated integrated old-feedback fixture |
| A repair round is reserved by one CAS and only a completed needs-work outcome consumes the next round. | Crash double-consumes or reuses one logical round. | Contract transition validation and implementation Closure `IMPL-REV-002`/`005` | partial; no complete round fault matrix |
| Activation CAS clears stale receipts, opens DirectReview repair, reserves round 1, and persists `[auto,running]` intent before any label effect. | Crash leaves a running-only run undiscoverable or publishes stale proof. | In-memory activation unknown-delivery/restart test | green |
| Commit intent records parent/tree/message before effect; unknown delivery adopts only one exact matching child, then push intent records the known child SHA. | Unknown commit delivery duplicates commits or requires a predicted SHA. | Intent validators, generic publication recovery tests, and implementation Closure `IMPL-REV-008` | partial; update-specific commit/push fault matrix remains absent |
| A continuation implementation invocation is persisted `prepared → launched` with attempt ID, baseline, PID and process group; restart proves absence and recovers the attempt report before any relaunch. | Crash after spawn duplicates a worker or loses an already-mutated worktree/report. | Attempt-owned report recovery/foreign-path test and implementation Closure `IMPL-REV-003`/`004` | green |
| `blocked-safety` and `blocked-exhausted` continuation outcomes are non-resumable and terminal replay cannot relaunch their batch. | A terminal run silently resurrects or exhausted round 3 starts round 4. | Strict contract validation and reviewed terminal replay path | partial; no dedicated terminal replay fixture |

## 3. Execution Slices

### Slice 1 — Normalize one coherent PR review observation

- [x] **Test/Proof First:** Add failing `test/v2-gh-pull-request-adapter.test.ts` coverage for boundary PR reads, GraphQL thread/comment cursor pagination, REST review pagination, repository identity, `isCrossRepository`, `headRefOid`, per-source commit SHA, nullable actor handling, malformed payload rejection, and no review-thread mutation calls.
- [x] **Target:** `src/v2/adapters/pull-requests.ts` — add normalized repository/PR head, submitted review, review thread/comment, and marker-bound conversation-comment contracts plus in-memory fixtures. Include PR owner/repository/node/number/head/base/draft/open/cross-repository identity and review/thread source commit IDs. Keep permission lookup out of this adapter.
- [x] **Target:** `src/v2/adapters/gh-pull-request-adapter.ts:GhCliPullRequestAdapter` — expose boundary PR reads; read threads through `gh api graphql`, reviews through paginated REST, and PR conversation comments through the issues-comments endpoint; implement post/read-back for one exact summary marker. Bound pages/items/text consistently with existing adapters and reject ambiguous or malformed payloads.
- [x] **Validation:** `npm run build --silent && node --test dist/test/v2-gh-pull-request-adapter.test.js`
- [x] **Exit Gate:** The adapter deterministically returns all pages with immutable repository/PR/node/database/user IDs, timestamps, source commit IDs, state, body, path/line, resolved/outdated status, and exact head SHA; the coordinator can prove the two boundary reads match; no review-thread mutation exists.

### Slice 2 — Persist and validate review-feedback execution

- [x] **Test/Proof First:** Add failing `test/v2-review-feedback-contract.test.ts` and V1/V2 cases in `test/v2-run-store.test.ts` for canonical batch hashing, source deduplication, exact phases, three-round budget, terminal/active invariants, unknown-key rejection, migration, and CAS generation preservation.
- [x] **Target:** `src/v2/review-feedback.ts` — create `ReviewFeedbackExecutionV1`, frozen batch/source/permission/publication receipt types, a nested continuation implementation invocation, domain hashes, constructors/transitions, and strict validation. Required nested states cover `bootstrap-required`, `idle`, active `frozen/repairing/verified/publishing`, batch-history `published`, and non-resumable terminal `blocked-safety/blocked-exhausted`; history is append-preserving and only one batch/invocation is active.
- [x] **Target:** `src/v2/run-store.ts` — introduce state file version 2, accept and normalize V1 on read, emit only V2 on the next CAS, add optional review-feedback state and update-publication intent variants, and encode the exact outer/nested transition table. A migrated V1 `review-ready` record becomes `bootstrap-required`; its first coherent observation persists all existing eligible source IDs as a consumed no-effect baseline before later feedback can activate. Do not create a second file or silently discard unknown V1 data.
- [x] **Target:** `src/v2/route-decision.ts` and terminal projections — preserve the existing top-level lifecycle set and direct route authority; add no `review-feedback` lifecycle. Validate nested continuation against the existing outer lifecycle/terminal projection.
- [x] **Validation:** `npm run build --silent && node --test dist/test/v2-review-feedback-contract.test.js dist/test/v2-run-store.test.js dist/test/v2-route-decision.test.js`
- [x] **Exit Gate:** Every old state fixture remains readable with identical public outcome; invalid mixed terminal/active feedback states fail validation; V2 survives serialize/read/CAS round trips.

### Slice 3 — Freeze and revalidate trusted feedback

- [ ] **Test/Proof First:** Partial — focused tests cover coherent/torn reads, head/state exclusion, deterministic batching, weak permission/resolved/blank exclusion, untrusted-reply isolation, edit/revocation, and post-push derived drift; explicit bot, delete, identity-mismatch, and transient-read cases remain consolidated under strict fail-closed validation/review rather than dedicated fixtures.
- [x] **Target:** `src/v2/review-feedback-coordinator.ts` — implement observation, freeze proposal, active-batch revalidation, and verified/published projections using `GitHubPullRequestAdapter` plus the existing `GitHubIssueAdapter.getRepositoryPermission` seam. The coordinator returns typed `none`, `frozen`, `retryable`, or fail-closed results and performs no external write.
- [x] **Target:** `src/v2/review-feedback.ts` — implement the exact Canonical Finding And Worker Projection above. Persist and prompt only trusted bodies; untrusted reply IDs/hashes may participate in observation drift but never implementation text.
- [x] **Validation:** Covered by the exact focused spec command: 79/79 passing.
- [x] **Exit Gate:** Repeated observation is canonically hashed and changed/untrusted sources fail closed; Architecture/Execution and Failure/Contracts Closure verified the boundary.

### Slice 4 — Resume `review-ready` and reuse repair/Closure

- [ ] **Test/Proof First:** Partial — no-op replay, activation/label recovery, `pr-review` Closure mapping, same-PR happy path, attempt-report recovery, foreign-path rejection, and non-resumable validation are green; the complete three-round and every-boundary launch fault matrices remain absent.
- [x] **Target:** `src/v2/direct-delivery.ts:DirectRepairFindingV1` — add `pr-review` provenance without weakening existing source/target/status validation or defect-ledger immutability.
- [x] **Target:** `src/v2/run-issue.ts:RunIssue.runIssue` — controlled bootstrap/activation/replay is implemented with exact authority, receipt clearing, DirectReview repair, and label intent recovery.
- [x] **Target:** `src/v2/run-issue.ts` repair helpers — feedback rounds are separate from the original cycle and reuse affected Closure/check/proof routing.
- [x] **Target:** `src/v2/run-issue.ts` and `src/v2/runtime.ts` implementation invocation — prepared/launched ownership, process-absence proof, attempt-owned report recovery, and unchanged-baseline relaunch rules are implemented.
- [x] **Validation:** Covered by the exact focused spec command: 79/79 passing.
- [x] **Exit Gate:** Both mandatory Closure lenses verified finite state, one active batch, affected Closure reuse, and process/report recovery.

### Slice 5 — Re-run checks and Acceptance Proof on repaired content

- [ ] **Test/Proof First:** Partial — the integrated continuation regenerates checks/proof and strict run-state tests bind nested verification to current top-level receipts; dedicated check/proof `needs-work` feedback-round fixtures remain absent.
- [x] **Target:** `src/v2/run-issue.ts` existing checking/proving flow — continuation-aware ordering and budget routing are implemented.
- [x] **Target:** `src/v2/checked-change.ts` and `src/v2/acceptance-proof.ts` required no changes because existing fingerprints distinguish the repaired snapshot.
- [x] **Validation:** Exact focused command is green and the earlier complete `npm test` run covered Acceptance Proof and code-review contracts.
- [x] **Exit Gate:** Run-state validation rejects stale or cross-batch checked/proof receipts before update publication.

### Slice 6 — Update the same branch and PR with crash-safe effects

- [ ] **Test/Proof First:** Partial — exact ref restoration, same-PR fast-forward happy path, activation interruption, generic publication recovery, malformed intents, and post-effect state failure are green; the exhaustive update-specific effect matrix remains absent.
- [x] **Target:** `src/v2/runtime.ts:LocalGitRunIssueAdapter` restores only from exact matching local/remote published refs and never resets or deletes user state.
- [x] **Target:** `src/v2/run-store.ts:PublicationIntent` contains exact review update commit/push/summary/final-label bindings.
- [x] **Target:** `src/v2/run-issue.ts` has a distinct `updateExistingPullRequest()` fast-forward saga with pre/post-push revalidation and exact effect reconciliation.
- [x] **Validation:** Covered by the exact focused spec command: 79/79 passing.
- [x] **Exit Gate:** Both mandatory Closure lenses verified intent matching, fast-forward-only refs, same-PR identity, and fail-closed divergence.

### Slice 7 — Daemon discovery, documentation, and package boundary

- [x] **Test/Proof First:** `test/v2-cli.test.ts` covers auto/review union, deduplication, serial reuse, stable-output suppression, and changed continuation epochs.
- [x] **Target:** `src/v2/cli.ts:executeProductionDaemon` implements one serial path and in-memory result fingerprinting only.
- [x] **Target:** `README.md` and `docs/deep-dive.md` document the implemented trigger, trust, labels, three-round budget, same-PR fast-forward, recovery, and human-owned resolution.
- [x] **Target:** ADR, live-smoke checklist, and changelog are updated without a version bump or release.
- [x] **Validation:** CLI/run/package tests are covered by focused/full evidence; `verify:workflow` passes and exact `npm pack --dry-run --json` reports 275 expected entries with no tests/spec/research files.
- [x] **Exit Gate:** Documentation and package inventory agree on one Runner-owned lifecycle with no generated drift.

## Review Focus

- **Mandatory Lenses:** Architecture/Execution — one lifecycle, state migration, ownership/locality, separate budgets, worktree restoration, no second review engine; Failure/Contracts — GitHub pagination/identity/permission, immutable batching, replay/idempotency, stale refs, receipt invalidation, effect reconciliation, exact terminal transitions.
- **Targeted Recipes:** Contract-test ledger; state transition and migration table; intent-before-effect fault injection; adapter malformed/pagination fixtures; authorization revocation and branch-divergence adversarial cases.
- **Bug Classes:** Terminal resurrection without authority; batch hash instability; source replay; ID/body/permission time-of-check/time-of-use drift; state downgrade/data loss; cycle overflow; stale check/proof reuse; duplicate commit/comment; wrong PR update; force-push fallback; daemon output/effect loop; worker credential leakage.

## Write Scope Summary

- `src/v2/review-feedback.ts` — Create; durable contracts, hashing, transitions, validation.
- `src/v2/review-feedback-coordinator.ts` — Create; trusted observation/freeze/revalidation boundary.
- `src/v2/adapters/pull-requests.ts` — Update; normalized review and PR-comment adapter contracts/in-memory fixture.
- `src/v2/adapters/gh-pull-request-adapter.ts` — Update; GitHub GraphQL/REST implementation.
- `src/v2/run-store.ts` — Update; V2 migration, review-feedback state, update intents/invariants.
- `src/v2/direct-delivery.ts` — Update; `pr-review` repair provenance.
- `src/v2/run-issue.ts` — Update; controlled continuation, budget routing, update publication/recovery.
- `src/v2/runtime.ts`, `src/v2/adapters/worktree.ts` — Update; dependency wiring, exact continuation worktree restoration, worker input.
- `src/v2/route-decision.ts` — Update only to validate nested feedback against existing lifecycles; do not add a top-level lifecycle.
- `src/v2/cli.ts` — Update; review-label daemon discovery and in-memory duplicate output suppression.
- `test/v2-gh-pull-request-adapter.test.ts`, `test/v2-review-feedback-contract.test.ts`, `test/v2-review-feedback-coordinator.test.ts` — Create; focused contracts.
- Existing affected V2 tests — Update; lifecycle, migration, review, recovery, CLI, containment, package regressions.
- `README.md`, `docs/deep-dive.md`, `docs/adr/0001-runner-owned-loop-policy.md`, `docs/live-smoke-checklist.md`, `CHANGELOG.md` — Update; authoritative behavior and verification documentation.

## Halt Conditions

- Stop without implementation if current code no longer has one marker-bound same-repository draft PR per successful direct run or if another active change owns overlapping `RunIssue`/run-state continuation contracts.
- Stop and request a product decision if trust must include external requested reviewers without `write/admin`; this spec intentionally excludes that authority model.
- Stop if GitHub GraphQL cannot return complete unresolved review threads with stable IDs and pagination under the production token; do not infer resolution from REST comments.
- Stop if V1 state cannot be losslessly normalized and atomically emitted as V2 while preserving generation and terminal outcomes; do not add a sidecar state file.
- Stop if same-branch fast-forward cannot be proven from persisted/local/remote SHAs; do not repair with reset, rebase, amend, or force push.
- Stop before any live GitHub smoke invocation until the user explicitly authorizes `npm run smoke:live` against the configured scratch repository.

## Implementation Review State

- **Profile / Mode:** `high` / parallel `Full` review.
- **Authority:** this approved implementation spec at HEAD `2d72827fdb53800b09fb37ba04ca4d2d69117de2` plus the settled working-tree implementation.
- **Pinned Target:** implementation content fingerprint `8e30e7a667aacd83623591ea94e15aa19c5a589403c1ade34cbe176dd64e47b9`; the spec review-state append and unrelated `docs/research/2026-07-27/1549-humanlayer-current-product.md` are excluded.
- **Assigned Lenses:** Architecture/Execution and Failure/Contracts, one independent `reviewer_deep` lineage each.
- **Launch Handles:** Architecture/Execution `019fa3f4-bbcc-70e1-8e19-ac09598b9d83`; Failure/Contracts `019fa3f4-bcf7-7ec1-acfb-1045c84d6021`.
- **Full Result:** both lineages rejected fingerprint `8e30e7a667aacd83623591ea94e15aa19c5a589403c1ade34cbe176dd64e47b9`; repairs are pinned at fingerprint `15787f21e6d8ba9c6fa0fa7dafeff1ca6e97e1b4cd6503f4e78690b01b6ebf61` for affected Closure.
- **Closure Repair:** Failure/Contracts reopened `IMPL-REV-001`; the issue-state guard repair is pinned at fingerprint `d8ea37882b6c53e14caa0b9374cd257e5f3e3a6b4655f847c0fe490c509f356b` for follow-up Closure.
- **Final Closure:** Both original lineages verified the `OPEN` authority repair; the Architecture/Execution lineage confirmed its assigned defects remain verified, the Failure/Contracts lineage reopened none, and both accepted the finite test-only polling deadline delta. No new actionable defect or accepted risk remains.
- **Post-smoke Delta Review:** Both Full reviewers rejected fingerprint `075264669c3a2510ff4322c761dfbf15c1e7df0e3f053d0f4a67bdff69c75527`. Successive Closure rounds repaired `IMPL-REV-013` through `IMPL-REV-019`, including exact blocked-label source guards and restart reconciliation of a terminal-CAS failure after blocked-label readback. The final affected-code fingerprint `587f2c090107fedf43adf5adc96c8338d73d47b3e06bfca792004eb4b2a9db85` was independently verified with no reopened defect by the original Architecture/Execution lineage `019fa66a-871f-7873-b73a-9ba9ee014f20` and Failure/Contracts lineage `019fa66a-87f9-7333-8fa4-c5627046d6bd`.
- **Residual Coverage Gap:** Containment passes against the installed Codex CLI after removing the obsolete configured version pin, and the final full suite is green 291/291. Dedicated exhaustive fault matrices listed in the unchecked proof rows remain absent.

## Implementation Defect Ledger

- `IMPL-REV-001` — **execution-risk / high / verified** — invariant: continuation effects require current trusted issue authority; failure: revoked `agent:review` or claim state can activate, launch, or publish.
- `IMPL-REV-002` — **execution-risk / high / verified** — invariant: activation intent reconciles either side of its label effect without consuming a round; failure: a crash strands `frozen` or increments the feedback budget.
- `IMPL-REV-003` — **execution-risk / high / verified** — invariant: a launched implementation attempt is absent and its attempt-owned report is recovered before relaunch; failure: restart duplicates a worker or loses a valid result.
- `IMPL-REV-004` — **execution-risk / high / verified** — invariant: feedback implementation safe-halt retains one valid process owner through quiescence; failure: validator rejection drops durable process ownership.
- `IMPL-REV-005` — **execution-risk / high / verified** — invariant: restart in `proving` replays the same round; failure: crash alone increments or exhausts the three-round budget.
- `IMPL-REV-006` — **execution-risk / high / verified** — invariant: trusted bodies and verification receipts bind to the active batch and current top-level proof identities; failure: corrupted V2 state publishes stale or cross-batch evidence.
- `IMPL-REV-007` — **execution-risk / high / verified** — invariant: every implementation launch receives fresh issue and PR-source authorization; failure: report-repair launches run after authority drift.
- `IMPL-REV-008` — **execution-risk / medium / verified** — invariant: every persisted update intent exactly matches the effect it reconciles; failure: resume recomputes and applies a different summary, label, branch, or ref target.
- `IMPL-REV-009` — **execution-risk / medium / verified** — invariant: local and remote branch refs equal the published head before an absent worktree is restored; failure: restoration creates a worktree on an extra local descendant.
- `IMPL-REV-010` — **execution-risk / medium / verified** — invariant: changed successful epochs and stable blockers have distinct, suppressible daemon output; failure: a new successful batch is hidden or an unchanged blocker is emitted every poll.
- `IMPL-REV-011` — **execution-risk / medium / verified** — invariant: REST review actors and collection reads fail closed within explicit bounds; failure: malformed actor types become human or unbounded pagination downloads before rejection.
- `IMPL-REV-012` — **improvement / low / verified** — invariant: one durable owner exists for publication receipts and feedback-batch retry counters; failure: a dead receipt field and inherited Full-review counters create drift.
- `IMPL-REV-013` — **execution-risk / high / verified** — invariant: containment binds the installed executable bytes/path and current orchestrator package without pinning a release number; failure: a same-version replacement or package drift reuses stale authority evidence.
- `IMPL-REV-014` — **execution-risk / high / verified** — invariant: issue authority and frozen feedback are revalidated immediately before reviewer and proof worker launches; failure: revoked or edited authority still launches a worker after checks.
- `IMPL-REV-015` — **execution-risk / high / verified** — invariant: the observed review-update commit SHA/tree are durably handed to push; failure: restart reconstructs and publishes an unproved replacement commit.
- `IMPL-REV-016` — **execution-risk / medium / verified** — invariant: retryable GitHub reads preserve the active batch and publication intent; failure: a transient timeout becomes a non-resumable safety block.
- `IMPL-REV-017` — **execution-risk / medium / verified** — invariant: fail-closed observation and active terminal paths preserve append-only feedback history; failure: prior consumed IDs and publication receipts disappear.
- `IMPL-REV-018` — **execution-risk / medium / verified** — invariant: an owned active feedback blocker reconciles exact blocked labels before terminal persistence and resumes that durable intent before publication dispatch after a crash; failure: terminal runs remain running/review discoverable or are incorrectly republished.
- `IMPL-REV-019` — **execution-risk / medium / verified** — invariant: daemon live smoke owns the only scratch candidate it can mutate; failure: another open candidate is changed outside run cleanup scope.

## Defect Closure Notes

- **Review Summary:** High-profile Full returned `Rejected` from both Architecture/Execution and Failure/Contracts. Consolidated repairs added explicit pre/post-push epochs, recoverable labels, total nested transition and budget tables, trusted-body isolation, repository/head/source correlation, V1 no-effect baseline bootstrap, phase-specific worktree/process recovery, canonical finding projection, exact commit/push reconciliation, and matching first-RED ledger rows. Affected Closure verified all defects; two reopened architecture contracts were repaired and verified in follow-up Closure.
- **Fixed Defects:** `NEW-ARCH-01`, `NEW-ARCH-02`, `NEW-ARCH-03`, `NEW-ARCH-04`, `NEW-ARCH-05`, `NEW-ARCH-06`, `NEW-ARCH-07`, `NEW-CONTRACT-01`, `NEW-CONTRACT-02`, `NEW-CONTRACT-03`, `NEW-CONTRACT-04`, `NEW-CONTRACT-05`, `NEW-CONTRACT-06`, `NEW-CONTRACT-07`.
- **Verified Defects:** `NEW-ARCH-01`, `NEW-ARCH-02`, `NEW-ARCH-03`, `NEW-ARCH-04`, `NEW-ARCH-05`, `NEW-ARCH-06`, `NEW-ARCH-07`, `NEW-CONTRACT-01`, `NEW-CONTRACT-02`, `NEW-CONTRACT-03`, `NEW-CONTRACT-04`, `NEW-CONTRACT-05`, `NEW-CONTRACT-06`, `NEW-CONTRACT-07`.
- **Accepted Risks:** None.
- **Open Defects:** None.

## 4. Validation And Done Criteria

- [x] **Lint/Format:** `git diff --check` passes; no separate lint script exists.
- [x] **Typecheck/Build:** `npm run typecheck` and clean `npm run build` pass.
- [ ] **Tests:** Exact focused command passes 79/79; focused containment/config/setup/process passes 38/38; the current full suite passes 291/291; containment uses whichever Codex CLI version is installed. Dedicated fault-matrix coverage gaps listed above remain.
- [x] **Architecture Check:** `verify:workflow` passes; exact `npm pack --dry-run --json` succeeds with 275 entries, both new runtime modules, and no tests/spec/research files; mandatory high-profile Closure has no open defect.
- [x] **Documentation:** `README.md`, `docs/deep-dive.md`, ADR, live-smoke checklist, and changelog are cross-checked against the final lifecycle.
- [x] **Live/Manual Proof:** User-authorized scratch-repository smoke covered all 13 current scenarios. Run `20260728-full-review-feedback-7` passed the first 11 scenarios, including `review-feedback-continuation` with 7 real `gpt-5.6-luna` calls; its only failure was an obsolete quality-state assertion. Run `20260728-final-negative-gates` then passed the corrected `quality-gates` and `safety-negative` scenarios. Both runs report `Strict cleanup passed`.
- [ ] **Behavior Proof:** The complete in-memory happy path and several interruption/drift paths are green, but the exhaustive update-publication and three-round fault matrices listed above are not all represented by dedicated fixtures.
- [x] **Reconciliation:** Every unchecked item is explicitly recorded as a validation or coverage gap; no scope is silently reported complete.
- [x] **Final Handoff Requirements:** Final response will report migration/adapter/publication evidence, exact command results, segmented complete live-smoke evidence, and the no-auto-resolve/no-force-push guarantees.
