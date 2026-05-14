# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows SemVer.

## [Unreleased]

### Added
- Automatic GitHub release notes on publish (tag + generated release notes), so each npm publish can have matching GitHub “what changed”.

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
