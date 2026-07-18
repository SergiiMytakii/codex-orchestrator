# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows SemVer.

## [Unreleased]

### Changed
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
