# codex-orchestrator

`codex-orchestrator` turns GitHub Issues into controlled Codex work.

Instead of starting a new Codex chat for every issue, you label the work you
want automated. The runner creates an isolated workspace, gives Codex the issue
and your repo rules, checks the result, and hands it back as a draft pull
request.

For bigger features, it can start from one parent issue, ask Codex to plan the
work, create or update child issues, run the safe children in order, and open
one integration draft PR.

The package is installed into any repository. The reusable runner lives in this
npm package; each target repository keeps its own rules in
`.codex-orchestrator/`.

For a technical walkthrough of the runner lifecycle, policy model, review
gates, and recovery behavior, see [docs/deep-dive.md](docs/deep-dive.md).

## Why This Exists

Codex can write useful code, but running it manually gets messy fast:

- every small issue needs a new chat and repeated context;
- large features need planning, child issues, triage, execution, and final
  integration;
- parallel agent work can conflict when tasks touch the same files;
- someone still needs to decide what is allowed, what is blocked, and what needs
  review;
- branches, commits, checks, PRs, and labels should follow one project policy.

`codex-orchestrator` is the coordination layer.

GitHub Issues become the work queue. Labels decide what Codex may run. Isolated
worktrees keep runs separate. Review gates check the result. Draft PRs return
control to humans before anything is merged.

## What You Get

- A repeatable way to send selected GitHub Issues to Codex.
- One-off autonomous runs for scoped implementation tasks.
- Parent planning for larger features, with child issues executed in safe waves.
- Project-owned rules for labels, branches, prompts, checks, review gates, and
  blocked actions.
- Full change-set checks, including local commits, staged files, unstaged files,
  and untracked files.
- Durable logs and summaries when a run is interrupted, blocked, or ready for
  review.
- Draft PR handoff by default. No auto-merge.

## How It Works

There are two main modes.

### `agent:auto`

Use `agent:auto` for one clear standalone implementation issue. Do not use it
for child issues created by `agent:plan-auto`; those are marked with
`agent:child` and are executed only by the parent issue-tree flow.

When a daemon is allowed to run more than one scoped issue at a time, parallel
`agent:auto` selection is conservative. An issue must include a
`## codex-orchestrator metadata` section with an `Ownership:` bullet list, and
same-batch issues must not overlap by exact path or supported glob. Issues
without ownership metadata still run, but only one at a time.

The runner:

1. Checks that the issue is allowed to run.
2. Claims the issue so another runner does not start it too.
3. Creates a branch and isolated git worktree.
4. Runs Codex with the issue context and repo policy.
5. Validates the full local change set.
6. Pushes the branch and opens a draft PR only after the gates pass.
7. Moves the issue to review and posts the run report.

### `agent:plan-auto`

Use `agent:plan-auto` for work that needs planning first.

The runner asks Codex to plan the parent issue, break it into child issues,
triage them, run safe children in dependency order, and then open one
integration draft PR.

Only child issues explicitly marked by the runner belong to the autonomous tree.
Ordinary links, milestones, project fields, or casual references are not enough.
Child issues use `agent:child`, not `agent:auto`, so the daemon cannot confuse
parent-owned child work with standalone scoped work.

## Basic Workflow

1. Install the package.
2. Run `setup` in the repository you want to automate.
3. Commit the generated `.codex-orchestrator/` policy.
4. Add `agent:auto` or `agent:plan-auto` to a GitHub Issue.
5. Run `status` to see what is eligible or blocked.
6. Run one selected issue with `run`, or let `daemon` poll for eligible work.
7. Review the draft PR created by the runner.

The runner never auto-merges.

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
codex-orchestrator status --target . --json
codex-orchestrator doctor --target .
```

Run one issue:

```sh
codex-orchestrator run --target . --issue 123
```

Run the daemon:

```sh
codex-orchestrator daemon --target .
```

Run up to three independent scoped issues in one daemon batch:

```sh
codex-orchestrator daemon --target . --concurrency 3
```

## Agent-Assisted Setup

You do not need a long prompt. You can ask an agent:

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
working in the repository can find repository-local setup guidance.

Use `--dry-run` only when you want a preview without writing files or creating
labels.

## Project Policy

Every installed repository owns its config:

```sh
.codex-orchestrator/config.json
```

That config is where the repo decides how strict automation should be. It
controls the GitHub repo, labels, base branch, branch names, validation checks,
review gates, blocked paths, child issue concurrency, durable logs, PR titles,
and the prompts used for planning and implementation.

The package ships bundled workflow prompts, so a repository does not need local
Codex `SKILL.md` files installed on the user's machine. Setup copies those
prompts into `.codex-orchestrator/prompts/workflows/`, and the runner reads the
copied prompt files during `agent:auto` and `agent:plan-auto` runs. Workflow
`skillName` values in config are descriptive metadata for the workflow role;
they are not a runtime dependency on the user's local Codex skill directory.
Setup also writes `.codex-orchestrator/prompts/manifest.json`, which lets later
setup runs tell apart untouched package prompts from prompts edited by the
project. By default, setup refreshes untouched prompts and reports conflicts for
locally edited prompts.

Configured checks run before publication. By default, missing
`npm run <script>` checks are reported as skipped warnings, not failures. You can
change that with `checksPolicy.missingNpmScript`.

For repos with existing lint debt, `checksPolicy.lintBaseline.mode` can be set
to `touched-only`. That lets a repo-wide lint failure be downgraded when a
separate touched-files lint command passes.

The default quality gate is conservative for runtime code changes. It can
require TDD evidence, changed tests, code review, cleanup review for larger
changes, and visual proof for UI work.

## Diagnostics

`doctor` is a read-only readiness check for operators. It validates the target
config, GitHub label visibility, git/base branch access, runner state paths,
configured checks, the Codex command, phase profiles, and visual proof settings.
It never launches Codex, creates worktrees, edits labels, or changes issues.

```sh
codex-orchestrator doctor --target .
codex-orchestrator doctor --target . --json
```

`status --json` returns the same queue view as text status plus active local
runs and recent lifecycle events. The JSON is designed for wrappers and
dashboards; it includes bounded artifact paths such as context snapshots, but
not raw Codex transcripts, secrets, prompt text, or full issue comments.

Codex command profiles can be set per runner phase under `codex.profiles`.
Supported phases are `plan-parent`, `scoped-issue`, `tree-child`,
`fresh-context-review`, `visual-proof`, and `quality-review`. Missing profile
fields fall back to the global `codex.command`, `codex.args`, `timeoutMs`, and
`idleTimeoutMs`, so existing configs keep working.

Each Codex session writes a bounded context snapshot before invocation and links
it from lifecycle events under the runner state directory. Snapshots record the
issue identity, runner decision, selected profile, workspace paths, and
publication boundaries so a maintainer can reproduce why a session started
without reading raw logs.

## Visual Proof

For browser UI work, configure a runner-owned proof command, usually a
Playwright script:

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

The runner executes this command from the issue worktree after Codex finishes
and before review-gate evaluation. It sets environment variables for the issue
number, artifact directory, proof directory, Playwright profile directory,
worktree path, and changed files.

Screenshots created under `CODEX_ORCHESTRATOR_PROOF_DIR` are attached to the PR
and issue review report. Keep login credentials outside config and expose only
their variable names through `envPassthrough`.

For Android UI work, the implementation prompt asks Codex to use `adb` or an
emulator-backed proof path instead of browser proof. Missing Android tooling or
no usable device is reported as a warning with the concrete reason, not as an
automatic release blocker. Native Android proof uses the project Gradle wrapper
with a writable Gradle cache; Flutter-specific SDK cache recovery is used only
for Flutter projects and only through a preconfigured writable SDK path in
`CODEX_ORCHESTRATOR_FLUTTER_ROOT`. Native iOS proof uses Xcode simulator/device
tooling with a writable DerivedData path.

## Safety Model

The package is PR-first and human-reviewed. The important guardrails are:

- no automatic merge, and only draft PRs are opened;
- Codex may change files, but the runner owns remote publication and GitHub
  state;
- only explicitly authorized issues run;
- child issues are never inferred from ordinary links or references;
- committed and uncommitted changes are checked before publication;
- secret files, destructive data/cache actions, and production deploy/release
  actions are blocked by default;
- malformed or missing completion reports block publication;
- bounded rework stops at the configured limit;
- Policy Suggestions are recommendations only;
- underspecified work can be blocked for maintainer clarification instead of
  letting Codex invent product decisions.

## Labels

Default labels:

- `agent:auto` - run one scoped issue;
- `agent:plan-auto` - plan and run a parent issue tree;
- `agent:child` - child issue in an autonomous tree; this is not a standalone
  authorization label;
- `agent:running` - runner is working;
- `agent:blocked` - maintainer input needed;
- `agent:manual` - reserved for human work;
- `agent:review` - ready for human review.

`setup --prepare-labels` creates missing labels through `gh`.

## CLI Reference

```sh
codex-orchestrator --help
codex-orchestrator --version
codex-orchestrator health
codex-orchestrator doctor --target <path> [--json]
codex-orchestrator setup [--target <path>] [--github-owner <owner>] \
  [--github-repo <repo>] [--dry-run] [--prepare-labels]
codex-orchestrator status --target <path> [--dry-run] [--json]
codex-orchestrator run --target <path> --issue <number>
codex-orchestrator daemon --target <path> [--once] \
  [--interval-seconds <seconds>] [--max-runs <count>] \
  [--concurrency <count>]
```

`setup` creates project-local config and prompt files under
`.codex-orchestrator/`. Useful flags:

- `--dry-run` - show the setup plan without writing files or creating labels;
- `--prepare-labels` - create missing GitHub labels;
- `--target <path>` - override the target directory, which defaults to the current directory;
- `--github-owner <owner>` - override the GitHub owner inferred from `origin`;
- `--github-repo <repo>` - override the GitHub repo inferred from `origin`;
- `--sync-prompts <auto|keep|replace|merge>` - choose how package-bundled
  prompt updates are applied. `auto` refreshes untouched prompts and reports
  local-edit conflicts, `keep` preserves existing prompts, `replace` overwrites
  with bundled prompts, and `merge` appends bundled updates to locally edited
  prompts;
- `--replace-package-skills` - refresh package-bundled prompt files. The flag
  name is kept for compatibility and behaves like `--sync-prompts=replace`; it
  does not install or require local Codex skills.

Setup does not launch Codex, commit changes, or open pull requests.
When the target repository already has a `package.json`, setup also adds
`orchestrator:*` npm scripts. Daemon scripts run `doctor` first, then start the
daemon only if the readiness check passes.

`status` is read-only. It shows eligible issues, skipped issues with reasons,
and local recovery state.

`run` executes one selected issue when labels and state allow it. `agent:auto`
opens one scoped draft PR. `agent:plan-auto` runs parent planning, child waves,
final validation, and one integration draft PR.

`daemon` polls for eligible work. By default, fresh setup config allows up to
three scoped issues per batch through `runner.maxParallelScopedIssues`; legacy
configs without that field remain sequential unless `--concurrency` is passed.
Only scoped issues with non-overlapping ownership metadata can share a batch.
`agent:plan-auto` runs remain exclusive. The daemon also cleans up runner-owned
worktrees after their PRs are merged, while preserving dirty, blocked, active,
or unpublished worktrees for inspection.

## Current Scope

The package focuses on local runner workflows: one-off runs, daemon polling,
project-local configuration, and runner-owned worktree cleanup. Hosted
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

See `CHANGELOG.md` for release-by-release notes.
