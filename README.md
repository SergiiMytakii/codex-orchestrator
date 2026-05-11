# codex-orchestrator

`codex-orchestrator` is a reusable runner for Codex work driven by GitHub
Issues.

It lets a maintainer mark an issue as safe for autonomous work, run Codex in an
isolated workspace, and receive the result as a reviewable draft pull request.
For larger features, it can turn one parent issue into a planned issue tree,
execute safe child issues in dependency-aware waves, and open one integration
draft PR.

The package is designed to be installed into any repository. The generic
orchestration lives in this npm package; each target repository keeps its own
policy in `.codex-orchestrator/`.

## The Problem

Codex is useful for implementation work, but coordinating it manually does not
scale well:

- a maintainer has to start a new chat for every small issue;
- large features need PRD, issue breakdown, triage, child issue execution, and
  final integration;
- concurrent agent work can conflict if multiple tasks touch the same files;
- agents should not decide by themselves which linked issues are authorized;
- publication should be consistent: branch, commit, push, and pull request
  creation should follow one project policy;
- humans still need review control before anything is merged.

`codex-orchestrator` solves the coordination layer. GitHub Issues become the
work queue, GitHub labels become the state machine, and draft pull requests
become the handoff point back to humans.

## What It Does

`codex-orchestrator` coordinates the full path from issue to draft PR:

- finds GitHub Issues that are explicitly authorized for autonomous work;
- blocks issues that are manual, already running, under review, or unsafe;
- creates isolated git worktrees and branches for Codex sessions;
- gives Codex project-local prompts and the current issue context;
- validates Codex's completion report and changed files;
- runs the configured project checks;
- owns commit, push, merge, labels, comments, and pull request creation;
- opens draft PRs instead of merging automatically;
- keeps local runner state so interrupted work can be inspected or recovered.

Codex edits files. The runner owns publication.

## Authorization Modes

There are two main labels.

### `agent:auto`

Use `agent:auto` for one scoped implementation issue.

Example:

```sh
codex-orchestrator run --target . --issue 123
```

The runner checks that issue `#123` is eligible, creates a worktree and branch,
runs Codex, validates the result, commits the changes, pushes the branch, and
opens one draft PR.

### `agent:plan-auto`

Use `agent:plan-auto` for a larger parent issue.

This mode is for work that should be planned before implementation. The runner
asks Codex to produce or update the PRD, break the work into child issues,
review the breakdown, triage the children, and execute the autonomous children
in waves.

Only explicitly marked child issues belong to the autonomous tree. A child issue
must have the configured child label and the runner-owned parent marker. A link,
milestone, project, or casual reference is not enough.

Successful tree execution opens one integration draft PR.

## How It Works

1. Install the package.
2. Run `setup` in the repository you want to automate.
3. Commit the generated `.codex-orchestrator/` policy into that repository.
4. Add `agent:auto` or `agent:plan-auto` to a GitHub Issue.
5. Run `status` to see what is eligible or blocked.
6. Run one selected issue with `run`.
7. Review the draft PR created by the runner.

The runner does not auto-merge.

## Installation

Requirements:

- Node.js 18 or newer;
- `git`;
- GitHub CLI `gh`, authenticated for the target repository;
- Codex CLI, installed and authenticated;
- write access to the target GitHub repository.

Install globally:

```sh
npm install -g codex-orchestrator
```

Check the CLI:

```sh
codex-orchestrator --version
codex-orchestrator health
```

You can also run it with `npx`:

```sh
npx codex-orchestrator --help
```

## Quick Start

Open the repository that should receive autonomous Codex work:

```sh
cd /path/to/your/repo
```

Run setup and create missing labels:

```sh
codex-orchestrator setup --prepare-labels
```

By default, setup reads the GitHub owner and repository name from `git remote
origin` and uses the current directory as the target repository. Use `--target`,
`--github-owner`, and `--github-repo` only when you need to override those
defaults.

Commit the generated `.codex-orchestrator/` directory to your repository. It is
the repository-owned policy for how autonomous work should run.

Check eligible work:

```sh
codex-orchestrator status --target .
```

Run one issue:

```sh
codex-orchestrator run --target . --issue 123
```

## Agent-Assisted Setup

A user does not need a long prompt. They can ask an agent:

```text
Set up codex-orchestrator for this repo.
```

The agent should inspect the repository, confirm it has a GitHub `origin`
remote, and run:

```sh
codex-orchestrator setup --prepare-labels
```

If needed, the agent can discover the exact setup behavior from:

```sh
codex-orchestrator --help
```

The package also ships a setup prompt in `prompts/setup-skill.md`. Setup copies
that prompt into `.codex-orchestrator/prompts/setup-skill.md`, so future agents
working in the repository can find the repository-local setup guidance.

Use `--dry-run` only when you want a preview without writing files or creating
labels.

## Project Policy

Every installed repository owns its own config:

```sh
.codex-orchestrator/config.json
```

That config controls:

- GitHub owner and repo;
- labels used for the runner state machine;
- base branch and branch name templates;
- validation checks such as `npm test`;
- review gates, including visual proof requirements for UI/frontend work;
- deny rules for secrets and unsafe actions;
- concurrency for child issue execution;
- pull request title templates;
- prompts used for PRD, issue breakdown, triage, scoped implementation, and
  issue-tree orchestration.

The package ships fallback prompts so a user does not need to already have a
local Codex skill pack installed. During setup, compatible existing local skills
can be reused; missing workflows fall back to package-owned prompts.

For UI or frontend issues, the default visual proof gate blocks `agent:review`
unless the agent reports a passed BrowserUse/Playwright/screenshot validation
line and at least one screenshot artifact. Screenshot artifacts should be saved
under `.codex-orchestrator/proofs/issue-<number>/`; the runner includes them in
the PR and issue review report.

If BrowserUse or browser launch is unavailable inside the child Codex sandbox,
configure a runner-owned command:

```json
{
  "reviewGates": {
    "visualProof": {
      "runnerValidationCommand": "npm run visual-proof -- --issue ${issueNumber}",
      "runnerTimeoutMs": 900000,
      "envPassthrough": [
        "CODEX_ORCHESTRATOR_LOGIN_EMAIL",
        "CODEX_ORCHESTRATOR_LOGIN_PASSWORD"
      ]
    }
  }
}
```

The runner executes this command from the issue worktree after Codex finishes and
before review-gate evaluation. It also sets
`CODEX_ORCHESTRATOR_ISSUE_NUMBER`, `CODEX_ORCHESTRATOR_ARTIFACT_DIR`,
`CODEX_ORCHESTRATOR_PROOF_DIR`, `CODEX_ORCHESTRATOR_WORKTREE_PATH`, and
`CODEX_ORCHESTRATOR_CHANGED_FILES`. Screenshot files written under
`CODEX_ORCHESTRATOR_PROOF_DIR` are attached to the PR and issue review report as
runner-owned proof artifacts.

If the target UI requires login, keep credentials outside the config and expose
only their variable names through `envPassthrough`. The visual proof script can
read those values, sign in with the browser automation tool it uses, and fail
with a clear message when a required login variable is missing.

The default Codex command loads the user's Codex config so installed plugins,
including BrowserUse/browser, remain available to the child agent. It also
enables network access for the `workspace-write` sandbox so local dev servers can
bind to `localhost` during browser validation.

## Labels

Default labels:

- `agent:auto` - a scoped issue is authorized for autonomous implementation;
- `agent:plan-auto` - a parent issue is authorized for planning and issue-tree
  execution;
- `agent:child` - a child issue belongs to an autonomous parent tree;
- `agent:running` - the runner is currently working on the issue;
- `agent:blocked` - the runner needs maintainer input;
- `agent:manual` - the issue is reserved for human work;
- `agent:review` - the result is ready for human review.

`setup --prepare-labels` creates missing labels through `gh`.

## Safety Model

The package is intentionally PR-first and human-reviewed.

Important guardrails:

- no automatic merge;
- draft PRs only;
- Codex changes files, but the runner owns git and GitHub publication;
- child issues are never inferred from ordinary links or references;
- manual, blocked, running, review, and closed issues are not started;
- child implementations run in isolated worktrees;
- parallel child work is limited and avoids overlapping ownership scopes;
- secret files are blocked by policy;
- destructive database/cache actions and production deploy/release actions are
  blocked by default;
- underspecified work can be blocked for maintainer clarification instead of
  letting Codex invent product decisions.

## CLI Reference

```sh
codex-orchestrator --help
codex-orchestrator --version
codex-orchestrator health
codex-orchestrator setup [--target <path>] [--github-owner <owner>] [--github-repo <repo>] [--dry-run] [--prepare-labels]
codex-orchestrator status --target <path> [--dry-run]
codex-orchestrator run --target <path> --issue <number>
```

### `setup`

Creates project-local config and prompt files under `.codex-orchestrator/`.

Useful flags:

- `--dry-run` - show the setup plan without writing files or creating labels;
- `--prepare-labels` - create missing GitHub labels;
- `--target <path>` - override the target directory, which defaults to the current directory;
- `--github-owner <owner>` - override the GitHub owner inferred from `origin`;
- `--github-repo <repo>` - override the GitHub repo inferred from `origin`;
- `--skills-root <path>` - choose where setup looks for existing Codex skills;
- `--replace-package-skills` - refresh package-owned prompt files.

Setup does not launch Codex, commit changes, or open pull requests.

### `status`

Shows eligible issues, skipped issues with reasons, and local recovery state.

`status` is read-only. It does not launch Codex and does not mutate GitHub.

### `run`

Executes one selected issue if its labels and state authorize autonomous work.

For `agent:auto`, it runs one scoped implementation and opens one draft PR.

For `agent:plan-auto`, it runs parent planning, child issue management,
dependency-aware child waves, final validation, and one integration draft PR.

## Current Scope

The package currently focuses on explicit CLI-driven runs and project-local
configuration. The state machine and runner boundaries are designed for
always-on local runner workflows, but hosted infrastructure and automatic
polling are not part of this package today.

Non-GitHub trackers and non-Codex agents are also out of scope for the current
version, although the code keeps adapter boundaries for future expansion.

## Development

```sh
npm test
npm run build
npm run typecheck
```

Publishing is configured through GitHub Actions. A push to `main` runs tests and
publishes the package to npm only when the current package version is not already
published. The repository must provide the GitHub secret `NPM_KEY`.
