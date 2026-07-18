---
title: "Codex Orchestrator v2 Spec 8: public cutover and Legacy deletion"
created_at: "2026-07-17T11:39:02+03:00"
source_type: "plan"
source_plan: "/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-16/1655-agent-auto-v2-rewrite.md"
source_issues:
  - "None"
status: "complete"
execution_model: "single-agent"
spec_mode: "full"
review_profile: "high"
review_reasons:
  - "The package entrypoint changes once and a broad deletion must leave one executable runtime without breaking V2's concrete GitHub, Git, filesystem, or process adapters."
  - "Tarball, setup, operational scripts, and authoritative docs must all stop naming Legacy/plan-auto/graph/app-server/prompt-migration behavior."
review_outcome: "Waived"
review_verdict: "Not run; independent artifact and code review waived by user"
review_coverage: "Root executable self-checks replace independent review and must prove the public CLI, import closure, deleted surface, package inventory, docs, and scratch live handoff"
---

## 1. Execution Context

- **Goal:** Make V2 the only public/package runtime, delete superseded orchestration and tests, and leave a release-ready tarball with one authority.
- **Source Material:** Plan slice 10 in `/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-16/1655-agent-auto-v2-rewrite.md`, master spec `1906-agent-auto-v2-master.md`, and completed Spec 7 `0150-agent-auto-v2-operational-consumers.md`.
- **Approved Scope:** Public CLI/bin/export cutover; relocation of only V2-reachable concrete adapters; deletion of Legacy plan-auto/tree/mission/graph/reviewer/app-server/migration/prompt-sync runtime and obsolete tests/assets; package/docs/ADR/live-checklist reconciliation; local and authorized scratch validation.
- **Out of Scope:** New runtime behavior, compatibility mode, automatic migration, release publication, npm publish, push, automatic merge, production repository mutation, or new review passes.
- **Simplest Viable Path:** Point the public bin directly at the settled V2 CLI, keep `src/index.ts` as a narrow V2 API barrel, move the small concrete adapter closure under `src/v2/adapters`, then delete every unreachable Legacy source/test/asset in one cutover slice.
- **Primary Risk:** Retaining a hidden second authority or deleting a leaf adapter that V2 still reaches.

## 2. Preconditions And Evidence

- **Required Services / Env / Fixtures:** Existing Node/npm/git/gh toolchain; scratch repo `SergiiMytakii/codex-orchestrator-live-smoke` only for the final compact live gate. Mobile code is unchanged, so no mobile session is required.
- **Blocking Unknowns:** None.
- **Confirmed Targets:** `package.json`, `src/v2/candidate-cli.ts`, `src/index.ts`, `scripts/live-smoke.mjs`, `scripts/generate-bridge-runtime.mjs`, `internal-skills/`, `prompts/`, `bridge-runtime.json`, all non-V2 `src/` and `test/` paths, `README.md`, `AGENTS.md`, `CONTEXT.md`, `docs/agents/execution-routing.md`, `docs/deep-dive.md`, `docs/adr/0001-runner-owned-loop-policy.md`, `docs/adr/0002-adaptive-acceptance-proof.md`, `docs/live-smoke-checklist.md`, and `CHANGELOG.md`.
- **Confirmed Commands:** `npm run typecheck`, `npm test`, `npm pack --dry-run --json`, `npm run smoke:live -- --profile core-release --skip-local-tests`, `git diff --check`, and source/tarball `rg` scans.
- **Protected Paths / Rejected Approaches:** Do not modify the reference checkout, `.env*`, user-owned mobile sessions, the three settled Module ownership contracts, or retained fresh-cutover detection. Do not leave a Legacy flag, fallback import, compatibility export, copied prompt, bridge manifest, or second CLI.
- **Ownership / New Boundaries:** No new application Module. Concrete GitHub/Git/fs/process/fence leaves reachable by V2 move under `src/v2/adapters/`; deletion test: if a moved file owns lifecycle/setup/proof policy, stop instead of moving it. Pass-through barrels are deleted.

### Contract Test Ledger

| Invariant | First RED proof | Status |
| --- | --- | --- |
| Public `codex-orchestrator` invokes only the V2 command/status/result contract. | bin/help/version/setup/run snapshots against packed bytes | green |
| The package export surface contains only intentional V2 contracts. | root export compile/import test | green |
| V2 reaches no Legacy source directory after adapter relocation. | recursive relative-import closure and forbidden-path scan | green |
| Tarball contains one runtime plus `internal-skills`, with no prompts, bridge runtime, plan-auto, graph, app-server, migration, or old tests. | `npm pack --dry-run --json` inventory assertion | green |
| Setup remains detect-only for Legacy and explicit `--fresh` remains the only cutover operation. | existing V2 Setup matrix after deletion | green |
| Operational smoke/self-improvement invoke the same public V2 JSON path. | packed package-consumer and local self-improvement suites | green-local; final live pending |
| Authoritative docs describe only V2 ownership and commands. | forbidden-term/source-link scan | green |

## 3. Execution Slices

### Progress Discipline

- [x] Update this checklist as work is completed.
- [x] Keep the branch single-agent and do not push or publish.
- [x] Start each behavior slice with its public/package RED proof.
- [x] Stop if a deletion requires changing `RunIssue`, `AcceptanceProof`, or `Setup.execute` ownership rather than relocating a concrete leaf.

### Slice 1 — Public V2 entrypoint and API

- [x] **Test/Proof First:** Add packed/public CLI tests for exact help/version/setup/run JSON and a root-export import test that fail while `package.json` and `src/index.ts` still expose Legacy.
- [x] Point `package.json#bin` at the settled V2 CLI; rename candidate-facing help/errors to the public product name without adding another dispatcher.
- [x] Replace `src/index.ts` with the minimal intentional V2 API barrel; remove the old public config/runner/mission exports.
- [x] Update package scripts so daemon/status/doctor use only supported V2 commands; remove bridge-manifest generation and make prepack build the final bytes.
- [x] **Exit Gate:** public CLI/export tests, typecheck, and package consumer test pass before deletion.

### Slice 2 — Adapter closure and Legacy deletion

- [x] **Test/Proof First:** Add a recursive import-closure/tarball test that lists every non-`src/v2` dependency and every forbidden packaged Legacy surface.
- [x] Move only V2-reachable concrete GitHub/Git/fs/process/activity-fence leaves into `src/v2/adapters/`, update imports/tests, and prove no moved file owns lifecycle/proof/setup policy.
- [x] Delete obsolete `src/runner`, `src/setup`, `src/config`, `src/codex`, old adapter directories after relocation, old `src/cli.ts`, `src/bridge-runtime.ts`, and all non-V2 tests/fixtures that no longer test shipped behavior.
- [x] Delete `prompts/`, `bridge-runtime.json`, bridge-generation script, old package file entries, and stale generated/runtime-skill compatibility assets; retain only `internal-skills/` package assets.
- [x] **Exit Gate:** `rg` finds no plan-auto/tree/mission/graph/reviewer/app-server/bridge/prompt-sync execution surface; typecheck and all remaining tests pass.

### Slice 3 — Authoritative docs and final package proof

- [x] Rewrite README, AGENTS, CONTEXT, execution routing, deep dive, ADRs 0001/0002, live-smoke checklist, and changelog so V2 is the only authority; document install/update ownership, first setup, explicit label preparation, and one-time `setup --fresh`.
- [x] Remove package-auth, copied-prompt, skill activation/preparation, automatic migration, Fresh-Context Review, plan-auto, and old proof-command guidance.
- [x] Inspect `npm pack --dry-run --json`; assert one CLI/runtime, exact internal skills, no forbidden source/assets, and no consumer mutation hooks.
- [x] Run the compact four-scenario core live profile against scratch with strict cleanup because public package bytes changed; do not run mobile-proof because mobile code is unchanged.
- [x] **Exit Gate:** local/package/live gates are GREEN, scratch cleanup is verified, and no implementation-branch push or package publication occurred.

## 4. Halt Conditions

- [x] Verified V2 imports no policy-bearing Legacy coordinator after the adapter closure was computed.
- [x] Verified packed help/bin/export reaches only `src/v2/candidate-cli`.
- [x] Verified tarball inventory excludes `prompts/`, bridge runtime, plan-auto/tree/mission code, and old tests.
- [x] Verified scratch cleanup identified and removed exact run-owned artifacts.

## 5. Validation And Done Criteria

- [x] **Typecheck:** `npm run typecheck`.
- [x] **Tests:** `npm test` plus focused packed CLI/export/import-closure/package-consumer tests (163/163) and local self-improvement tests (31/31).
- [x] **Architecture Check:** recursive import closure, forbidden source/docs scan, and one-authority tarball inventory.
- [x] **Package:** `npm pack --dry-run --json` and clean consumer install/update.
- [x] **Live:** compact `core-release` against scratch with default Codex and strict cleanup; 4/4 passed in `/var/folders/vl/r4rjhh8j3kzgnw16w8c27zm40000gn/T/codex-orchestrator-v2-smoke-20260717085733-p2PqKC/live-smoke-report.md`.
- [x] **Diff:** `git diff --check`.
- [x] **Review:** independent cleanup/final review remain explicitly waived; root records executable self-check findings and repairs.
- [x] **Final Reconciliation:** Spec 8, Spec 7, and master tables/checklists contain no unexplained unchecked item or open defect.
- [x] **Final Handoff Requirements:** report the public contract, deleted surfaces, retained adapter closure, package inventory, local/live validation, cleanup, skipped mobile/review gates, residual risks, commits, and files by role.

## 6. Execution Outcome

- Public cutover checkpoint: `477648c` (`feat: cut over public runtime to v2`).
- Local validation: `npm run typecheck`; `npm test` 163/163; self-improvement 31/31; clean package consumer install/update; `npm pack --dry-run --json`; `git diff --check`.
- Package result: one V2 CLI/runtime, 148 entries, 180235 packed bytes, exact package-owned internal skills, no prompts/bridge/old tests or alternate runtime.
- Live result: package-install, real-codex, browser-proof, and safety-negative passed against `SergiiMytakii/codex-orchestrator-live-smoke`; strict cleanup passed.
- Skipped by contract: mobile proof because mobile code did not change; independent cleanup/final reviews because the user waived them.
- Residual accepted risk: ordinary Codex and native subagents may use shared user-owned Codex auth and read same-user host files; external publication credentials remain scrubbed and credential material is forbidden in outputs/artifacts.
- No push, npm publication, release, production-repository mutation, or user-owned mobile-session takeover occurred.

## 7. Final Action

Execute this spec immediately as the current authorized child. Do not push, publish, or create a release. Completion requires one public V2 authority and a tarball with no superseded runtime.
