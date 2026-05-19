# codex-orchestrator Deep Dive

This document is the technical companion to the main README. The README explains
what problem `codex-orchestrator` solves and how to start using it. This file
describes how the package works internally, what features it provides, and where
the main control points are.

## System Role

`codex-orchestrator` is a local runner that connects four things:

- GitHub Issues as the work queue;
- GitHub labels as the authorization and state model;
- git worktrees as isolated implementation workspaces;
- Codex CLI as the implementation agent.

The runner does not replace human review. It prepares work for review. A
successful run ends with a pushed branch, a draft pull request, issue comments,
and review labels. It does not auto-merge.

## Package vs Repository Policy

The npm package contains reusable orchestration logic:

- CLI commands;
- config schema and validation;
- GitHub issue and PR operations;
- worktree and branch management;
- Codex prompt execution;
- validation and review-gate evaluation;
- durable local state and recovery reports.

Each target repository owns its policy under `.codex-orchestrator/`:

- `config.json` for labels, branches, checks, gates, deny rules, and runner
  behavior;
- `prompts/` for repo-local prompts used by Codex workflows;
- proof and artifact directories created during runs.

This split keeps the package generic while letting each repository choose how
strict autonomous work should be.

## CLI Commands

### `health`

Checks whether the CLI can run in the current environment. It is intended as a
quick sanity check after installation.

### `setup`

Creates project-local config and prompt files under `.codex-orchestrator/`.

Important behavior:

- infers GitHub owner and repo from `git remote origin` by default;
- can override owner, repo, or target path with flags;
- can create missing GitHub labels with `--prepare-labels`;
- can preview changes with `--dry-run`;
- copies package-owned fallback prompts when local skills are missing;
- does not launch Codex, commit files, or open pull requests.

### `status`

Reads GitHub Issues and local runner state, then reports:

- issues eligible for autonomous work;
- skipped issues and the reason they were skipped;
- blocked or recoverable local state.

`status` is read-only. It does not mutate GitHub or launch Codex.

### `run`

Executes one selected issue when its labels and state allow autonomous work.

`run` supports both authorization modes:

- `agent:auto` for one scoped implementation issue;
- `agent:plan-auto` for parent planning and issue-tree execution.

### `daemon`

Polls GitHub Issues for eligible autonomous work. Scoped `agent:auto` issues can
run concurrently up to the daemon concurrency limit when their runner metadata
declares non-overlapping ownership. `agent:plan-auto` parent runs are exclusive.

The daemon applies the configured issue selection policy after safety filters.
By default, priority labels sort eligible issues and issue number is the
deterministic tie-breaker.

Parallel scoped issue selection uses the issue body section
`## codex-orchestrator metadata` and its `Ownership:` bullet list. Issues without
that metadata are treated as unknown ownership and run one at a time. Two scoped
issues cannot share a batch when their ownership entries are the same path or
match each other as supported path globs.

After polling, the daemon can clean up runner-owned worktrees whose pull
requests have already been merged. Dirty, blocked, active, or unpublished
worktrees are preserved.

## Issue Authorization Model

The runner only starts work that is explicitly authorized.

Default labels:

- `agent:auto` authorizes one standalone scoped implementation run;
- `agent:plan-auto` authorizes parent planning and child issue execution;
- `agent:child` marks child issues that belong to an autonomous parent tree
  and is not a standalone authorization label;
- `agent:running` means a runner has claimed the issue;
- `agent:blocked` means maintainer input or manual recovery is needed;
- `agent:manual` reserves the issue for human work;
- `agent:review` means the result is ready for human review.

Issues are skipped when they are closed, manual, blocked, already running,
already in review, or otherwise not authorized by policy.

Child issues are not inferred from ordinary GitHub links, milestones, project
fields, or casual references. They must carry the configured child label and the
runner-owned parent marker. Child issues do not use `agent:auto`; the parent
`agent:plan-auto` flow owns child execution through the marker, child label, and
AFK/HITL metadata.

## Scoped Issue Run

For an `agent:auto` issue, the runner follows this lifecycle:

1. Load config and validate policy.
2. Fetch the issue from GitHub.
3. Check labels and state.
4. Claim the issue with the running label.
5. Create a runner-owned branch and git worktree.
6. Build a prompt from the issue, config, and scoped implementation workflow.
7. Run Codex CLI in the issue worktree.
8. Read the Codex completion report.
9. Collect the full local change set.
10. Run configured validation checks.
11. Run visual proof when required.
12. Evaluate quality gates and deny rules.
13. Optionally run bounded rework for machine-checkable blockers.
14. Optionally run Fresh-Context Review.
15. Write durable run evidence.
16. Push the branch.
17. Open a draft pull request.
18. Post the review report and move the issue to review.

If a blocking condition is found, the runner does not publish the result. It
marks the issue blocked, preserves useful local evidence, and reports the
reason.

## Parent Planning and Child Waves

`agent:plan-auto` is for larger work that should be planned before
implementation.

The parent flow can:

- ask Codex to produce or update the PRD;
- break the parent into child implementation issues;
- review the breakdown;
- triage child issues;
- identify which children are safe for autonomous execution;
- run children in dependency-aware waves;
- merge successful child branches into one integration branch;
- validate the integration branch;
- open one integration draft PR.

Parallel child execution is bounded by `runner.maxParallelChildren`. Parallel
standalone scoped execution is bounded by `runner.maxParallelScopedIssues` or
the daemon `--concurrency` override. Child and standalone work use separate
worktrees so concurrent runs do not share a mutable workspace.

## Full Change-Set Awareness

The runner evaluates the whole result of an agent run:

- local commits;
- staged files;
- unstaged files;
- untracked files.

This matters because Codex may be allowed to create local commits. Those commits
are still treated as untrusted agent output until the runner validates them.

The runner owns external publication:

- pushing branches;
- opening draft PRs;
- moving labels;
- posting comments;
- merging child branches into integration branches;
- publishing packages or deploying.

If agent output attempts to bypass those boundaries, the run is blocked.

## Validation Checks

Configured checks live in `.codex-orchestrator/config.json`.

Typical checks include commands such as:

```json
{
  "checks": {
    "test": "npm test",
    "typecheck": "npm run typecheck"
  }
}
```

By default, a missing `npm run <script>` command is reported as a skipped
warning instead of a hard failure. Repositories can change that with
`checksPolicy.missingNpmScript`.

For repositories with existing lint debt, `checksPolicy.lintBaseline.mode` can
be set to `touched-only`. In that mode, a repo-wide lint failure can be
downgraded when a separate touched-files lint command passes.

## Review Gates

Review gates are runner-enforced checks that decide whether a result can be
published for human review.

The quality gate can require:

- strict TDD red-to-green evidence;
- a changed test file when runtime code changed;
- code review evidence;
- cleanup review evidence for larger runtime changes.

Runtime and test paths are configurable through:

- `reviewGates.quality.runtimeChangedPathGlobs`;
- `reviewGates.quality.testChangedPathGlobs`.

The visual proof gate can require screenshots or another runner-owned proof
command when issue text or changed paths indicate UI work.

## Visual Proof

Visual proof is intentionally runner-owned. Codex can implement the UI, but the
runner decides whether proof is required and executes the configured proof
command after implementation.

The proof command usually runs browser automation, such as Playwright. The
runner provides environment variables for:

- issue number;
- artifact directory;
- proof directory;
- Playwright profile directory;
- worktree path;
- changed files.

Screenshot files created under the proof directory are attached to the PR and
issue review report. If a proof command exits successfully but does not create
the configured minimum number of screenshots, the runner reports a warning.

For Android UI work, the implementation prompt uses device-backed proof through
`adb` or an emulator. Missing Android tooling or no usable device is reported as
a concrete warning instead of a release blocker by itself. Native Android proof
uses the project Gradle wrapper with a writable Gradle cache. Flutter SDK cache
recovery applies only to Flutter projects and only through a preconfigured
writable SDK path in `CODEX_ORCHESTRATOR_FLUTTER_ROOT`. Native iOS proof uses
Xcode simulator/device tooling with a writable DerivedData path.

## Loop Policy

Loop Policy controls runner-owned automation around retries and evidence.

It includes:

- issue selection priority labels and tie-breaker;
- bounded rework attempts;
- retryable blocker types;
- Fresh-Context Review;
- Durable Run Summaries;
- non-mutating Policy Suggestions.

Bounded rework is limited to machine-checkable blockers such as missing or
invalid completion reports, no changed files, failed configured checks, or
missing quality-gate evidence. It stops at the configured attempt limit.

Fresh-Context Review runs a separate Codex session with the issue, diff, and
validation evidence. It does not reuse the implementation transcript. In the
current config model, the mode is advisory; repositories can choose whether
high-confidence policy violations block publication.

Durable Run Summaries record the outcome, confirmed facts, validation, blockers,
residual risks, next action, and policy suggestions. They reference existing
logs and reports; they do not replace them.

Policy Suggestions are report-only. They never edit prompts, config, labels, or
issue state.

## Deny Rules

Deny rules block publication when the agent result touches forbidden areas or
attempts unsafe actions.

The default policy can block:

- secret files;
- destructive database or cache actions;
- production deploy or release actions;
- additional repository-defined path globs.

These rules are evaluated before a result is published.

## Durable State and Recovery

The runner keeps local state so interrupted work can be inspected and recovered.

Durable evidence can include:

- agent output;
- completion reports;
- validation results;
- skipped checks;
- blocked reasons;
- visual artifacts;
- run summaries;
- preserved worktrees.

The runner preserves worktrees when deleting them would hide useful evidence,
for example when they are dirty, blocked, active, or unpublished.

## Prompt and Workflow System

Workflows are configured in `config.json`.

The default workflow set includes:

- PRD creation or update;
- issue breakdown;
- breakdown review;
- triage;
- scoped implementation;
- issue-tree orchestration.

Each workflow points to either a package-owned fallback prompt or a compatible
local skill/prompt copied during setup. This lets the package work out of the
box while still allowing repositories to customize agent behavior.

## Config Surface

The top-level config areas are:

- `github` for owner, repo, label preparation, and label definitions;
- `runner` for workspace root, child concurrency, state directory, local commit
  policy, and worktree cleanup;
- `codex` for Codex CLI command, args, timeouts, and prompt/report env vars;
- `project` for config and prompt directories;
- `workflows` for prompt or skill routing;
- `checks` and `checksPolicy` for validation commands;
- `reviewGates` for quality and visual proof requirements;
- `loopPolicy` for issue selection, rework, review, summaries, and suggestions;
- `deny` for secret and unsafe-action protection;
- `branches` for branch templates;
- `pullRequests` for PR title templates;
- `issueClassification` for promotion criteria and clarification behavior.

Runtime state must not be committed as config. The schema rejects known runtime
keys in committed config files.

## Current Boundaries

The package currently focuses on local runner workflows:

- explicit one-off runs;
- daemon polling;
- project-local config;
- runner-owned worktree cleanup;
- GitHub Issues and Pull Requests;
- Codex CLI as the agent backend.

Hosted infrastructure, non-GitHub issue trackers, and non-Codex agents are not
part of the current package, although the code keeps adapter boundaries for
future expansion.
