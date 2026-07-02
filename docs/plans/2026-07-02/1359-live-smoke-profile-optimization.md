---
title: "Live smoke profile optimization"
created_at: "2026-07-02T13:59:27+03:00"
complexity: "medium"
status: "approved"
---

## 1. Executive Summary
- **Goal:** Reduce live smoke top-level scenario sprawl, add explicit run profiles, and remove the standalone `visual-proof` live smoke scenario because canonical proof coverage now lives under Acceptance Proof and browser proof.
- **Scope:** In scope: `scripts/live-smoke.mjs`, `test/live-smoke-script.test.ts`, `docs/live-smoke-checklist.md`, and `CHANGELOG.md` if the implementation is release-noteworthy. Out of scope: runtime visual proof commands, `reviewGates.visualProof` config/schema, proof evaluators, GitHub adapters, daemon behavior, and npm package exports.
- **Chosen Option:** Option 2, recommended: add profiles, merge related smoke cases into matrix scenarios, and delete only the redundant `visual-proof` live smoke scenario.
- **Why This Approach:** It lowers default live smoke cost and mental load without weakening runner-owned publication, safety, Acceptance Proof, UI Evidence, plan-auto, or real-Codex coverage.

## 2. Current Understanding
- **Confirmed:** `scripts/live-smoke.mjs` currently registers 25 top-level scenarios in `scenarioDefinitions`; no `--profile` option exists; default selection is every registered scenario; `--scenario` can be repeated and selects exact scenarios.
- **Confirmed:** Several top-level scenarios already contain subcase matrices: `discovery-matrix`, `quality-gates`, `acceptance-proof-blocking`, `acceptance-proof-ui-evidence-blocking`, `loop-policy`, and `plan-auto-blocking`.
- **Confirmed:** `docs/deep-dive.md` and `docs/adr/0002-adaptive-acceptance-proof.md` state that `reviewGates.acceptanceProof` is canonical and `reviewGates.visualProof` is a migration adapter. `docs/contract-test-ledgers/2026-05-20-acceptance-proof-completion.md` names `acceptance-proof-ui-evidence` and `acceptance-proof-ui-evidence-blocking` as the live smoke proof for UI Evidence.
- **Confirmed:** `docs/live-smoke-checklist.md` omits `remote-base-branch` from the automated scenario map even though the script and help test include it.
- **Assumptions:** The repo-local `scripts/live-smoke.mjs` scenario names are not a published public API. Removing old top-level names is acceptable if docs and tests are updated in the same change.
- **Open Decisions:** None. The user selected the optimization direction and explicitly asked to remove `visual-proof` if it is not needed as a standalone live smoke scenario.

## 3. Architectural Design
- **Component Flow:** CLI args parse `--scenario` and `--profile`; scenario selection resolves to an ordered list; the existing scenario runner executes each selected scenario; matrix scenarios create the same underlying smoke issues they create today; cleanup remains unchanged.
- **Simplest Viable Path:** Keep `scenarioDefinitions` as the single source of executable scenarios. Add one small `scenarioProfiles` map plus validation in `parseArgs`/selection. Rename only top-level scenario entries where matrix consolidation is useful; preserve existing fake-agent internal issue markers for subcases.
- **Final Top-Level Scenario List:** `baseline`, `package-install`, `discovery-matrix`, `real-codex`, `remote-base-branch`, `scoped-runner-commit`, `commit-policy`, `run-scoped`, `loop-policy`, `diagnostics`, `browser-proof`, `acceptance-proof-positive`, `acceptance-proof-rework`, `acceptance-proof-negative`, `quality-gates`, `risk-routing`, `safety-negative`, `plan-auto`, `run-plan-auto`, `plan-auto-blocking`.
- **Profiles:** `core-release` is the default for `npm run smoke:live` and includes `baseline`, `package-install`, `discovery-matrix`, `real-codex`, `scoped-runner-commit`, `commit-policy`, `run-scoped`, `diagnostics`, `browser-proof`, `acceptance-proof-positive`, `quality-gates`, `risk-routing`, `safety-negative`, `plan-auto`, and `run-plan-auto`. `extended-policy` includes `remote-base-branch`, `loop-policy`, `acceptance-proof-rework`, `acceptance-proof-negative`, and `plan-auto-blocking`. `proof-matrix` includes `browser-proof`, `acceptance-proof-positive`, `acceptance-proof-rework`, and `acceptance-proof-negative`. `full` includes every final top-level scenario.
- **Why Not Simpler:** Documentation-only grouping would not reduce default runtime or top-level scenario count. Keeping old top-level aliases would preserve compatibility but would not optimize the 25-scenario surface.
- **Architecture Lens:** The live smoke script remains one harness module. No new package module, adapter, or abstraction is needed. The profile map is a data table, not a new subsystem; deleting it would return the script to current all-scenarios behavior, so it has a concrete current purpose.
- **Clean Architecture Map:** Domain: live smoke contracts and scenario/profile names. Application/Use Case: scenario selection and matrix orchestration in `scripts/live-smoke.mjs`. Infrastructure: `gh`, `git`, npm pack/install, temp repo, cleanup. Presentation: CLI help text and docs checklist.
- **Reuse Strategy:** Reuse `runDaemonOnce`, `runDirectIssue`, `createIssue`, `assertScopedSuccess`, `assertBlockedIssue`, `assertPlanAutoSuccess`, `assertNoPullRequestForBranch`, `assertNoRemoteBranch`, and the existing fake-agent scenario markers.
- **Rejected Paths:** Do not remove runtime `visual-proof` commands or config support. Do not add a separate YAML/JSON profile config file. Do not keep old scenario names as aliases in `scenarioDefinitions`. Do not run live smoke as part of implementation unless explicitly requested.

## 4. Constraints And Edge Cases
- **Data And Scale:** Scenario/profile lists are tiny and in-memory. The relevant scale risk is external runtime cost from GitHub issue/PR creation, not data volume.
- **Errors And Fallbacks:** Unknown `--profile` should fail with a message listing known profiles. Unknown `--scenario` should keep the existing validation behavior. `--scenario` should override `--profile` so focused reruns stay deterministic.
- **Concurrency And State:** Do not parallelize live smoke scenario execution; the harness relies on `assertNoEligibleIssues` and single eligible issue pickup. Cleanup discovery must still identify artifacts by run id even when scenarios are grouped under matrix names.

## 5. Impacted Areas
- `scripts/live-smoke.mjs`: add profile parsing/selection/help; replace selected top-level scenarios with matrix scenario names; delete standalone `visual-proof` scenario and its dedicated generated proof script; keep browser/acceptance proof paths.
- `test/live-smoke-script.test.ts`: update help expectations for profiles, new scenario names, removed scenario names, and `remote-base-branch` docs consistency.
- `docs/live-smoke-checklist.md`: document profiles, new top-level scenario map, removed `visual-proof` top-level scenario, and `remote-base-branch`.
- `CHANGELOG.md`: add a short unreleased note if the repo convention expects release notes for smoke harness changes.

## 6. Execution Slices And Multi-Agent Model
- **Slices:** Slice 1: Add profile parsing and help output with `core-release` as the default and `full` as the explicit all-scenarios profile. Slice 2: Consolidate commit, safety, and acceptance proof scenarios into matrix top-level entries. Slice 3: Remove the standalone `visual-proof` live smoke scenario and unused helper code. Slice 4: Update docs and final validation.
- **Per-Slice Test/Proof:** Slice 1 starts with `test/live-smoke-script.test.ts` expectations for `--profile`, profile names, and default profile behavior in help. Slice 2 starts with help/registration expectations for `commit-policy`, `safety-negative`, `acceptance-proof-positive`, and `acceptance-proof-negative`. Slice 3 starts with expectations that `visual-proof` is absent from live smoke help while `browser-proof` and Acceptance Proof scenarios remain. Slice 4 verifies docs mention `remote-base-branch` and profile usage.
- **Exit Gates:** Run `npm test` after implementation because this changes script behavior and registration tests. If time or external state blocks full tests, run at minimum `npm run build` and `node --test dist/test/live-smoke-script.test.js`, then report the skipped full gate. Do not run `npm run smoke:live` without explicit user approval.
- **Agent Matrix:** Main agent owns all changes. No subagent is needed because the write set is small and tightly coupled.
- **Parallelization Limits:** Do not split edits across agents or phases that both touch `scripts/live-smoke.mjs`; scenario selection and help text must stay synchronized.

## 7. Implementation Handoff Contract
- **approval_state:** approved
- **approved_scope:** Optimize repo-local live smoke scenario organization by adding profiles, merging related top-level scenarios into matrices, removing the standalone `visual-proof` live smoke scenario, and updating tests/docs.
- **do_not_touch:** Do not edit `.env` or `.env.*`. Do not remove or weaken `src/runner/*visual-proof*`, `reviewGates.visualProof`, config schema compatibility, Acceptance Proof validators, GitHub publication code, or daemon/runner state behavior.
- **architecture_rules:** Keep `scripts/live-smoke.mjs` as the single executable source of scenario/profile selection. Keep `--scenario` deterministic and higher priority than `--profile`. Keep cleanup, run id tracking, issue markers, and fake-agent internal subcase markers compatible with existing assertions.
- **rejected_paths:** No external profile file, no live smoke execution without explicit approval, no broad proof-system refactor, no compatibility aliases that keep the old 25 top-level scenario surface.
- **required_docs:** Update `docs/live-smoke-checklist.md` scenario map and focused-run examples. Add a changelog note only if consistent with current release-note practice.
- **preconditions:** Local dependencies installed; GitHub CLI auth is not required for unit/help tests. Live smoke execution remains opt-in and requires scratch repo access.
- **phase_boundaries:** First tests/help contract, then profile selection implementation, then scenario matrix consolidation, then `visual-proof` scenario deletion, then docs/changelog reconciliation, then validation.
- **validation_gates:** `npm test` is the final required gate. Focused fallback: `npm run build` plus `node --test dist/test/live-smoke-script.test.js`.
- **blocking_assumptions:** None.
