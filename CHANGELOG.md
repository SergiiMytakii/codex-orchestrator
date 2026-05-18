# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows SemVer.

## [Unreleased]

### Changed
- Prompt conflict reports now give agents explicit keep, merge, and replace
  actions so users get a concrete choice instead of a bare warning.

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
