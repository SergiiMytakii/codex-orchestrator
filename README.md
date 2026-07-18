# Codex Orchestrator

Codex Orchestrator is a runner-owned GitHub Issue loop for Codex. The public runtime has one path: select an issue carrying the configured `auto` label, execute bounded implementation cycles in an isolated worktree, run configured checks, obtain independent Acceptance Proof, and publish a review-ready branch and draft pull request.

## Requirements

- Node.js 18 or newer
- `git`, `gh`, and the configured Codex CLI
- an authenticated parent Codex installation and GitHub CLI

GitHub, SSH, npm, and cloud publication credentials remain in the trusted Runner and are not forwarded through the child environment. Ordinary Codex execution and native Codex subagents may use the same user-owned Codex authentication and may read files available to the same local OS user; this is an explicit accepted local-read risk, not an external-publication grant.

## Install and configure

```sh
npm install --save-dev codex-orchestrator
npx codex-orchestrator setup --target "$PWD"
npx codex-orchestrator setup --target "$PWD" --prepare-labels
npx codex-orchestrator doctor --target "$PWD"
```

`setup` writes the exact V2 policy to `.codex-orchestrator/config.json`. Use `--github-owner` and `--github-repo` together only when repository inference is unavailable. Exact Config V1 is migrated by `setup`; older recognized runtime state remains detect-only and requires `setup --fresh` while all old activity is stopped.

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
3. Triage the issue. An approved product ambiguity publishes one marker-bound question and moves the issue to `agent:waiting-human`; only an unedited, post-question answer from a current repository writer can resume the same run.
4. Pin one verified package-owned workflow generation and invoke its `implementation` operation in a contained Codex process.
5. Validate the structured implementation report and the complete worktree diff.
6. Run the configured finite checks.
7. Freeze the checked change and invoke the pinned generation's `acceptance-proof` operation in a separate contained process.
8. Validate fresh proof artifacts and criterion coverage.
9. Publish through runner-owned Git and GitHub adapters, then mark the issue review-ready.

Implementation and proof retries are bounded. Crashes resume from durable intents instead of repeating already-confirmed external effects. Ambiguous ownership, process quiescence, repository identity, credentials, denied paths, or publication state fails closed with a typed result.

## Acceptance Proof

Proof is independent from implementation. The proof process receives a frozen description of the checked change and may write only under its proof artifact root. It cannot publish, mutate issue state, or reuse implementation authority.

Artifacts always receive size, hash, UTF-8, path-containment, and credential checks. Public artifacts have the stricter publication contract: screenshots or sanitized generated summaries only, with host identity removed. Local command output may retain machine paths because it is never published, but credentials remain forbidden everywhere.

Browser and mobile proof additionally require current workflow evidence. Mobile proof uses runner-owned Android or iOS leases and refuses to take over a user-owned device or app session.

## Package boundary

The npm package ships only:

- the compiled V2 runtime and adapter closure;
- one generated `internal-workflow` inventory containing declared skills, profiles, schemas, operation wrappers, and their exact manifest;
- this README, the architecture deep dive, changelog, and license.

The runtime materializes an immutable generation from that manifest before a new run and persists its receipt through every retry and proof attempt. Consumer `CODEX_HOME` skills and profiles are never workflow authority. There is no compatibility bridge, alternate public runtime, or Legacy CLI export.

## Development

```sh
npm run refresh:workflow
npm run typecheck
npm test
npm pack --dry-run --json
```

`npm run refresh:workflow` is the maintainer entrypoint for workflow updates. It imports the allowlisted skills and their accompanying files from `${CODEX_HOME:-$HOME/.codex}`, imports declared shared routing documents and eval suites, rebuilds `internal-workflow`, rejects stale or invalid bindings, and runs the focused workflow contract tests. The allowlist and operation dependency/resource bindings live in `scripts/agent-auto-workflow-source.json`; change that file only when the package's workflow structure should change.

The refresh is fail-fast rather than rollback-based: if a validation fails, the generated candidate remains visible in the working tree for inspection and must not be committed. Release publication independently runs source-free workflow verification and the full test suite before npm publication.

Operation adapters must link every declared primary skill, dependency skill, and shared resource. Eval files are packaged and schema-validated for maintainer evaluation, but are intentionally excluded from operation snapshots so workers do not receive unevaluated test context. `npm run check:workflow` is the non-writing drift check and `npm run verify:workflow` validates the committed generated package without consulting local skills.

`npm test` starts from a clean `dist` directory. `npm run smoke:live` packs the current package and mutates the configured scratch GitHub repository; run it only with explicit authorization. The default `core-release` profile contains the four external release proofs: package installation, real Codex, browser proof, and a safety-negative case.

See [docs/deep-dive.md](docs/deep-dive.md) for the trust and durability model and [docs/live-smoke-checklist.md](docs/live-smoke-checklist.md) for live validation.
