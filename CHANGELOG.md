# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows SemVer.

## [Unreleased]

## [0.1.44] - 2026-07-07

### Added
- Added typed runner blocker evidence and bounded report/evidence repair so
  safe completion-report or review-handoff failures can be repaired without
  weakening publication gates.
- Added focused live-smoke and unit coverage for incomplete progress retry,
  typed blocker repair, and daily self-improvement issue limits.

### Changed
- Scoped review reports now keep handoff output shorter while preserving the
  evidence the runner needs for publication decisions.
- Daily self-improvement runs now limit issue churn so repeated runs produce
  fewer redundant follow-up issues.

### Fixed
- Scoped implementation runs can retry incomplete agent progress after an idle
  timeout when the runner can prove safe progress in the worktree.

## [0.1.43] - 2026-07-06

### Added
- Added `codex-orchestrator acceptance-proof validate --report <path>` so proof
  agents can check machine-readable Acceptance Proof reports before handoff.

### Changed
- Adaptive Acceptance Proof prompts now include a minimal valid JSON report
  template generated from the runner-owned report contract instead of a long
  prose schema line.
- Malformed adaptive proof reports now return all structural schema errors at
  once and get one proof-report repair attempt before hard-blocking.

## [0.1.42] - 2026-07-06

### Changed
- Runner terminal handoff now uses one shared outcome module for review-ready,
  blocked, and promotion-requested finalization across scoped, recovered, parent,
  and child paths.
- Draft PR handoff, terminal labels, comments, Durable Run Summary evidence, and
  child state cleanup now share focused ordering tests instead of relying on
  repeated per-path mutation sequences.

## [0.1.41] - 2026-07-03

### Added
- Added a focused `plan-auto-tree-recovery` live-smoke scenario that prepares
  stale runner-owned parent state, recovered closed child evidence, and
  retryable blocked child rework in the scratch repository.

### Fixed
- `codex-orchestrator run --issue` can now enter plan-auto parent recovery for
  open `agent:plan-auto` issues that still carry `agent:running`, while keeping
  child-labeled and unsafe cases behind the existing recovery safety checks.

## [0.1.40] - 2026-07-03

### Changed
- Live smoke now defaults to a smaller `core-release` profile, exposes explicit
  scenario profiles, and folds related commit, safety, and Acceptance Proof
  checks into matrix scenarios.
- Runner rework now uses a first-class `ReworkDecision` contract with explicit
  retry, exhausted, and hard-block outcomes across scoped, recovery, and
  issue-tree child paths.
- Quality gates now prefer structured TDD evidence in `validation[]`, while
  keeping legacy validation summaries as a fallback.
- Figma MCP policy now distinguishes optional design context from required
  design access: optional failures retry without MCP, required failures block.
- Added focused live-smoke coverage for tree-child quality-gate rework:
  `npm run smoke:live -- --scenario tree-child-quality-rework --cleanup`.

## [0.1.39] - 2026-07-02

### Fixed
- Fixed full live smoke plan-child fixtures so issue-tree children write only
  to their declared ownership paths.
- Fixed browser-proof live smoke execution so packaged visual proof reads target
  config while validating proof artifacts from the issue worktree.

## [0.1.38] - 2026-07-02

### Added
- Added risk-routing review gates so runner handoffs can require plan review,
  cleanup review, or code review evidence before publication.
- Added risk and review-gate metadata to scoped, parent, and child orchestration
  handoffs so downstream agents inherit the correct validation expectations.

### Changed
- Updated bundled workflow prompts to report risk classification and review-gate
  completion consistently across PRD, issue breakdown, scoped implementation,
  parent orchestration, and Acceptance Proof flows.

## [0.1.37] - 2026-07-01

### Changed
- Publishability checks now drop runner-owned visual proof skip notes when the
  changed files do not require the visual proof gate.
- Local self-improvement daily phase summaries now share one helper for failure
  classification, exit-code impact, and summary rendering.

## [0.1.36] - 2026-05-21

### Added
- Added package-owned browser visual proof for web UI Acceptance Proof, with
  scenario-driven navigation, screenshots, DOM snapshots, console/network logs,
  and machine-readable UI Evidence reports.
- Added `visual-proof auto` dispatch so setup can route web changes to browser
  proof and mobile changes to device-backed proof from one package-owned
  command.
- Added live smoke coverage for the browser proof path, including packaged CLI
  execution and browser runtime evidence.

### Changed
- Browser proof now prefers an explicit or locally installed Chrome, Chromium,
  or Edge executable before falling back to Playwright-managed Chromium
  download.
- Live smoke daemon retries now tolerate transient GitHub failures during
  browser-proof runs.

## [0.1.35] - 2026-05-21

### Added
- Added a runner-validated UI Evidence Contract for Acceptance Proof reports,
  covering workflow, viewport, freshness, layout, copy, and source-input
  evidence for screenshot and UI-dump artifacts.
- Added live smoke coverage for UI Evidence pass and blocking cases, including
  missing UI Evidence and too-narrow desktop viewport proof.

### Changed
- Runner-owned visual proof no longer treats screenshot-only command success as
  a pass path; proof commands must produce a valid machine-readable Acceptance
  Proof report.
- Updated the legacy `visual-proof` live smoke scenario to emit the same
  machine-readable UI Evidence report required by the runner.

## [0.1.34] - 2026-05-20

### Added
- Added an Adaptive Proof Agent Codex phase for scoped and issue-tree child
  runs, with runner-provided proof report paths, artifact directories, changed
  file context, and proof-owned repair policy.
- Added durable Acceptance Proof attempt evidence in lifecycle events, run
  summaries, blocked comments, review reports, and issue-tree PR handoff.
- Added package-bundled Acceptance Proof workflow prompts and setup routing for
  the new proof phase.

### Changed
- Parent `agent:plan-auto` child waves now block parent publication when a child
  Acceptance Proof attempt fails, requests rework, or is blocked.
- Proof attempts now use isolated Codex homes and preserve proof artifacts while
  keeping publication authority runner-owned.

## [0.1.33] - 2026-05-20

### Added
- Added canonical `reviewGates.acceptanceProof` policy with proof-owned path
  classification and machine validation for high-confidence proof reports.
- Added live smoke scenarios for canonical Acceptance Proof pass, proof rework,
  low-confidence blocking, and proof-phase product-diff blocking.

### Changed
- Kept `reviewGates.visualProof` as a compatibility adapter while routing
  runner prompts and proof policy through Acceptance Proof.
- Proof-phase product-code changes now block publishability instead of being
  silently committed as verification output.

## [0.1.32] - 2026-05-19

### Added
- Added package-owned `visual-proof mobile`, `visual-proof android`, and
  `visual-proof ios` commands for reusable UI launch proof across installed
  repositories.
- Mobile visual proof now supports Flutter Android, native Android, Flutter iOS,
  and native iOS projects, with screenshots saved into runner proof artifacts.

### Changed
- Setup now defaults visual proof to
  `codex-orchestrator visual-proof mobile --issue ${issueNumber}` instead of a
  target-repo local proof script.
- Android proof resolves SDK tools from environment variables, `PATH`, and
  default macOS, Linux, and Windows SDK locations.
- On macOS, mobile proof falls back to the iOS simulator when Android tooling or
  devices are unavailable and the repo has an iOS target.

## [0.1.30] - 2026-05-18

### Added
- Runner setup now records an explicit remote base branch so scoped and
  issue-tree worktrees start from the same branch that PRs target.
- Context snapshots and live smoke now prove the resolved remote base ref and
  SHA used for autonomous runs.

### Changed
- Doctor now checks the configured remote base branch instead of trusting the
  currently checked-out local branch, and warns about legacy base config.
- Existing Codex branches from a different base are blocked on resume instead
  of being reset, deleted, or rebased automatically.
- Prompt conflict reports now give agents explicit keep, merge, and replace
  actions so users get a concrete choice instead of a bare warning.
- Mobile proof guidance now separates native Android, Flutter Android, and
  native iOS validation paths so platform-specific cache/tooling recovery is not
  applied to the wrong project type.

## [0.1.29] - 2026-05-18

### Added
- Setup now records a prompt manifest and supports `--sync-prompts` modes for
  safe prompt refreshes, local-edit preservation, replacement, and appended
  package updates.
- Doctor now warns when package prompt updates are available and points users to
  the setup command that applies safe prompt updates.

## [0.1.27] - 2026-05-18

### Changed
- Setup and docs now describe the package-bundled workflow prompt model
  clearly, so installed repositories do not depend on local Codex `SKILL.md`
  files.
- `agent:auto` is reserved for standalone scoped issues, while issue-tree
  children use only `agent:child` plus runner metadata and are executed by their
  parent `agent:plan-auto` flow.
- The default workflow prompts are full package-bundled workflows instead of
  fallback stubs, with setup preserving project-owned prompt edits by default.

## [0.1.26] - 2026-05-16

### Added
- Runner diagnostics wave: read-only `doctor`, `status --json`, phase-specific
  Codex profiles, lifecycle events, and bounded context snapshots before Codex
  sessions.
- Live smoke coverage for diagnostics/profile evidence through the packaged CLI.

### Changed
- Status and handoff evidence now point to bounded runner artifacts instead of
  requiring operators to inspect raw Codex transcripts.

## [0.1.25] - 2026-05-15

### Added
- Runner-owned Loop Policy controls for daemon priority selection, bounded
  rework, optional Fresh-Context Review, Durable Run Summaries, and
  non-mutating Policy Suggestions.

### Changed
- Scoped and issue-tree handoff reports now include stronger runner-owned
  evidence before draft PR publication, while keeping GitHub publication,
  labels, comments, merges, releases, and deploys outside Agent authority.

## [0.1.24] - 2026-05-14

### Changed
- Mobile UI verification guidance now gives an explicit adb/emulator preflight
  for Android mobile app work, prefers a connected device before emulator
  fallback, tells agents to try loading Test Android Apps when unavailable, and
  treats missing plugin/device targets as a warning rather than a blocker.

## [0.1.23] - 2026-05-14

### Added
- Automatic GitHub release notes on publish (tag + generated release notes), so each npm publish can have matching GitHub “what changed”.
- Published `CHANGELOG.md` in the npm package, so the npm page can show a clear “what changed” history without leaving the registry.

### Changed
- Started maintaining this changelog so release-by-release improvements are easy to scan.

## [0.1.22] - 2026-05-14

### Added
- Less “false red” friction across repos:
  - If a repo doesn’t have a script like `typecheck`, the runner can treat it as a warning instead of blocking the whole run.
  - Optional lint baseline mode to keep progress moving when the repo has existing lint debt, while still keeping touched files clean.
- One automatic “rework” retry for common fixable blockers, so the agent can self-correct once instead of stopping immediately.

### Changed
- UI proof is Playwright-oriented and non-blocking: missing/failed visual proof is reported as a warning so it doesn’t stop unrelated progress.

## [0.1.21] - 2026-05-14

### Added
- A more “productized” runner experience:
  - Clearer, more consistent review handoff reports (what changed, what was validated, what remains risky).
  - A stronger live-smoke harness so you can trust that publishing gates behave the same way every time.
  - Safer path policy so the runner can reason about “what changed” consistently across OS/path quirks.
  - Setup now avoids committing/generated runtime folders by default, reducing repo noise.

## [0.1.20] - 2026-05-13

### Added
- A more reliable execution loop for both scoped issues and issue trees:
  - Durable, structured completion reporting so the runner can validate outcomes instead of trusting free-form text.
  - Better timeouts/logging so failures are actionable and don’t require re-running blindly.
  - Runner-owned screenshot proof support (so visual validation can be enforced consistently).

### Changed
- Stronger “runner owns publication” boundaries (the runner stays the source of truth for commits/push/PRs and safety checks).

## [0.1.19] - 2026-05-12

### Changed
- Cleaner, more predictable runs by isolating Codex session state away from the target repo and cleaning it up afterward (reduces leaked state and cross-run flakiness).

## [0.1.16] - 2026-05-12

### Added
- Initial release: a reusable GitHub Issues-driven runner that can take an authorized issue, run Codex in an isolated worktree, enforce project checks/policy, and hand back a draft PR (including parent planning + dependency-aware child execution).
