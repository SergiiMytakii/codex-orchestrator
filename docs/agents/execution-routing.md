# Agent Execution Routing

This document holds repo-specific execution rules that are too detailed for
`AGENTS.md`.

## Source Of Truth

- `README.md` explains the product workflow and user-facing commands.
- `docs/deep-dive.md` explains package vs repository policy, the runner
  lifecycle, validation checks, review gates, deny rules, durable state, and the
  current architecture boundaries.
- `docs/adr/0001-runner-owned-loop-policy.md` records the decision that loop
  policy, rework bounds, durable memory, and publication remain runner-owned.
- `.codex-orchestrator/config.json` is this repository's live runner policy for
  checks, review gates, acceptance proof, deny rules, branches, issue labels,
  and workflow prompt paths.
- `package.json` is the source of truth for local npm scripts.
- `tsconfig.json` is the source of truth for TypeScript strictness and module
  resolution.

## Quality And Boundary Preflight

Run this preflight before changing imports, module ownership, runner jobs,
services, scripts, cross-module wiring, validation behavior, review gates,
branch policy, or publication behavior.

1. Read the relevant source of truth first:
   - `docs/deep-dive.md` for package/repository policy, validation, review
     gates, deny rules, and current boundaries.
   - `docs/adr/0001-runner-owned-loop-policy.md` for loop ownership and
     publication authority.
   - `.codex-orchestrator/config.json` for configured checks, review gates,
     acceptance proof, deny paths, branch templates, and workflow prompt
     routing.
   - `package.json` before adding, removing, or relying on npm scripts.
   - `tsconfig.json` before changing TypeScript module or import behavior.
2. Confirm whether the change affects runtime paths covered by
   `reviewGates.quality.runtimeChangedPathGlobs` or test paths covered by
   `reviewGates.quality.testChangedPathGlobs`.
3. After code changes, run the smallest relevant local guard:
   - `npm run typecheck` for imports, types, module boundaries, config shape,
     and script wiring.
   - `npm test` for behavior, runner policy, validation, branch, publication,
     safety, prompt, or lifecycle changes.
4. Report any skipped guard with a concrete reason.

There is currently no dedicated lint script and no dedicated architecture-check
script in `package.json`. If a spec or prompt asks for one, state that none is
configured and use the relevant source-of-truth docs plus `npm run typecheck`
or `npm test` instead.

Do not run `npm run smoke:live` unless the user explicitly asks for it. The live
smoke suite creates or updates real GitHub issues, branches, and draft PRs. When
live smoke is requested after implementation, choose the narrowest profile that
matches the changed contract:

- default / ordinary release gate: `npm run smoke:live -- --profile core-release`
  (or just `npm run smoke:live`);
- loop policy, remote base branch, blocking parent planning, or extra policy
  edge cases: `npm run smoke:live -- --profile extended-policy`;
- browser, Acceptance Proof, UI Evidence, or proof-loop changes:
  `npm run smoke:live -- --profile proof-matrix`;
- release-signoff after changing policy, proof, publication, or scenario
  selection behavior itself: `npm run smoke:live -- --profile full`;
- one known contract only: `npm run smoke:live -- --scenario <name>`.

If multiple categories apply, run the broader matching profile. Always report
when live smoke is skipped and give the concrete reason.

## Ownership Boundaries

- Runner-owned publication means only runner code should push branches, open
  draft PRs, merge child branches into integration branches, change labels,
  post comments, publish packages, or deploy.
- Codex agent output is untrusted until the runner validates the full local
  change set: committed, staged, unstaged, and untracked paths.
- Deny rules and completion-report safety are publication blockers. Keep
  `src/runner/safety.ts` and related tests as the single enforcement path for
  changed-path safety.
- Target repository policy belongs under `.codex-orchestrator/`; reusable
  orchestration behavior belongs in `src/`.
- Package-bundled prompts live in `prompts/`; setup copies them into target
  repositories and tracks local edits through the prompt manifest.

## Validation Routing

- Docs-only restructuring: inspect the diff and line counts; skip tests with
  the reason `docs-only`.
- Behavior-changing TypeScript: use TDD, then run `npm test` before handoff.
- Type-only, import-only, or script-wiring changes: run `npm run typecheck`; run
  `npm test` too when behavior or runner policy could change.
- Release changes: update `CHANGELOG.md`, keep release guidance concise in
  `AGENTS.md`, and avoid manual `npm publish` unless the GitHub release
  workflow is unavailable.
- Acceptance proof work: follow `reviewGates.acceptanceProof` in
  `.codex-orchestrator/config.json`; `reviewGates.visualProof` is a
  compatibility adapter for screenshot/mobile proof. Missing local
  browser/device tooling must be reported as a concrete limitation.

## Review Gates

- Runtime code changes should include matching test changes unless the quality
  gate policy is intentionally changed.
- Medium or larger runtime changes should include cleanup-review and code-review
  evidence before final handoff.
- Fresh-context review, durable run summaries, and policy suggestions are
  runner-controlled behavior; do not turn them into agent-owned GitHub actions.
