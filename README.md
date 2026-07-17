# Codex Orchestrator

Codex Orchestrator is a runner-owned GitHub Issue loop for Codex. The public runtime has one path: select an issue carrying the configured `auto` label, execute bounded implementation cycles in an isolated worktree, run configured checks, obtain independent Acceptance Proof, and publish a review-ready branch and draft pull request.

## Requirements

- Node.js 18 or newer
- `git`, `gh`, and the configured Codex CLI
- an authenticated parent Codex installation and GitHub CLI

Authentication remains in the trusted parent process. Child shell commands and agent processes receive only the runtime's explicit environment allowlist; GitHub, SSH, npm, cloud, and parent Codex credentials are not forwarded.

## Install and configure

```sh
npm install --save-dev codex-orchestrator
npx codex-orchestrator setup --target "$PWD"
npx codex-orchestrator setup --target "$PWD" --prepare-labels
npx codex-orchestrator doctor --target "$PWD"
```

`setup` writes the exact V2 policy to `.codex-orchestrator/config.json`. Use `--github-owner` and `--github-repo` together only when repository inference is unavailable. Existing recognized pre-V2 state is detect-only; migrate it explicitly with `setup --fresh` while all old activity is stopped.

## Run

Run one authorized issue:

```sh
npx codex-orchestrator run --target "$PWD" --issue 123
```

Poll and run matching issues serially:

```sh
npx codex-orchestrator daemon --target "$PWD"
```

Perform one polling pass:

```sh
npx codex-orchestrator daemon --target "$PWD" --once
```

All commands require an absolute target. `doctor`, `status`, `run`, and `daemon` read the same strict config and use the same `runIssue` lifecycle.

## Lifecycle

1. Read the issue and confirm the exact `auto` authorization label.
2. Acquire runner ownership and create or resume one issue worktree.
3. Invoke the package-owned `agent-auto` skill in a contained Codex process.
4. Validate the structured implementation report and the complete worktree diff.
5. Run the configured finite checks.
6. Freeze the checked change and invoke package-owned `acceptance-proof` in a separate contained process.
7. Validate fresh proof artifacts and criterion coverage.
8. Publish through runner-owned Git and GitHub adapters, then mark the issue review-ready.

Implementation and proof retries are bounded. Crashes resume from durable intents instead of repeating already-confirmed external effects. Ambiguous ownership, process quiescence, repository identity, credentials, denied paths, or publication state fails closed with a typed result.

## Acceptance Proof

Proof is independent from implementation. The proof process receives a frozen description of the checked change and may write only under its proof artifact root. It cannot publish, mutate issue state, or reuse implementation authority.

Artifacts always receive size, hash, UTF-8, path-containment, and credential checks. Public artifacts have the stricter publication contract: screenshots or sanitized generated summaries only, with host identity removed. Local command output may retain machine paths because it is never published, but credentials remain forbidden everywhere.

Browser and mobile proof additionally require current workflow evidence. Mobile proof uses runner-owned Android or iOS leases and refuses to take over a user-owned device or app session.

## Package boundary

The npm package ships only:

- the compiled V2 runtime and adapter closure;
- package-owned `agent-auto` and `acceptance-proof` skills;
- this README, the architecture deep dive, changelog, and license.

There are no bundled workflow prompts, compatibility bridge, alternate public runtime, parent-planning mode, or Legacy CLI export.

## Development

```sh
npm run typecheck
npm test
npm pack --dry-run --json
```

`npm test` starts from a clean `dist` directory. `npm run smoke:live` packs the current package and mutates the configured scratch GitHub repository; run it only with explicit authorization. The default `core-release` profile contains the four external release proofs: package installation, real Codex, browser proof, and a safety-negative case.

See [docs/deep-dive.md](docs/deep-dive.md) for the trust and durability model and [docs/live-smoke-checklist.md](docs/live-smoke-checklist.md) for live validation.
