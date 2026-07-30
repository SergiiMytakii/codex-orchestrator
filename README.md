# Codex Orchestrator

Codex Orchestrator turns an authorized GitHub Issue into a controlled Codex delivery run. It reads the issue, decides whether the work is ready to implement, works in an isolated Git worktree, validates the result, and—only after all required gates pass—pushes a branch and opens a draft pull request.

The package is designed for unattended local execution without giving the Codex worker your GitHub, SSH, npm, or cloud publication credentials. The trusted Runner owns authorization, checks, recovery, and publication; Codex owns the bounded analysis, implementation, review, and proof tasks assigned to it.

## What happens to an issue

Add the configured `agent:auto` label to an open issue, then run the orchestrator. It will choose one of three routes:

- **Direct delivery:** the issue is clear enough to implement. Codex changes the code, an independent review checks it, issue-scoped verification checks run, Acceptance Proof verifies the acceptance criteria, and the Runner creates a draft PR.
- **Specification first:** the issue is too complex for safe direct implementation. Separate Codex workers author and independently review a deterministic implementation specification; the Runner freezes the approved revision and returns `spec-frozen`. Implementation is intentionally a separate follow-up run or workflow.
- **Human decision required:** the repository does not contain enough authority to choose between materially different product outcomes. The package posts one precise question, applies `agent:waiting-human`, and resumes the same run after an authorized repository writer answers with the requested prefix.

Ordinary technical choices do not stop the run. A human question is reserved for real product ambiguity.

## Requirements

- Node.js 18 or newer
- `git`
- an authenticated [GitHub CLI](https://cli.github.com/) (`gh auth status`)
- an installed Codex CLI and an authenticated parent Codex installation
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

`setup` derives the base branch only from `origin/HEAD`. When an agent performs setup, it must show that detected branch and obtain explicit user confirmation before running the mutating setup command. If repository inference is not possible, provide both repository fields:

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

Before a new run is claimed, the Runner fetches only the configured remote base branch, pins its exact commit, and creates the issue worktree from that immutable SHA. A temporary fetch failure remains unclaimed and safely retryable; existing runs keep their already-persisted base SHA.

### `daemon`

Poll for open issues carrying `agent:auto` and process them serially:

```sh
npx codex-orchestrator daemon --target "$PWD"
```

Run exactly one polling pass—for example from cron or another scheduler—with:

```sh
npx codex-orchestrator daemon --target "$PWD" --once
```

For a bounded one-shot daemon check of one discovered candidate, add
`--issue <number>` after `--once`. Continuous daemon mode intentionally has no
issue filter.

The daemon uses the same lifecycle as `run`; it does not have a less strict execution path.

### Continue from pull-request review feedback

After a direct-delivery run reaches `review-ready`, the daemon also polls issues
with `agent:review`. A quiet PR remains effect-free. When the same marker-bound,
same-repository draft PR receives a new unresolved inline thread root or a
non-empty `CHANGES_REQUESTED` review from a current repository writer or admin,
the Runner freezes that exact feedback batch and resumes the existing run.

The repair uses the existing implementation and affected Closure flow, then
reruns the run's resolved check policy and Acceptance Proof against the repaired content. It
has a separate maximum of three feedback rounds and does not consume the
original five implementation cycles. Publication appends one fast-forward
commit to the existing branch and PR; divergence blocks without reset, rebase,
amend, or force-push recovery.

Feedback is re-read with fresh permission before workers and publication
effects. Edited, deleted, revoked, wrong-head, cross-repository, bot, resolved,
outdated, ordinary conversation, and read-only feedback cannot authorize work.
The Runner posts one marker-bound PR summary after success, but it never resolves
review threads or claims human approval. Thread resolution remains a reviewer
action.

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
| `review-ready` | Open the returned draft PR URL and review the change; later trusted unresolved feedback may resume the same run and PR. |
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
- `checks`: finite fallback commands for issues without a command-only
  `Verification:` section. Before the issue implementation starts, the Runner
  requires the resolved scoped policy to pass. A red qualification check starts
  a separate sealed, bounded repair operation, reruns the policy, and does not
  consume the issue's implementation-cycle budget. Its launched process is
  durably recoverable across daemon restarts. Final checks must all pass;
  failures are never accepted by comparing output hashes.
- `proof.artifactDir`: repository-relative location for proof artifacts inside the run worktree.
- `proof.android`: optional Runner-owned Android recipe. It selects `avdName`, creates an ephemeral clean data directory, requires fixed `build apk` arguments, removes any old `apkPath`, snapshots a fresh no-symlink APK outside the worker-writable tree, and binds its digest to the checked change. It installs and launches that exact snapshot, repeatedly verifies emulator process identity, waits up to `navigationTimeoutMs` for each exact `tapText` accessibility label, and captures proof-bound screenshot, hierarchy, PID log, and lease artifacts. Commands are bounded, cancellable, and process-group quiescent; URI query/fragment credentials are rejected. The contained proof worker never receives `adb`, emulator, Flutter, or durable lease authority. Emulator or Android-tool startup failure is retained as an explicit unfinished-UI-proof warning and does not by itself block delivery.
- `deny.readPaths`: paths the worker must not read or modify.
- `deny.commands`: absolute command paths that must not be exposed to the worker.

`runner.maxCycles`, the branch template, and containment settings are fixed policy in the current schema rather than open-ended tuning knobs. There is no configured Codex version pin or local certification step: the Runner uses the installed `codex` command and applies the fixed sandbox, environment, network, and authority restrictions to every worker invocation.

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

After changing packaged skills or evals, compare the source and generated eval
plans locally. This check is offline and does not run a model:

```sh
set -e
PACKAGE_ROOT="$PWD"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
PARITY_ROOT="$(mktemp -d)"
cd "$CODEX_HOME"
python3 scripts/run_coding_skill_evals.py --output "$PARITY_ROOT/source"
python3 scripts/run_coding_skill_evals.py \
  --workflow-root "$PACKAGE_ROOT/internal-workflow" \
  --fixture-root "$CODEX_HOME/scripts/fixtures/coding-skill-evals" \
  --output "$PARITY_ROOT/package"
jq -S '.cases' "$PARITY_ROOT/source/plan.json" > "$PARITY_ROOT/source-cases.json"
jq -S '.cases' "$PARITY_ROOT/package/plan.json" > "$PARITY_ROOT/package-cases.json"
diff -u "$PARITY_ROOT/source-cases.json" "$PARITY_ROOT/package-cases.json"
```

Do not add live eval profiles to `refresh:workflow`, package tests, build, or
release scripts. Live execution remains an explicit maintainer action from the
local skill checkout.

`npm run smoke:live` packs the current package and mutates a configured scratch GitHub repository. Run it only when live smoke was explicitly requested. Releases are published by the GitHub release workflow after the release commit reaches `main`; do not run `npm publish` manually unless that workflow is unavailable.

Human maintainers can find the complete lifecycle, state machine, containment boundary, retry budgets, review flow, proof contracts, and publication recovery model in [docs/deep-dive.md](docs/deep-dive.md). That guide is not agent context. For live release scenarios, see [docs/live-smoke-checklist.md](docs/live-smoke-checklist.md).
