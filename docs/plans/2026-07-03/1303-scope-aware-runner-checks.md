---
title: "Scope-Aware Runner Checks For Child Tasks"
created_at: "2026-07-03T10:03:45Z"
complexity: "simple"
status: "ready-for-approval"
---

## 1. Executive Summary
- **Goal:** Prevent tree-child work from blocking on unrelated full-suite checks while still requiring validation that matches the child task scope.
- **Scope:** Add runner-owned scope-aware check selection for child publishability checks. Keep full configured checks for parent/final integration. Do not change rework decision compatibility wrappers because the project has already moved to `decideImplementationRework`.
- **Chosen Option:** Option 1, scope-aware validation policy, with final parent integration retaining broad checks.
- **Why This Approach:** The runner already has `changedFiles`, `checksPolicy`, and separate child vs parent check call sites, so the simplest sufficient fix is to filter configured checks by execution phase/scope before they run.

## 2. Current Understanding
- **Confirmed:** `runImplementationPublishabilityCheck` passes child `changedFiles` into `runConfiguredChecks`. `runConfiguredChecks` currently iterates every entry in `config.checks`. Parent issue-tree integration separately calls `runConfiguredChecks(config, worktreePath, shellExecutor, [])` after merging children. Failed configured checks flow into `decideImplementationRework` as `failed-configured-checks`, which is retryable when configured. Existing `checksPolicy` only handles missing npm scripts and lint baseline behavior.
- **Assumptions:** The intended child behavior is targeted validation: docs-only/config-only children should not be forced through a full repo test suite unless their config explicitly requires it. Parent/final integration may still run broad validation to catch cross-child breakage before PR publication.
- **Open Decisions:** None for implementation. The chosen behavior is delegated by user approval of the recommended option.

## 3. Architectural Design
- **Component Flow:** Child Codex run writes report -> publishability collects `changedFiles` -> runner selects applicable configured checks for `phase: child` -> targeted checks run -> failed applicable checks trigger rework. Parent integration merges children -> runner selects `phase: parent-integration` -> full configured checks run -> failures block parent publication.
- **Simplest Viable Path:** Extend `checksPolicy` with a small optional scope filter and update `runConfiguredChecks` to accept a phase/scope input. Default behavior remains current full-check behavior unless scope policy is configured or the built-in docs-only child rule safely skips broad checks.
- **Why Not Simpler:** Editing only one repo's `.codex-orchestrator/config.json` would stop the current backend failure but would not fix the runner contract. Changing only `decideImplementationRework` would make failed full-suite checks retryable, but the agent would keep retrying against an irrelevant blocker.
- **Architecture Lens:** Module: runner validation/check execution. Interface: `runConfiguredChecks` plus `CodexOrchestratorConfig.checksPolicy`. Seam: no new adapter; use the existing command executor seam. Deletion test: a small selector helper is acceptable only if it centralizes the check applicability rule and avoids spreading path matching across child/parent call sites. Depth/Leverage/Locality: keep rule local to check execution while leveraging existing `changedFiles` and config schema.
- **Clean Architecture Map:** Domain: check applicability policy names and scope categories. Application/Use Case: child publishability and parent integration decide the phase. Infrastructure: shell command execution remains in `runConfiguredChecks`. Presentation: GitHub comments and durable summaries reuse existing validation lines and skipped-check reporting.
- **Reuse Strategy:** Reuse `runConfiguredChecks` in `src/runner/command-utils.ts`, `runImplementationPublishabilityCheck` in `src/runner/local-execution-session.ts`, parent final validation in `src/runner/plan-auto-command.ts`, config validation/default merge in `src/config/schema.ts` and `src/setup/project-config.ts`, and existing tests in `test/local-execution-session.test.ts`, `test/plan-auto-command.test.ts`, and `test/config-schema.test.ts`.
- **Rejected Paths:** Do not make every child pass `npm test` unconditionally. Do not hide unrelated failures by marking all failed checks advisory. Do not add a new validation subsystem or external plugin. Do not classify unrelated full-suite failures as `unknown` hard-blocks. Do not remove parent/final integration checks.

## 4. Constraints And Edge Cases
- **Data And Scale:** `changedFiles` is already an array of paths; path matching must be linear over configured rules and changed files. No pagination, database access, or large payload handling is involved.
- **Errors And Fallbacks:** Invalid scope-policy config must fail config validation with a clear message. Missing npm script behavior remains governed by `checksPolicy.missingNpmScript`. If no scope rule matches and the task is not safely docs-only/config-only, default to running the configured check rather than skipping it.
- **Concurrency And State:** Child runs may execute in parallel, so check selection must be pure and per invocation. Do not mutate shared config. Rework attempts must use the same deterministic check selection unless changed files change.

## 5. Impacted Areas
- `src/config/schema.ts`: add optional schema/types for scoped check policy.
- `src/setup/project-config.ts`: add defaults and merge behavior for the new policy without changing existing configs unexpectedly.
- `src/runner/command-utils.ts`: select applicable configured checks and emit skipped validation lines for intentionally skipped checks.
- `src/runner/local-execution-session.ts`: pass child phase/scope into `runConfiguredChecks`.
- `src/runner/plan-auto-command.ts`: pass parent integration phase so broad checks remain mandatory.
- `test/config-schema.test.ts`: cover valid and invalid policy config.
- `test/local-execution-session.test.ts`: cover docs-only child skipping broad full-suite checks while still passing publishability.
- `test/plan-auto-command.test.ts` or a focused command-utils test: cover parent integration still running full configured checks.
- `docs/live-smoke-checklist.md` or a new smoke note if existing docs are not suitable: document a smoke scenario for docs-only child vs parent final validation.

## 6. Execution Slices And Multi-Agent Model
- **Slices:** 
  1. Add a behavior-first test proving a docs-only child does not run an unrelated full-suite check and records it as skipped/advisory evidence.
  2. Implement the minimal check selector in `runConfiguredChecks` and wire child phase from `runImplementationPublishabilityCheck`.
  3. Add a behavior-first test proving parent integration still runs the full configured check set.
  4. Extend config schema/default merge only as needed for explicit project overrides.
  5. Add and run a smoke test scenario for this bug: a docs-only child with a deliberately failing broad `test` check should reach publish-ready or scheduled rework only for scoped blockers, while parent integration still blocks on the same failing broad check.
- **Per-Slice Test/Proof:** 
  1. RED test in `test/local-execution-session.test.ts`: changed file `docs/example.md`, config includes `checks.test = "npm test"` and a policy marking `test` parent-only or runtime-only; shell executor must not receive `npm test` during child publishability.
  2. GREEN implementation proof: the same test passes and validation includes an explicit skipped line for the skipped check.
  3. RED/GREEN parent test: parent final validation invokes `npm test` with empty or parent phase scope and blocks when it fails.
  4. Schema proof: `node --test dist/test/config-schema.test.js` after build, or source-level test command used by the repo.
  5. Smoke proof: run a focused smoke command or documented manual smoke that exercises child and parent paths with fake shell executor/test fixture; save command and result in the plan/spec follow-up.
- **Exit Gates:** `npm run build`, focused node tests for config schema, local execution session, plan-auto parent final validation, and rework policy if touched. Final validation should prefer targeted tests for changed modules, not full repo test suite unless this change broadens behavior.
- **Agent Matrix:** Not required for simple complexity.
- **Parallelization Limits:** Do not run child behavior and parent final validation edits in parallel because both touch `runConfiguredChecks` semantics. Tests can be run in parallel after implementation if they do not mutate shared fixtures.

## 7. Implementation Handoff Contract
- **approval_state:** ready-for-approval
- **approved_scope:** Implement scope-aware check selection for runner configured checks, limited to `checksPolicy`, `runConfiguredChecks`, child publishability wiring, parent integration wiring, tests, and a smoke scenario note.
- **do_not_touch:** Do not change GitHub issue labels/state, daemon runtime state, codex MCP/Figma behavior, publication safety rules, acceptance proof behavior, or unrelated dirty files.
- **architecture_rules:** Keep one source of truth for check applicability. Preserve existing default behavior unless the phase/scope rule clearly says a check is not applicable. Parent/final integration remains broad. Child validation must remain strict for checks applicable to the child's changed files.
- **rejected_paths:** No repo-only workaround as the primary fix. No disabling all tests globally. No new runner subsystem. No compatibility wrappers for removed rework helpers. No hard-block for unrelated full-suite child failure when scoped policy says it is outside task scope.
- **required_docs:** Add a concise smoke scenario entry if no existing test name makes the behavior obvious. No broad architecture doc update required.
- **preconditions:** Node/npm environment for `codex-orchestrator`; no external services required for unit tests.
- **phase_boundaries:** First prove child scoped skip, then implement child selector, then prove parent full check, then add config/schema override support, then smoke the bug scenario.
- **validation_gates:** `npm run build`; focused tests for `local-execution-session`, `plan-auto-command` or command-utils, and `config-schema`; smoke scenario command/result for docs-only child and parent final validation.
- **blocking_assumptions:** None.
