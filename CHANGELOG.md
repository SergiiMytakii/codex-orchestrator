# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows SemVer.

## [Unreleased]

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
