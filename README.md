# codex-orchestrator

`codex-orchestrator` is a reusable npm package and CLI for coordinating Codex work from GitHub Issues.

This repository is intentionally separate from IntelliOutreach. It is not an IntelliOutreach workspace package, and installed projects should keep their own policy under `.codex-orchestrator/`.

## Initial scope

The first package contract supports:

- GitHub Issues as the work source.
- A local runner boundary.
- A Codex adapter boundary, starting with `codex-cli`.
- Project-local `.codex-orchestrator/` config.

Live GitHub polling, Codex execution, issue planning, worktree orchestration, pull request handoff, and setup commands are not implemented in this first scaffold.

## CLI

```sh
codex-orchestrator --help
codex-orchestrator --version
codex-orchestrator health
codex-orchestrator setup --target <path> --github-owner <owner> --github-repo <repo> --dry-run
```

The `health` command is a no-op local check for the initial CLI boot contract.

The `setup` command creates project-local configuration under `.codex-orchestrator/`.
Use `--dry-run` to validate the config plan, label status, workflow sources, checks, branch naming, and pull request policy without writing files or launching Codex.

Setup never commits changes and never opens a setup pull request.

Useful setup flags:

- `--prepare-labels` creates missing GitHub labels through the local `gh` CLI when not in dry-run mode.
- `--skills-root <path>` changes where existing local Codex skills are detected.
- `--replace-package-skills` allows package-owned prompt files under `.codex-orchestrator/prompts/` to be replaced.

By default, setup reports missing labels only and never overwrites existing prompt files.

## Project config

Generated config is written to `.codex-orchestrator/config.json`. It records labels, workflow prompt paths, validation checks, deny rules, concurrency, branch naming, pull request templates, and issue classification settings.

Runtime process state is excluded from committed config. State directories may be configured as policy paths, but active sessions, locks, retries, worktrees, and cache snapshots are not valid config.

## Workflow prompts

The package ships original setup and workflow fallback prompts under `prompts/`. Setup copies them into `.codex-orchestrator/prompts/` when a target repository does not already provide prompt files.

If compatible local skills exist, setup records them as `existing-skill`. Missing workflow capabilities use package-owned prompt fallbacks.

## Development

```sh
npm test
npm run build
npm run typecheck
```

## npm publication

Publishing to npm is out of scope until separately approved. This scaffold establishes the package contract, tests, and repository boundary only.
