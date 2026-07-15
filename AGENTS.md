# Repository Routing

Keep this file limited to repository-specific facts. Global skills and agent
policy own TDD, review order, commit behavior, and response style.

## Read First

- Product workflow and commands: `README.md`.
- Coding, validation, live-smoke, and release routing:
  `docs/agents/execution-routing.md`.
- Runner architecture and policy: `docs/deep-dive.md` and
  `docs/adr/0001-runner-owned-loop-policy.md`.
- Issues, triage, and domain language: `docs/agents/issue-tracker.md`,
  `docs/agents/triage-labels.md`, `docs/agents/domain.md`, and `CONTEXT.md`.
- Optional recurring lessons: `docs/agents/memory/README.md`.
- Live-smoke scenarios and release history: `docs/live-smoke-checklist.md` and
  `CHANGELOG.md`.

## Repository Boundaries

- Reusable TypeScript orchestration belongs in `src/`; tests in `test/`;
  package-bundled workflow prompts in `prompts/`.
- Target-repository policy belongs under `.codex-orchestrator/`; its
  `config.json` is this repo's live checks, review, branch, deny, and prompt
  policy.
- Never read, print, or edit `.env` or `.env.*` files.
- A requested intermediate commit is not a final handoff; final review gates do
  not block that commit.

## Publication

- Releases are published by pushing the release commit to `main`. Do not run
  `npm publish` manually unless the GitHub release workflow is unavailable.
- `npm run smoke:live` mutates real GitHub issues, branches, and PRs. Run it
  only when the user explicitly requests live smoke.
