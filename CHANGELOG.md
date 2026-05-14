# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows SemVer.

## [Unreleased]

## [0.1.22] - 2026-05-14

### Added
- Configurable check policy (`checksPolicy`) to reduce false-negative blockers across heterogeneous repos:
  - Missing `npm run <script>` checks can be treated as warnings (skipped) instead of hard failures.
  - Optional lint baseline handling to downgrade repo-wide lint failures when a touched-files lint command passes.
- Scoped execution “rework retry” (one automatic retry) for common fixable blockers, with an explicit rework section in the prompt.

### Changed
- Runner-owned visual proof is Playwright-oriented; missing/failed visual proof is surfaced as warnings rather than blocking publication.

## [0.1.21] - 2026-05-14

### Added
- Baseline runner workflows, gates, and live smoke harness.

