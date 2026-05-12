# codex-orchestrator

`codex-orchestrator` is a reusable GitHub Issues runner for Codex.

It lets a maintainer turn selected GitHub Issues into controlled Codex work:
the runner prepares an isolated workspace, gives Codex the issue context and
project policy, checks the result, and hands the work back as a reviewable draft
pull request.

For larger features, it can start from one parent issue, ask Codex to plan the
work, create or update child issues, run the safe child issues in dependency
order, and open one integration draft PR.

The package is designed to be installed into any repository. The generic
orchestration lives in this npm package; each target repository keeps its own
policy in `.codex-orchestrator/`.

## Why Use It

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
work queue, GitHub labels become the state machine, isolated worktrees become
the agent workspaces, and draft pull requests become the handoff point back to
humans.

## Feature Overview

`codex-orchestrator` is designed for maintainers who want Codex to do useful
work without giving up control of the repository.

### Issue-Driven Work Queue

GitHub Issues are the source of truth. A maintainer adds `agent:auto` to one
issue, or `agent:plan-auto` to a larger parent issue. The runner only starts
issues that are explicitly authorized and skips issues that are manual, blocked,
already running, already under review, or closed.

### Scoped Autonomous Issues

Use `agent:auto` for one well-scoped task. The runner creates a branch and
worktree, runs Codex with the issue context, validates the work, then opens a
draft PR for human review.

Codex may change files and, when project policy allows it, make local commits in
the issue branch. The runner still owns external publication: push, draft PR
creation, labels, comments, merges, publishing, and deploys.

### Parent Planning and Child Waves

Use `agent:plan-auto` for larger work. The runner asks Codex to plan the parent
issue, produce a child issue tree, mark safe child issues, and execute those
children in dependency-aware waves.

Only runner-marked child issues belong to the autonomous tree. A link, milestone,
project field, or casual reference is not enough. Successful tree execution
opens one integration draft PR.

### Review Gates Before Handoff

The runner checks the work before it opens a draft PR. By default, runtime
changes need test evidence, code review evidence, and for larger changes cleanup
review evidence. UI work can require visual proof such as screenshots or a
runner-owned browser validation command.

### Full Change-Set Awareness

The runner treats the agent result as a full local change set. That includes
local commits, staged files, unstaged files, and untracked files. Safety checks
and review gates are applied to the whole result, not just to whatever happens
to be left uncommitted.

### Durable Logs and Recovery

Runs keep local state and durable evidence so interrupted or blocked work can be
inspected. Agent output, validation results, skipped checks, residual risks,
visual artifacts, and preserved worktrees are surfaced in review or blocked
reports where relevant.

### Project-Owned Policy

Each target repository owns its policy in `.codex-orchestrator/`: labels,
branches, checks, prompts, review gates, deny rules, visual proof settings, and
runner behavior. The npm package provides the reusable runner; the repository
decides how strict the automation should be.

### PR-First by Design

The package does not auto-merge. It opens draft PRs and moves issues to a review
state so humans can inspect the result before anything lands on the base branch.

## What Happens During a Run

For a normal `agent:auto` issue, the runner:

1. Reads the issue and checks that its labels allow autonomous work.
2. Claims the issue so another runner does not start it at the same time.
3. Creates an isolated git worktree and branch.
4. Builds a project-aware Codex prompt from the issue and local policy.
5. Runs Codex and captures the result.
6. Collects the full local change set, including local commits when allowed.
7. Blocks unsafe paths, missing reports, failed checks, missing review evidence,
   or skipped required proof.
8. Pushes the branch and opens a draft PR only after validation passes.
9. Posts a review report and moves the issue to `agent:review`.

## Authorization Modes

There are two main labels.

### `agent:auto`

Use `agent:auto` for one scoped implementation issue.

Example:

```sh
codex-orchestrator run --target . --issue 123
```

The runner checks that issue `#123` is eligible, creates a worktree and branch,
runs Codex, validates the result, pushes the branch, and opens one draft PR.

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

## Basic Workflow

1. Install the package.
2. Run `setup` in the repository you want to automate.
3. Commit the generated `.codex-orchestrator/` policy into that repository.
4. Add `agent:auto` or `agent:plan-auto` to a GitHub Issue.
5. Run `status` to see what is eligible or blocked.
6. Run one selected issue with `run`, or let `daemon` poll for eligible work.
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
- whether implementation agents may create local commits;
- validation checks such as `npm test`;
- review gates, including strict TDD, code review, cleanup review, and visual
  proof requirements;
- deny rules for secrets and unsafe actions;
- concurrency for child issue execution;
- durable run logs and recovery state;
- pull request title templates;
- prompts used for PRD, issue breakdown, triage, scoped implementation, and
  issue-tree orchestration.

The package ships fallback prompts so a user does not need to already have a
local Codex skill pack installed. During setup, compatible existing local skills
can be reused; missing workflows fall back to package-owned prompts.

For runtime code changes, the default quality gate blocks review handoff unless
the completion report contains passed validation for:

- strict TDD red-to-green evidence: a focused behavior test failed before the
  implementation and passed after the implementation;
- a changed test file for the runtime change;
- `code-review` for every runtime change;
- `cleanup-review` when the change touches at least three runtime files.

These are runner-enforced checks, not only prompt guidance. They apply to the
full local change set, including local commits when they are allowed by policy.
Runtime and test paths are configurable through
`reviewGates.quality.runtimeChangedPathGlobs` and
`reviewGates.quality.testChangedPathGlobs`.

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
`CODEX_ORCHESTRATOR_PROOF_DIR`,
`CODEX_ORCHESTRATOR_PLAYWRIGHT_PROFILE_DIR`,
`CODEX_ORCHESTRATOR_WORKTREE_PATH`, and `CODEX_ORCHESTRATOR_CHANGED_FILES`.
Use `CODEX_ORCHESTRATOR_PLAYWRIGHT_PROFILE_DIR` as the Playwright user data
directory when proof scripts need a stable browser profile; this runtime
directory and `PLAYWRIGHT_BROWSERS_PATH` are kept outside the worktree so browser
cache and session files are not committed. Screenshot files
created or updated under
`CODEX_ORCHESTRATOR_PROOF_DIR` are attached to the PR and issue review report as
runner-owned proof artifacts. A zero-exit proof command that does not create or
update the configured minimum number of screenshots is treated as failed, so a
skipped browser run cannot silently satisfy the proof gate.

If the target UI requires login, keep credentials outside the config and expose
only their variable names through `envPassthrough`. The visual proof script can
read those values, sign in with the browser automation tool it uses, and fail
with a clear message when a required login variable is missing.

The default Codex command loads the user's Codex config so installed plugins,
including BrowserUse/browser, remain available to the child agent. It also
enables network access for the `workspace-write` sandbox so local dev servers can
bind to `localhost` during browser validation.

## Local Commits vs Publication

`codex-orchestrator` separates local implementation work from external
publication.

Implementation agents may be allowed to create local commits in their issue
worktree. This can make larger sessions easier to inspect because the branch
contains meaningful checkpoints. Local commits are still treated as untrusted
agent output until the runner validates them.

The runner remains the only owner of external publication:

- pushing branches;
- opening draft pull requests;
- moving GitHub labels;
- posting issue comments;
- merging child branches into an integration branch;
- publishing packages or deploying.

If an agent tries to bypass those boundaries, the run is blocked instead of
published.

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
- Codex may change files and local commits, but the runner owns remote
  publication and GitHub state;
- child issues are never inferred from ordinary links or references;
- manual, blocked, running, review, and closed issues are not started;
- child implementations run in isolated worktrees;
- parallel child work is limited and avoids overlapping ownership scopes;
- committed and uncommitted changes are checked before publication;
- secret files are blocked by policy;
- destructive database/cache actions and production deploy/release actions are
  blocked by default;
- malformed or missing completion reports block publication;
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
codex-orchestrator daemon --target <path> [--once] [--interval-seconds <seconds>] [--max-runs <count>]
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

### `daemon`

Polls GitHub Issues for eligible `agent:auto` or `agent:plan-auto` work and runs
one issue at a time.

After each polling cycle, the daemon also cleans up runner-owned worktrees when
all of these are true:

- the worktree is under `runner.workspaceRoot`;
- the worktree is not listed in local runner state as active;
- the worktree branch has a merged GitHub pull request;
- the worktree has no uncommitted or untracked changes.

Dirty, blocked, active, or unpublished worktrees are preserved for maintainer
inspection. Cleanup is built into the daemon; there is intentionally no separate
cleanup CLI command.

## Current Scope

The package focuses on local runner workflows: explicit one-off runs, daemon
polling, project-local configuration, and runner-owned worktree cleanup. Hosted
infrastructure is not part of this package today.

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
