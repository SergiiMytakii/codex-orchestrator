# Repository Routing

Keep this file limited to repository-specific facts. Global skills and agent
policy own TDD, review order, commit behavior, and response style.

## Read First

- Product workflow and commands: `README.md`.
- Coding, validation, live-smoke, and release routing:
  `docs/agents/execution-routing.md`.
- Runner architecture and policy: current `src/v2/` code, configuration, tests,
  `CONTEXT.md`, and relevant ADRs under `docs/adr/`.
- Issues, triage, and domain language: `docs/agents/issue-tracker.md`,
  `docs/agents/triage-labels.md`, `docs/agents/domain.md`, and `CONTEXT.md`.
- Live-smoke scenarios and release history: `docs/live-smoke-checklist.md` and
  `CHANGELOG.md`.

## Repository Boundaries

- `docs/deep-dive.md` is a human-maintainer guide. Agents must not read or use
  it as context unless the user explicitly asks to edit or audit that file.
- Reusable TypeScript orchestration belongs in `src/v2/`, its package-owned
  adapters in `src/v2/adapters/`, and tests in `test/v2-*.test.ts`.
- Target-repository policy belongs under `.codex-orchestrator/`; its
  `config.json` is the exact V2 checks, branch, proof, deny, and label policy.
- Never read, print, or edit `.env` or `.env.*` files.
- A requested intermediate commit is not a final handoff; final review gates do
  not block that commit.

## Publication

- Releases are published by pushing the release commit to `main`. Do not run
  `npm publish` manually unless the GitHub release workflow is unavailable.
- `npm run smoke:live` mutates real GitHub issues, branches, and PRs. Run it
  only when the user explicitly requests live smoke.
