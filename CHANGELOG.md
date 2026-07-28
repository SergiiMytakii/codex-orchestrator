# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows SemVer.

## [Unreleased]

### Changed
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
