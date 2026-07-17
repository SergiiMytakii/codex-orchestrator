# Agent execution routing

## Sources of truth

- `README.md`: public commands and lifecycle.
- `docs/deep-dive.md`: trust, containment, durability, proof, and publication.
- `.codex-orchestrator/config.json`: this repository's exact live V2 policy.
- `src/v2/`: reusable policy core.
- `src/v2/adapters/`: package-owned transport and persistence closure.
- `package.json`: scripts and npm publication boundary.

## Change routing

- Behavior-changing TypeScript: use TDD, then `npm run typecheck` and `npm test`.
- Import, export, package, or script changes: run typecheck, focused contract tests, and `npm pack --dry-run --json`.
- Proof changes: run the relevant proof tests and preserve credential, path, freshness, diff, and lease checks.
- Process or authorization changes: prove the environment allowlist, process-group quiescence, and finite Runner action boundary.
- Docs-only changes: inspect authoritative-doc terminology and `git diff --check`.

The build must clean `dist` before compilation. Stale compiled modules are a package-boundary failure even when current source is correct.

## Ownership rules

- Agent processes may change only their assigned worktree and structured report/artifact paths.
- Tool environments do not inherit GitHub, SSH, npm, or cloud publication
  credentials. Shared user-owned Codex auth and same-user host-file reads are an
  explicit accepted local risk and must never be copied into output.
- Only Runner adapters may perform GitHub writes, publication, durable ownership, or device lease actions.
- All direct and daemon work must enter the same `runIssue` lifecycle.
- Target policy belongs under `.codex-orchestrator/`; reusable behavior belongs under `src/v2/`.
- Never read, print, or edit `.env` or `.env.*`.

## Live smoke

`npm run smoke:live` mutates the configured scratch GitHub repository. Run it only with explicit user authorization.

- Default release gate: `npm run smoke:live` or `--profile core-release`.
- One focused integration: repeat `--scenario <name>`.
- Broader policy matrix: `--profile extended-policy`.
- Every run uses strict cleanup unless the user explicitly requests retained evidence.

Do not substitute a production repository for the scratch repository. The smoke script must pack and execute the current package rather than invoke a nearby source checkout.

## Release

Update `CHANGELOG.md`, verify the clean tarball, and use the repository's GitHub release workflow. Do not run `npm publish` manually unless that workflow is unavailable and the user authorizes the fallback.
