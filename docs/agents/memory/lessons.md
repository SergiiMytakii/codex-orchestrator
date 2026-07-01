# codex-orchestrator Lessons

Curated package lessons for future agent work. Newest entries go first.

Use [entry-template.md](./entry-template.md) for every new entry. Keep entries
small, evidence-backed, and scoped to a repeatable package pattern.

## Active Lessons

## 2026-06-26 - Treat ignored local self-improvement files as publication blockers

Scope: agent workflow
Evidence: `.codex-orchestrator/state/summaries/issue-1043-issue-1043-20260619070305.json` ended `blocked` with `Codex completed without file changes` after validated edits under ignored local self-improvement files, and `.codex-orchestrator/state/summaries/issue-1050-issue-1050-20260620075357.json` ended `promotion-requested` because verified changes in `.codex-orchestrator/local/` could not be carried through the normal git change set.
Lesson: When work is scoped only to `.codex-orchestrator/local/self-improvement/*`, treat normal runner publication as blocked up front. Those paths are ignored by git, so a child can complete valid local changes and still surface as `no file changes` or `promotion-requested`. Validate the local result, then report it as local-only or promotion-needed instead of expecting draft PR handoff.
Use when: A self-improvement or local-runner task edits only `.codex-orchestrator/local/` files and the run report conflicts with the verified local diff.
Do not use when: The task changes tracked package files in `src/`, `test/`, `prompts/`, or other publishable paths, or when the workflow is intentionally read-only.
Review after: 2026-07-26

## 2026-06-12 - Verify proof commands against the package-local CLI

Scope: acceptance proof
Evidence: `.codex-orchestrator/local/self-improvement/reports/review-773.json` says issue `#773` was blocked by `Unknown command: visual-proof` from an ambient `codex-orchestrator`, while the later review confirmed `node dist/src/cli.js --help | rg "visual-proof"` passed and the runner prepended a package-local CLI shim.
Lesson: When proof or review reports say a `codex-orchestrator` subcommand does not exist, verify which binary actually ran before treating it as a product or workflow regression. A stale global install can produce a false blocker even when the built package-local CLI already supports the command.
Use when: Local review, proof, or self-improvement evidence reports an unknown or missing `codex-orchestrator` command in this repository.
Do not use when: The failure was reproduced against the current package-local build or the error is about command arguments, auth, or runtime behavior after the correct binary is confirmed.
Review after: 2026-07-12

## Retired Lessons

Move entries here when they were promoted to source-of-truth docs, superseded by
code changes, or expired after review.
