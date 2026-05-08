# codex-orchestrator

`codex-orchestrator` is a reusable npm package and CLI for coordinating Codex work from GitHub Issues.

This repository is intentionally separate from IntelliOutreach. It is not an IntelliOutreach workspace package, and installed projects should keep their own policy under `.codex-orchestrator/`.

## Initial scope

The first package contract supports:

- GitHub Issues as the work source.
- A local runner boundary.
- A Codex adapter boundary, starting with `codex-cli`.
- Project-local `.codex-orchestrator/` config.
- Setup, status, scoped issue execution, and parent issue-tree planning.

Always-on polling, child wave execution, integration pull request handoff for issue trees, auto-merge, and npm publication are not implemented in this scope.

## CLI

```sh
codex-orchestrator --help
codex-orchestrator --version
codex-orchestrator health
codex-orchestrator setup --target <path> --github-owner <owner> --github-repo <repo> --dry-run
codex-orchestrator status --target <path> --dry-run
codex-orchestrator run --target <path> --issue <number>
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

The `status` command reads configured GitHub issues and local runner metadata, then prints eligible work, skipped issues with reason codes, and restart recovery state.
Use `--dry-run` to make the read-only intent explicit. Status and dry-run modes do not launch Codex or mutate GitHub labels/comments.

The `run` command executes one authorized issue:

- `agent:auto` runs one scoped implementation issue. It mutates GitHub labels/comments, creates a worktree and branch, runs the configured Codex command with a durable prompt, commits/pushes runner-owned changes, and opens one draft pull request.
- `agent:plan-auto` runs planning only for one parent issue tree. It claims the parent, sends the PRD, issue-breakdown, breakdown-review, and triage workflow prompts to Codex, requires a structured planning report, updates the parent PRD, and creates or updates marked child issues. It does not execute child waves, push branches, open integration PRs, merge, publish, or run a live autonomous loop.

Autonomous child membership is explicit. A child belongs to a parent tree only when it has the configured `agent:child` label and its body contains:

```md
<!-- codex-orchestrator:autonomous-child parent=#<parentIssueNumber> -->
```

Arbitrary issue links, milestones, projects, comments, and generic parent references do not authorize child membership. `agent:auto` is added to generated child issues only when the planning report marks that child as AFK-ready and the runner has persisted and verified the explicit child marker for the parent.

The runner never auto-merges and rejects configured secret file changes, reported secret reads/changes, reported destructive database/cache actions, reported production deploy/release actions, Codex-owned git commits, incoherent planning graphs, and planning sessions that modify repository files.

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
