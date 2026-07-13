# codex-orchestrator Lessons

Curated package lessons for future agent work. Newest entries go first.

Use [entry-template.md](./entry-template.md) for every new entry. Keep entries
small, evidence-backed, and scoped to a repeatable package pattern.

## Active Lessons

## 2026-07-10 - Use compiled `dist/test` commands for targeted package tests

Scope: tests
Evidence: `docs/plans/2026-07-03/1219-plan-auto-tree-recovery-resume.md` still suggests targeted commands like `npm test -- test/plan-auto-command.test.ts`, while `.codex-orchestrator/state/summaries/issue-1215-issue-1215-20260708060355.json` records that source `.ts` paths passed to `npm test -- ...` failed with `ERR_MODULE_NOT_FOUND` and the compiled `npm run build --silent && node --test dist/test/...` equivalent passed.
Lesson: When you need a focused package test in this repo, do not assume `npm test -- test/<name>.test.ts` will work. The package test flow runs built `dist/test/*.js` files, so targeted verification should usually use the compiled `node --test dist/test/<name>.test.js` form after a build, while `npm test` remains the safe full-suite command.
Use when: A plan, prompt, or local debugging step asks for one or a few targeted package tests under `test/`.
Do not use when: The task is the full suite, local self-improvement `.mjs` tests under `.codex-orchestrator/local/`, or a command already proven against the current package test script.
Review after: 2026-08-10

## 2026-07-03 - Separate tracked self-improvement sources from ignored local outputs

Scope: agent workflow
Evidence: `git log --since='7 days ago' --stat -- .codex-orchestrator/local/self-improvement` shows `607e685` added tracked self-improvement runner sources and `a2d060d` updated them, while `.codex-orchestrator/state/summaries/issue-1132-issue-1132-20260702060356.json` ended `review-ready` with those two tracked files in `changedFiles`.
Lesson: Do not treat `.codex-orchestrator/local/self-improvement/*` as automatically local-only. The tracked runner source and test files now publish through the normal package flow; only ignored or generated local artifacts should trigger local-only or promotion-needed handling.
Use when: A self-improvement task touches `.codex-orchestrator/local/self-improvement/*` and you need to decide whether normal runner publication should proceed.
Do not use when: The diff is limited to ignored outputs such as local reports or runner state, or when the task is intentionally read-only.
Review after: 2026-08-03

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

## 2026-06-26 - Treat ignored local self-improvement files as publication blockers

Retired: Superseded on 2026-07-03 after `607e685` made the self-improvement runner sources tracked package files and issue `#1132` reached normal `review-ready` handoff with changes in those files.
