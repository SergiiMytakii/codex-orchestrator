# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows SemVer.

## [Unreleased]

## [2.0.18] - 2026-08-19

### Changed
- Synced the packaged Implement and To Tickets workflow guidance and evaluation
  contracts with the current local skills.

### Fixed
- Invalid feedback reports now recover through the bounded implementation
  continuation without losing the active issue-feedback contract.
- Live-smoke proof fault markers now persist in the shared Git directory across
  candidate worktrees.

## [2.0.17] - 2026-08-18

### Changed
- Simplified the agent workflow scope and refreshed the packaged implementer
  profile and workflow contracts around the authorized outcome.
- Expanded the live-smoke matrix to 17 distinct scenarios and strengthened its
  contract coverage, documentation, and test-audit evidence.

## [2.0.16] - 2026-08-14

### Changed
- Synced the packaged Plan and To Tickets workflows with the current local
  skills: tickets now record only confirmed binding decisions at incompatible
  seams, and every repaired packet revision receives a fresh semantic review.

### Fixed
- Invalid implementation reports now retry the full implementation operation
  after the bounded report-repair path cannot produce a valid report.

## [2.0.15] - 2026-08-11

### Added
- Terminal outcomes now persist before independent best-effort issue comments
  and managed-label reconciliation, with bounded restart-safe recovery.
- Trusted issue comments can answer questions or continue in-scope repairs on
  the same Run, branch, and draft PR through fresh checks, proof, and review.

### Fixed
- Feedback publication retains exact durable effects across retryable
  authorization checks and preserves the freshly observed PR identity and URL.
- Public terminal and feedback text redacts credential material and generic
  host paths without rejecting relative artifact references or XML evidence.

## [2.0.14] - 2026-08-10

### Fixed
- Blocked terminal runs now publish one redacted, bounded, idempotent issue
  comment with the blocker reason and attempted actions before transitioning
  labels, including restart recovery without duplicate comments.

## [2.0.13] - 2026-08-10

### Fixed
- Split implementation blockers with and without reviewer rejection details
  into strict output-schema branches, so Codex Structured Outputs accepts
  implementation runs while preserving the runtime validator contract.

## [2.0.12] - 2026-08-10

### Changed
- Collapsed direct, approved spec-first, product-answer, and trusted PR-feedback
  delivery onto one Run-owned validation loop with exact Run/ActiveAttempt/
  PendingEffect recovery, clean state-schema cutover, checked-change authority,
  and intent-based publication.
- Bound packed scratch-smoke reports to a clean immutable source HEAD before
  package creation and retained strict scratch-only cleanup.

### Removed
- Removed legacy qualification, Full/Closure, operation-specific invocation,
  separate post-PR progression, compatibility/migration, and duplicate
  lifecycle ownership paths.

## [2.0.11] - 2026-07-30

### Added
- Added V2 candidate-bound `CheckedChange` contracts and optional candidate Git
  capability while preserving existing V1 payload and freshness semantics.
- Added run-state V3 migration with an exact raw-byte backup, pre-publication
  rollback guard, candidate bindings, execution leases, and retained commit
  intents for observation-only recovery.

### Changed
- Direct-route review, checks, and Acceptance Proof now execute from fresh
  detached materializations of one private-index-captured, ref-pinned Git tree.
  Publication creates and observes the exact single-parent commit from that
  tree before push, including restart-safe branch-CAS reconciliation.
- Recovery across direct, report-only, mutable worker, spec-author, review, and
  proof operations now uses one canonical attempt-owned invocation lifecycle.
  Infrastructure failures before recoverable output do not consume semantic
  budgets, while recovered Runner-classified output consumes its existing
  phase budget exactly once.
- Replaced the generic positive-proof live-smoke scenario with an
  `authoritative-candidate-publication` scenario that injects stale shared-index
  content and proves exact candidate-tree publication plus pin/materialization
  cleanup.
- Updated interrupted-worker live-smoke scenarios to prove bounded
  infrastructure clearing, delayed replacement launches, no accidental
  publication, deterministic process-absent output discard, and strict scratch
  ownership cleanup under the canonical recovery lifecycle.

### Fixed
- New issue worktrees now use a freshly fetched configured remote base and are
  created from its immutable pinned SHA. Base fetch failures remain unclaimed
  and safely retryable.

### Removed
- Removed the superseded operation-specific recovery owners and parallel state
  machines after each operation migrated to the canonical invocation lifecycle.

## [2.0.10] - 2026-07-29

### Fixed
- GitHub issue comment timestamps are canonicalized before run-state
  persistence, so second-precision API timestamps no longer prevent a fresh
  issue run from being created.

## [2.0.9] - 2026-07-29

### Changed
- Direct runs now require their scoped issue checks to pass before issue
  implementation. Red qualification checks receive a separate sealed, bounded
  repair operation and full-policy retry without consuming the issue
  implementation-cycle budget; launched repairs are restart-recoverable and
  resumed dirty worktrees qualify again before implementation.
- Final changed-worktree checks must all pass. New runs no longer compare
  failure output hashes or mint `unchanged-failure` success evidence, while
  historical run state and proof capabilities remain readable.

## [2.0.8] - 2026-07-29

### Changed
- Direct runs now resolve bounded verification commands from the frozen issue's
  command-only `Verification` section instead of forcing repository-wide checks.
  Scoped npm checks execute without a shell, while repositories without scoped
  verification retain their configured fallback policy.
- Check launch failures and proven-quiescent timeouts resume the same durable run
  without consuming an implementation cycle. Timeout and cancellation retain
  ownership until the complete process group is absent; uncertain quiescence
  fails closed as a non-resumable safety block.

## [2.0.7] - 2026-07-28

### Changed
- Blocked terminal outcomes now durably reconcile GitHub issue status before
  completion. Recovery removes stale `agent:running`, preserves unrelated
  labels, never restores revoked `agent:auto` authorization, and resumes safely
  after remote-effect or state-write interruption without rerunning work.
- Code-review coverage is now descriptive instead of byte-correlated. Closure
  normalizes outcome order, preserves stable defect identity across paraphrased
  prose, gives each target revision four report-only repairs, and can safely
  recover eligible legacy malformed-report terminals without rerunning
  implementation. Exhausted current revisions remain terminal.
- Configured checks now establish a clean-base baseline. A byte-identical
  failure on the changed worktree is retained as `unchanged-failure` evidence
  instead of being misclassified as task-owned rework; new or changed failures
  still consume the normal repair loop.
- After a trusted claim is established, `agent:auto` alone carries execution
  authorization; disappearance of the `agent:running` status label no longer
  causes an unrelated safety block.
- The trusted claim comment is now observed before adding the `agent:running`
  status label, with crash-safe compatibility for older label-first runs.

### Removed
- Removed the local containment certificate, canary command, and pre-claim
  certification gate. Authorized runs now start without operator-managed
  certification while retaining the fixed worker sandbox, scrubbed
  environment, denied network, and external-authority restrictions. This also
  removes the exported `RunIssueDependencies.validateContainment` member and is
  a breaking change for direct consumers of the low-level Runner API.

## [2.0.6] - 2026-07-28

### Changed
- Bound GitHub issue comments to the 16,384-code-unit persisted run-state
  contract on both read and write, with an explicit truncation marker and
  surrogate-safe Unicode handling.
- Treat issue-worktree creation failures as resumable local transport failures.
  The claimed run is preserved for an idempotent retry after local Git state or
  target configuration is corrected, and bounded local evidence retains the
  underlying Git diagnostic instead of collapsing it into a terminal
  `local-git-effect-failed`.
- Preserve valid claim markers that predate a new run as ID-bound audit history
  while continuing to block malformed, duplicate-current, replaced-history, and
  newly competing claim authority before triage, implementation, or publication
  effects; safely retain pre-upgrade snapshots through GitHub timestamps and
  refresh ordinary issue comments immediately before triage.
- Move Android Acceptance Proof device authority into the trusted Runner. A
  configured run now starts its own selected AVD with clean ephemeral data,
  owns the durable lease outside the contained worktree sandbox, builds and
  launches the app, waits for configured accessibility-label navigation,
  captures PID-bound visual evidence (including blocked navigation), and stops
  only its own emulator and removes its own data after terminal settlement.
  Preparation is durably fenced before emulator startup, the installed APK is
  an exact Runner-owned snapshot, process identity and artifact digests are
  revalidated across the workflow, and Android infrastructure failure is
  retained as a non-blocking unfinished-UI-proof warning.

## [2.0.5] - 2026-07-28

### Added
- Added durable continuation of successful direct runs from newly observed,
  trusted unresolved pull-request feedback. The same run now freezes an
  immutable batch, reuses affected Closure, reruns checks and Acceptance Proof,
  and appends one fast-forward commit plus one marker-bound summary to the same
  draft PR.

### Changed
- Removed the configured Codex CLI version pin. Setup and runtime now use the
  installed `codex` command, while the containment canary binds its actual
  version, canonical executable path and digest, plus the orchestrator package
  version, and rejects a stale certificate after any of those identities change.
- The daemon now discovers both `agent:auto` and `agent:review` issues, while
  suppressing unchanged `review-ready` output only within the current process.
- Run state now emits schema version 2 and losslessly reads version 1; migrated
  `review-ready` runs baseline existing feedback without executing it.
- Replaced overlapping legacy live-smoke profiles and scenario aliases with a
  single supplemental `v2-regression` matrix whose scenarios each exercise a
  distinct current V2 policy, recovery, diagnostics, proof, or quality gate.
- Pinned every model-backed live-smoke operation to real `gpt-5.6-luna`, with
  per-scenario model audit evidence and deterministic fault injection retained
  only around the real model result.
- Reduced the universal proof generation schema from 52 KB to 22 KB by keeping
  successful-proof semantics in generation while moving duplicated platform
  combinations to the existing strict runtime validator, reducing
  structured-output load without weakening final proof acceptance.
- Treats a zero-exit Codex invocation with a missing output report as a
  resumable transport failure, allowing the existing bounded retry to recover
  without weakening malformed-report validation.
- Repairs one schema-valid implementation report whose cumulative
  `changedFiles` omits current product changes, without consuming another
  implementation cycle or permitting worktree mutation; repeated mismatch
  remains fail-closed.

### Removed
- Removed unsupported configuration conversion, old workflow-manifest readers,
  obsolete run-state fallbacks, superseded prompts, and historical workflow
  planning artifacts. The repository and package now contain only the current
  V2 runtime and contracts.

### Security
- Review bodies can authorize repair only when bound to the exact PR head and a
  fresh immutable-user `write` or `admin` permission receipt. Source, permission,
  ref, worktree, or publication drift fails closed; no thread-resolution or
  force-push authority was added.

## [2.0.3] - 2026-07-18

### Changed
- Added durable `agent:waiting-human` questions, current-WRITE trusted answers,
  conflict clarification, permission revocation, and same-run rerouting before
  implementation.
- Replaced the two-file runtime skill lookup with one generated, manifest-bound
  package workflow containing the declared skills, profiles, operation wrappers,
  schemas, and shared review contracts.
- New runs pin an immutable workflow generation across implementation retries,
  restart, and Acceptance Proof; contained attempts enforce the operation's
  package-declared sandbox and no-external-authority policy.

### Security
- Workflow generation and attempt snapshots now fail closed on inventory,
  path, mode, owner, hash, policy, concurrent-publication, and tamper drift.

## [2.0.2] - 2026-07-18

### Changed
- Re-published the current V2 package line for downstream workspace upgrades.

## [2.0.0] - 2026-07-17

### Changed
- Introduced one public V2 CLI, one strict configuration contract, and one
  `runIssue` lifecycle shared by direct runs and the serial daemon.
- Reduced the default live release smoke to package install, normal default
  Codex, browser proof, and safety-negative scenarios; broader policy scenarios
  remain opt-in.

### Security
- Contained tool environments exclude GitHub, SSH, npm, and cloud publication
  credentials while preserving the explicitly accepted shared Codex-auth and
  same-user local-read behavior. Proof rejects credentials in every text
  artifact and applies public-only host-identity restrictions to evidence.
