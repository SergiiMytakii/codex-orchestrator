# Repository Routing

## Start Here

This file is the short routing layer for agents working on
`codex-orchestrator`. Keep detailed rules in linked docs.

- Product workflow: `README.md`.
- Runner architecture and policy model: `docs/deep-dive.md`.
- Runner-owned loop ADR: `docs/adr/0001-runner-owned-loop-policy.md`.
- Agent execution and quality preflight: `docs/agents/execution-routing.md`.
- Repo-local Dreaming-lite memory: `docs/agents/memory/README.md`.
- Live smoke coverage: `docs/live-smoke-checklist.md`.
- Release history: `CHANGELOG.md`.

## Repo Map

- `src/` contains the TypeScript package source.
- `test/` contains Node test runner coverage.
- `prompts/` contains package-bundled workflow prompts copied by setup.
- `.codex-orchestrator/config.json` owns this repo's checks, review gates, deny
  rules, branches, and workflow prompt routing.

## Non-Negotiables

- Never read, print, or edit secret files such as `.env` or `.env.*`.
- Keep reusable orchestration logic in the package and target-repo policy under
  `.codex-orchestrator/`.
- `codex-orchestrator` is published by pushing the release commit to `main`; do
  not run `npm publish` manually unless the GitHub release workflow is
  unavailable.

## Task Routing

- For behavior-changing code, use the global TDD routing rule before editing.
- For docs-only changes, do not use TDD and do not run live smoke.
- For repeated runner/debug/agent-workflow lessons, use
  `docs/agents/memory/README.md` as a curated recall cache, not as mandatory
  policy.
- For medium or large implementation changes, apply cleanup and final review
  gates before handoff.
- When imports, modules, jobs, services, scripts, cross-module wiring, runner
  policy, or publication boundaries change, run the quality preflight in
  `docs/agents/execution-routing.md` first.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for
`SergiiMytakii/codex-orchestrator`. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the default mattpocock/skills labels: `needs-triage`,
`needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See
`docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo with root `CONTEXT.md` and root `docs/adr/`.
See `docs/agents/domain.md`.

## Release

- When cutting a release, update the latest release summary below with 2-6
  functional bullets.
- Update `CHANGELOG.md` with human-readable "what got better" notes.
- Run `npm run smoke:live` only when the user explicitly requests a live smoke
  run; it creates or updates real GitHub issues and PRs.

### Latest Release

- `0.1.42` (2026-07-06):
  - Review-ready, blocked, and promotion-requested finalization now share a
    terminal-outcome module.
  - Scoped runs, recovered scoped runs, parent plan-auto runs, and child
    handoffs now use one tested mutation ordering contract.
  - Durable Run Summary evidence, terminal labels, comments, draft PR handoff,
    and child state cleanup now have focused ordering coverage.

## Final Response

Keep final answers short: state what changed, what was verified, and any
remaining risk or skipped validation.
