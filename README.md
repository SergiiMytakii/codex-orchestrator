# Codex Orchestrator

Codex Orchestrator turns an authorized GitHub Issue into a controlled Codex delivery run. It reads the issue, decides whether the work is ready to implement, works in an isolated Git worktree, validates the result, and—only after all required gates pass—pushes a branch and opens a draft pull request.

The package is designed for unattended local execution without giving the Codex worker your GitHub, SSH, npm, or cloud publication credentials. The trusted Runner owns authorization, checks, recovery, and publication; Codex owns the bounded analysis, implementation, review, and proof tasks assigned to it.

## What happens to an issue

Add the configured `agent:auto` label to an open issue, then run the orchestrator. It will choose one of three routes:

- **Direct delivery:** the issue is clear enough to implement. Codex changes the code, an independent review checks it, configured checks run, Acceptance Proof verifies the acceptance criteria, and the Runner creates a draft PR.
- **Specification first:** the issue is too complex for safe direct implementation. Separate Codex workers author and independently review a deterministic implementation specification; the Runner freezes the approved revision and returns `spec-frozen`. Implementation is intentionally a separate follow-up run or workflow.
- **Human decision required:** the repository does not contain enough authority to choose between materially different product outcomes. The package posts one precise question, applies `agent:waiting-human`, and resumes the same run after an authorized repository writer answers with the requested prefix.

Ordinary technical choices do not stop the run. A human question is reserved for real product ambiguity.

## Requirements

- Node.js 18 or newer
- `git`
- an authenticated [GitHub CLI](https://cli.github.com/) (`gh auth status`)
- the configured Codex CLI version and an authenticated parent Codex installation
- a GitHub repository with a usable `origin` remote

The target path passed to every command must be absolute.

## Quick start

Install the package in the repository you want to automate:

```sh
npm install --save-dev codex-orchestrator
```

Create the repository policy and GitHub labels:

```sh
npx codex-orchestrator setup --target "$PWD"
npx codex-orchestrator setup --target "$PWD" --prepare-labels
npx codex-orchestrator doctor --target "$PWD"
```

`setup` infers the GitHub repository and base branch from the target checkout. If that is not possible, provide both repository fields:

```sh
npx codex-orchestrator setup \
  --target "$PWD" \
  --github-owner your-org \
  --github-repo your-repo
```

It writes `.codex-orchestrator/config.json` and adds the generated workspace, state, and proof directories to `.gitignore`. If the repository has `test` or `typecheck` npm scripts, setup adds them as default checks. Review the generated config before the first run.

Now create or choose a clear GitHub Issue, include acceptance criteria when possible, and add the `agent:auto` label. Run it directly:

```sh
npx codex-orchestrator run --target "$PWD" --issue 123
```

The command prints one JSON result. A successful direct delivery returns `review-ready` with the draft PR URL. A complex issue may instead return `spec-frozen`; a genuine product decision returns `awaiting-user` with the answer prefix to use in the issue comment.

## Main commands

### `setup`

Create or verify the strict repository policy:

```sh
npx codex-orchestrator setup --target "$PWD"
```

Preview setup writes without changing files or labels:

```sh
npx codex-orchestrator setup --target "$PWD" --dry-run
npx codex-orchestrator setup --target "$PWD" --prepare-labels --dry-run
```

Setup accepts the current exact configuration schema only. Unknown or older configuration shapes are rejected rather than guessed or executed through a compatibility runtime.

### `doctor`

Check that the config is valid, the configured repository matches `origin`, no active owner makes setup unsafe, and all configured labels exist:

```sh
npx codex-orchestrator doctor --target "$PWD"
```

### `status`

Run the same read-only operational inspection in a status-oriented command:

```sh
npx codex-orchestrator status --target "$PWD"
```

Both `doctor` and `status` return structured JSON and make no repository or GitHub changes.

### `run`

Run or safely resume one issue:

```sh
npx codex-orchestrator run --target "$PWD" --issue 123
```

Repeated calls do not start an unrelated second run. The Runner reads durable state, reconciles unfinished effects, revalidates issue authorization, and continues only when ownership and process state are safe.

### `daemon`

Poll for open issues carrying `agent:auto` and process them serially:

```sh
npx codex-orchestrator daemon --target "$PWD"
```

Run exactly one polling pass—for example from cron or another scheduler—with:

```sh
npx codex-orchestrator daemon --target "$PWD" --once
```

The daemon uses the same lifecycle as `run`; it does not have a less strict execution path.

## Labels and visible outcomes

The default labels are:

| Label | Meaning |
| --- | --- |
| `agent:auto` | The issue is authorized for orchestration. |
| `agent:running` | A Runner has claimed the issue. |
| `agent:waiting-human` | One approved product question is waiting for an authorized answer. |
| `agent:blocked` | The run stopped on an external, safety, or exhausted-budget blocker. |
| `agent:review` | The branch and draft PR passed the delivery gates and are ready for human review. |

Important command results:

| Result | What to do |
| --- | --- |
| `review-ready` | Open the returned draft PR URL and review the change. |
| `spec-frozen` | Use the returned frozen specification receipt as the authority for a later implementation workflow. |
| `awaiting-user` | Reply to the issue using the returned answer prefix. Re-run the command or let the daemon pick it up. |
| `not-eligible` | Check that the issue is open, has only the appropriate authorization label, and has no existing open PR for its branch. |
| `requeued` | Another known Runner owns the repository; retry later. |
| `blocked` | Read `kind`, `resumable`, and `evidencePath`; fix the external condition only when the evidence says it is safe to resume. |
| `transport-failed` | A local or remote effect could not be confirmed. Re-run only when `resumable` is true; the Runner will reconcile durable intent first. |

All outcomes include structured evidence or a path to local evidence. Quiet terminal output is not the source of truth—the JSON result and persisted state are.

## Configuration you will usually edit

`.codex-orchestrator/config.json` is intentionally strict: unknown keys are errors. The most useful fields are:

- `github.baseBranch` and `github.labels`: where completed branches target and which labels control the workflow.
- `runner.pollIntervalSeconds`: daemon polling interval.
- `checks`: finite Runner-owned commands that must pass before proof and publication.
- `proof.artifactDir`: repository-relative location for proof artifacts inside the run worktree.
- `deny.readPaths`: paths the worker must not read or modify.
- `deny.commands`: absolute command paths that must not be exposed to the worker.

`runner.maxCycles`, the branch template, required Codex version, and containment settings are fixed policy in the current schema rather than open-ended tuning knobs.

## Safety model in plain language

The package separates two roles:

- The **Runner** is trusted. It owns GitHub reads and writes, labels, comments, worktrees, configured checks, process lifecycle, commits, pushes, draft PRs, proof validation, and recovery state.
- Codex **workers** are bounded. They receive operation-specific instructions and a contained environment. They can inspect and change the assigned worktree or create proof-owned artifacts, but they do not receive publication credentials or permission to publish.

Codex and native Codex subagents still run as your local OS user and may use your existing Codex authentication. This is containment of authority, not an OS-level secrecy boundary. Credentials are scrubbed from worker environments and rejected in reports and proof artifacts.

## Development and release checks

For package maintainers:

```sh
npm run refresh:workflow
npm run typecheck
npm test
npm pack --dry-run --json
```

`npm run refresh:workflow` rebuilds the package-owned workflow inventory from the explicit allowlist in `scripts/agent-auto-workflow-source.json`, validates operation bindings, and runs focused contract tests. `npm run check:workflow` is the non-writing drift check; `npm run verify:workflow` verifies the committed generated workflow without reading local skills.

`npm run smoke:live` packs the current package and mutates a configured scratch GitHub repository. Run it only when live smoke was explicitly requested. Releases are published by the GitHub release workflow after the release commit reaches `main`; do not run `npm publish` manually unless that workflow is unavailable.

For the complete lifecycle, state machine, containment boundary, retry budgets, review flow, proof contracts, and publication recovery model, see [docs/deep-dive.md](docs/deep-dive.md). For live release scenarios, see [docs/live-smoke-checklist.md](docs/live-smoke-checklist.md).
