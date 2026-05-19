# Repository Routing
## Start Here
This file is the short routing layer for agents working on
`codex-orchestrator`. Keep detailed rules in linked docs.
- Product workflow: `README.md`.
- Runner architecture and policy model: `docs/deep-dive.md`.
- Runner-owned loop ADR: `docs/adr/0001-runner-owned-loop-policy.md`.
- Agent execution and quality preflight: `docs/agents/execution-routing.md`.
- Live smoke coverage: `docs/live-smoke-checklist.md`.
- Release history: `CHANGELOG.md`.

## Repo Map
- `src/` contains the TypeScript package source.
- `test/` contains Node test runner coverage.
- `prompts/` contains package-bundled workflow prompts copied by setup.
- `.codex-orchestrator/config.json` owns this repo's checks, review gates, deny
  rules, branches, and workflow prompt routing.

## Non-Negotiables
- The runner owns GitHub publication: agents must not push, open PRs, merge,
  publish, deploy, or mutate GitHub issues, labels, or comments outside runner
  code paths.
- Never read, print, or edit secret files such as `.env` or `.env.*`.
- Keep reusable orchestration logic in the package and target-repo policy under
  `.codex-orchestrator/`.
- `codex-orchestrator` is published by pushing the release commit to `main`; do
  not run `npm publish` manually unless the GitHub release workflow is
  unavailable.

## Task Routing
- For behavior-changing code, use the global TDD routing rule before editing.
- For docs-only changes, do not use TDD and do not run live smoke.
- For medium or large implementation changes, apply cleanup and final review
  gates before handoff.
- When imports, modules, jobs, services, scripts, cross-module wiring, runner
  policy, or publication boundaries change, run the quality preflight in
  `docs/agents/execution-routing.md` first.

## Release
- When cutting a release, update the latest release summary below with 2-6
  functional bullets.
- Update `CHANGELOG.md` with human-readable "what got better" notes.
- Run `npm run smoke:live` only when the user explicitly requests a live smoke
  run; it creates or updates real GitHub issues and PRs.

### Latest Release
- `0.1.30` (2026-05-18):
  - Setup stores an explicit remote base branch for Codex PRs.
  - Scoped and issue-tree root branches start from the resolved remote base SHA.
  - PR creation verifies GitHub opened the draft against the expected base
    branch.
  - Doctor reports configured remote base readiness and warns about legacy or
    mismatched Codex branches.

## Final Response
Keep final answers short: state what changed, what was verified, and any
remaining risk or skipped validation.
