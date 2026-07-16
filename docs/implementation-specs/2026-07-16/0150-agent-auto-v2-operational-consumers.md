---
title: "Codex Orchestrator v2 Spec 7: operational consumers"
created_at: "2026-07-17T01:49:51+03:00"
source_type: "plan"
source_plan: "/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-16/1655-agent-auto-v2-rewrite.md"
source_issues:
  - "None"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_profile: "high"
review_reasons:
  - "Live smoke mutates a scratch GitHub repository and must prove the packed V2 CLI rather than a source-only or Legacy execution path."
  - "The local daily self-improvement runner creates/reuses issues and must consume typed CLI JSON without interpreting human stdout."
review_outcome: "Waived"
review_verdict: "Not run; independent artifact and code review waived by user"
review_coverage: "Root executable self-checks cover scenario deletion/adaptation, packed single-runIssue routing, typed JSON consumption, one-issue daily idempotency, and live-mutation authorization boundaries"
approved_content_sha256: "9158f35e6af17766e013e4f81b425d0306be3789a0a5667ffdbcdf4d1fd68f88"
source_plan_sha256: "e6dd64cdc7dbd3bec1c2734782b314443335822e8523591758230c71c6d2f6aa"
---

## 1. Execution Context

- **Goal:** Make packaged live smoke and the optional local self-improvement runner consume only the settled V2 CLI JSON and single `runIssue` path, while deleting assertions for removed Legacy/plan-auto policy.
- **Predecessor Gate:** Specs 1-6 are complete. `RunIssue`, `AcceptanceProof`, Setup, candidate JSON contracts, package snapshots, and config/state roots are settled; public CLI remains Legacy until Spec 8.
- **Approved Scope:** Rewrite the live-smoke scenario/profile matrix and fake agent for V2 contracts; add a candidate packaged-CLI harness if needed before public cutover; adapt local self-improvement implementation parsing and tests; preserve discovery/review prompts, fingerprints, one daily issue, exact `agent:auto`, global lock, post-success smoke, and phase summaries.
- **Out of Scope:** Public CLI/export/bin switch, Legacy runtime deletion, package release/publication, production repository mutation, daemon scheduling, new self-improvement package skill, plan-auto/tree compatibility, automatic daily live run without authorization.
- **Authorization Boundary:** Local/fake/package tests are authorized. `npm run smoke:live` and a deliberate daily self-improvement run remain external GitHub mutations and require the separate explicit authorization named by the master and repository policy.

## 2. Exact Operational Contract

- Direct run, serial daemon, live smoke, and self-improvement all consume one versioned CLI result schema produced from `RunIssueOutcome`; none may inspect prose, stderr fragments, old exit-zero blocked text, local run-record internals, or Legacy commands.
- Before Spec 8 switches the public bin, live-smoke tests invoke a package-contained V2 candidate entrypoint that uses the same thin parser/render/exit mapping intended for the final bin. It may compose production Adapters, but it may not duplicate lifecycle or Setup policy.
- Live-smoke keeps scenario intent for `baseline`, `package-install`, `discovery-matrix`, `real-codex`, `remote-base-branch`, `scoped-runner-commit`, `run-scoped`, `incomplete-progress-rework`, `report-repair`, and `safety-negative`.
- `commit-policy` proves agent-authored HEAD/commit rejection and one runner-authored deterministic publication commit. `loop-policy` proves bounded rework/durable outcomes only. `diagnostics` proves clean config/state/owner/CLI JSON only. Browser/Acceptance Proof scenarios consume generated V2 schemas. `quality-gates` proves configured checks, containment, safety, and proof only.
- Delete `risk-routing`, `plan-auto`, `run-plan-auto`, `plan-auto-blocking`, `tree-child-quality-rework`, and `plan-auto-tree-recovery`, including fake-agent branches, fixtures, profile membership, cleanup assumptions, and assertions.
- Profiles remain `core-release`, `extended-policy`, `proof-matrix`, and `full`; add `mobile-proof`, containing the non-skippable Android/iOS scenario gates required when those proof paths change.
- Self-improvement keeps `preflight -> discover/reuse one fingerprinted agent:auto issue -> one targeted V2 run -> live smoke only after review-ready -> evidence review`. It persists typed status/summary data and never treats exit code alone as success.

## 3. Confirmed Targets

- `scripts/live-smoke.mjs` — authoritative scenario/profile registry, packed candidate preparation, target setup, fake agent, scenario assertions, report, and strict cleanup.
- `test/live-smoke-script.test.ts` — help/profile/scenario deletion, fake-agent generated V2 report, packed-path, cleanup, and no-removed-contract assertions.
- `.codex-orchestrator/local/self-improvement/runner.mjs` — local-only daily orchestration and typed V2 result consumption; it is not shipped as package runtime.
- `.codex-orchestrator/local/self-improvement/self-improvement-runner.test.mjs` — exact command/result/daily-idempotency tests.
- Existing `src/v2/cli-contract.ts`, `src/v2/setup-cli.ts`, `src/v2/runtime.ts`, and generated implementation/proof schemas remain contract owners. Operational scripts may import or invoke them but may not define competing status vocabularies.
- `package.json` retains `smoke:live`; public `bin`, exports, and `src/cli.ts` remain unchanged until Spec 8.

## 4. Contract Test Ledger

| Invariant | First RED proof | Status |
| --- | --- | --- |
| Packaged smoke invokes one V2 candidate JSON path and cannot fall back to Legacy scoped/plan-auto commands. | packed command argv plus result-schema fixture test | planned |
| The six removed plan/tree/risk scenarios and every associated assertion/fake-agent branch are absent. | help/profile/full-scenario snapshots and source scan | planned |
| Retained/adapted scenarios assert only V2 config, ownership, publication, bounded rework, proof, and safety contracts. | per-profile fake/scratch Adapter tests | planned |
| `mobile-proof` is separately selectable and cannot silently skip an applicable changed platform. | profile/help and platform gate result tests | planned |
| Cleanup remains strict and removes only artifacts recorded by the current smoke run. | fake GitHub artifact inventory/cleanup tests | planned |
| Self-improvement parses the versioned CLI JSON result and maps every terminal/resumable outcome without regex. | implementation result matrix with misleading prose | planned |
| Daily flow runs smoke only after typed `review-ready`, creates at most one issue, reuses fingerprints, and keeps lock/phase summaries. | local runner daily matrix | planned |
| No local/package test mutates GitHub; real smoke/daily mutation occurs only under the explicit live gate. | recording process/GitHub Adapter matrix | planned |

## 5. Execution Slices

### Progress Discipline

- [ ] Start each behavior slice with focused RED evidence.
- [ ] Keep public `src/cli.ts`, `src/index.ts`, package exports/bin, and Legacy runtime unchanged.
- [ ] Run independent reviews only if the user reverses the waiver; otherwise record root self-checks.
- [ ] Do not run live smoke or a deliberate daily self-improvement mutation without separate explicit authorization.

### Slice 1 — V2 packaged smoke boundary and scenario deletion

- [ ] **Test/Proof First:** Pin the retained/deleted scenario sets, four existing profiles plus `mobile-proof`, packaged V2 candidate argv/JSON, and absence of removed labels/commands/assertions.
- [ ] Compose the package-contained V2 candidate through existing runtime/Setup Adapters without changing the public bin; make smoke read one versioned JSON result.
- [ ] Delete the six plan/tree/risk scenarios and all now-dead fake-agent/fixture/cleanup branches.
- [ ] **Checkpoint Self-Check:** Hunt source/packed fallback to Legacy CLI, multiple outcome schemas, removed labels, hidden plan graph state, stdout matching, and source-tree execution instead of package bytes.
- [ ] **Exit Gate:** focused smoke-script tests, candidate CLI tests, package consumer test, typecheck, source scan, and diff check pass.

### Slice 2 — Retained scenario adaptation

- [ ] **Test/Proof First:** Add RED scenario assertions for runner-only commit, bounded rework, report repair, diagnostics, generated browser/non-visual proof reports, configured checks, containment, and safety-negative behavior.
- [ ] Rewrite retained scenario setup/config/fake-agent payloads to exact V2 schemas and one `runIssue` outcome; remove Fresh-Context Review, TDD/reviewer evidence, phase profiles, `allowAgentLocalCommits`, and parent/tree assertions.
- [ ] Keep portable `core-release`, `extended-policy`, `proof-matrix`, and `full`; add deterministic `mobile-proof` routing and help.
- [ ] **Exit Gate:** all non-live smoke helper/profile/fake-agent tests and packed local smoke prerequisites pass with no GitHub mutation.

### Slice 3 — Typed local self-improvement consumer

- [ ] **Test/Proof First:** Replace the existing blocked-prose test with a total V2 result matrix proving misleading stdout cannot affect status and only typed `review-ready` enables smoke.
- [ ] Invoke the packaged/candidate V2 run command with explicit JSON output, validate the exact schema/version, map terminal/resumable outcomes to durable daily phases, and preserve existing discovery/review/fingerprint/lock contracts.
- [ ] Keep the runner local-only and one-issue-per-day; do not create a package skill, scheduler, second execution loop, or regex fallback.
- [ ] **Exit Gate:** the complete local self-improvement suite passes; source scan finds no execution stdout regex or Legacy command.

### Slice 4 — Authorized operational proof and closure

- [ ] Run full local tests, typecheck, containment, package install/update, package dry-run, architecture/source scans, and `git diff --check` first.
- [ ] If separate live authorization is present, run the approved relevant profile(s) against the scratch repository with strict cleanup, preserve the report, and run one deliberate daily self-improvement flow only when its exact mutation scope is authorized.
- [ ] If authorization is absent, stop before remote mutation and record the exact unmet Spec 8 predecessor gate; do not claim Spec 7 complete or switch the public CLI.
- [ ] Reconcile this spec/master and authorize Spec 8 only after all required authorized live evidence is GREEN.

## 6. Halt Conditions

- [ ] Stop if operational code needs a second lifecycle owner, reads raw run state to infer success, routes on prose/error text, or reintroduces a removed command/label/schema.
- [ ] Stop if smoke would test source files instead of the packed candidate or cleanup cannot prove exact run-owned artifacts.
- [ ] Stop if `mobile-proof` would skip changed Android/iOS proof code or touch a user-owned mobile session.
- [ ] Stop before any GitHub mutation when separate live-smoke/daily-run authorization is absent.

## 7. Validation And Done Criteria

- [ ] Every ledger row and checklist item is GREEN.
- [ ] Removed scenarios and their compatibility code are absent; retained profiles cover the approved V2 behavior.
- [ ] Live smoke and self-improvement consume one versioned CLI JSON/runIssue path with no stdout regex.
- [ ] The local self-improvement suite proves one-issue daily idempotency and smoke-after-review-ready ordering.
- [ ] Full tests, typecheck, containment, package consumer/dry-run, architecture/source scans, and diff check pass.
- [ ] Required live scratch/daily evidence is recorded under explicit authorization, or Spec 7 remains open with that exact gate.
- [ ] Independent review remains `Waived`; root self-check findings and reruns are recorded.

## 8. Implementation Review State

- **Profile:** high.
- **Plan:** Independent artifact/checkpoint/cleanup/final review waived. Root performs executable single-path, removed-surface, packed-byte, typed-result, cleanup, and mutation-boundary self-checks.
- **Pass History:** None; outcome `Waived`.
- **Verified Defects:** None.
- **Accepted Risks:** `S7-REVIEW-WAIVER-001` — independent review omitted by user instruction. Shared Codex auth/user-readable host files remain accepted; GitHub publication credentials and mutations remain runner-only and separately gated.
- **Open Defects:** None.

## 9. Final Handoff Requirements

- State the exact retained/deleted scenario/profile matrix, the single packaged JSON path, self-improvement outcome mapping, self-check fixes, complete local validation, live commands/evidence, cleanup result, skipped gates, and residual risks.
- List changed files by operational role and identify the checkpoint commit. Do not claim Spec 8 authorization while required live evidence is absent.

## 10. Final Action

Reconcile this spec and master only after packaged smoke, typed self-improvement consumption, required authorized live evidence, strict cleanup, and all local gates are GREEN. Then author Spec 8; otherwise preserve the exact live-authorization blocker.
