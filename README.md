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
```

The `health` command is a no-op local check for the initial CLI boot contract.

## Development

```sh
npm test
npm run build
npm run typecheck
```

## npm publication

Publishing to npm is out of scope until separately approved. This scaffold establishes the package contract, tests, and repository boundary only.
