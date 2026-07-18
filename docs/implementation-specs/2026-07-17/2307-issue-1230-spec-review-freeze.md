---
title: "Issue 1230 spec authoring, review, repair, and freeze"
created_at: "2026-07-17T23:07:26+03:00"
source_type: "issue"
source_plan: "None"
source_issues:
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/1230"
status: "ready"
execution_model: "single-agent"
spec_mode: "compact"
implementation_size: "medium"
expected_repositories: 1
review_profile: "high"
review_reasons:
  - "Durable multi-process approval authority and crash recovery"
review_outcome: "Approved"
review_verdict: "Approved"
review_coverage: "architecture/ownership, deterministic executability, state safety, validation, approved product intent"
review_passes: "3; full/closure/closure"
---

## 1. Execution Context
- **Goal:** A `spec-required` run produces only an independently approved immutable frozen-spec receipt, or a typed terminal outcome; it never starts product implementation.
- **Source Material:** GitHub issue #1230 and package-owned `spec-author` / `spec-review` workflow operations.
- **Approved Scope:** Typed spec revision/review/freeze state, contained author/reviewer execution, Runner integration, restart recovery, schemas and automated tests.
- **Out of Scope:** Product implementation, publication/PR creation, live smoke, user-facing workflow redesign.
- **Minimum Solution:** Extend the existing Runner-owned route lifecycle and contained process seams with one durable spec-delivery aggregate and frozen receipt.
- **Added Complexity:** `SpecDeliveryV1` aggregate — required so revision immutability, independent approval, budgets, launch recovery, and frozen authority survive restart; without it the model or transient process state could self-approve or drift.
- **Primary Risk:** implementation authority can be minted for an unreviewed, stale, or tampered revision.

## 2. Preconditions And Evidence
- **Required Services / Env / Fixtures:** Existing injected Runner fixtures; no live services.
- **Blocking Unknowns:** None.
- **Confirmed Targets:** `src/v2/run-issue.ts`, `src/v2/run-store.ts`, `src/v2/contained-report-operation.ts` or a dedicated contained spec seam, `src/v2/workflow-assets.ts`, package schemas and focused V2 tests.
- **Confirmed Commands:** `npm run build --silent`; focused `node --test dist/test/v2-spec-delivery.test.js dist/test/v2-run-issue.test.js`; `npm run check:workflow --silent`; `npm run verify:workflow --silent`; `npm run typecheck --silent`.
- **Protected Paths / Rejected Approaches:** Do not let the author approve, mutate prior revisions, use product implementation as spec repair, or publish a frozen receipt after rejected/blocked/exhausted review.
- **Source of Truth:** Runner-persisted `SpecDeliveryV1`; frozen receipt binds its exact approved revision and package workflow generation.

## 3. Contract Test Ledger

| Invariant | First RED proof |
| --- | --- |
| Author and reviewer identities/processes are distinct | reject matching author attempt/reviewer session and invocation identity |
| Revisions are append-only and hash-verified | reject replacement, duplicate revision number, and content/path/hash tamper |
| Full review precedes affected Closure | reject Closure without prior Full ledger/coverage and reject unaffected mutation |
| Freeze requires independently approved exact revision | reject stale revision/hash, unresolved mandatory defect, rejected/exhausted state |
| Restart preserves exact stage/effects/budgets | replay prepared/launched/completed checkpoints without duplicate confirmed effect |
| Product implementation never runs | public `spec-required` fixture reaches frozen receipt/typed terminal with zero implementation calls |

## 4. Execution Slices

### Slice 1 — Durable spec authority aggregate
- [x] **Test/Proof First:** Add strict validator/hash/tamper, immutable revision, ledger/Closure, budget and freeze-negative tests.
- [x] **Target:** `src/v2/spec-delivery.ts` — own exact states, transitions, canonical defects and frozen receipt.
- [x] **Target:** `src/v2/run-store.ts` — persist and validate the aggregate and spec process recovery purpose.
- [x] **Validation:** focused spec-delivery and run-store tests.
- [x] **Exit Gate:** invalid or stale revision cannot mint a frozen receipt.

### Slice 2 — Contained author and independent reviewer
- [x] **Test/Proof First:** Add author/reviewer separation, policy, report repair, transport retry and safe-halt fixtures.
- [x] **Target:** contained operation/runtime seams — execute package-owned `spec-author` and `spec-review` with durable prepared/launched gates.
- [x] **Target:** package schemas — make author/review outputs exact enough for deterministic validation and Closure correlation.
- [x] **Validation:** focused contained operation and workflow parity tests.
- [x] **Exit Gate:** author can write only its revision artifact; reviewer is report-only and cannot share author identity.

### Slice 3 — Runner convergence and freeze publication
- [x] **Test/Proof First:** Add public `spec-required` Full→repair→Closure→freeze and crash matrix tests, plus blocked/rejected/exhausted negatives.
- [x] **Target:** `src/v2/run-issue.ts` — replace route-ready placeholder with Runner-owned convergence and typed frozen result.
- [x] **Target:** runtime/export/fake-agent seams — wire contained operations and deterministic fixture reports.
- [x] **Validation:** public RunIssue fixtures prove no implementation/check/proof/publication call occurs.
- [x] **Exit Gate:** replay after every persisted boundary resumes exact stage and returns the same frozen receipt without duplicate confirmed effects.

## Review Focus
- **Mandatory Lenses:** architecture/ownership, deterministic executability, state safety, validation, approved product intent.
- **Targeted Recipes:** Full first; affected-lens Closure after repair; fresh Full only if mandatory coverage is invalidated.
- **Bug Classes:** self-approval, stale coverage, mutable revision history, budget reset, duplicate process/effect, frozen hash drift, implementation leakage.

## 5. Validation And Done Criteria
- [x] **Lint/Format:** `git diff --check`.
- [x] **Typecheck/Build:** `npm run typecheck --silent && npm run build --silent`.
- [x] **Tests:** focused changed V2 suites, then package-consumer test.
- [x] **Architecture Check:** one independent blocker-focused final review confirms Runner owns topology and freeze authority.
- [x] **Live/Manual Proof:** Not applicable; live smoke mutates GitHub and is outside ticket scope.
- [x] **Behavior Proof:** a frozen receipt verifies exact run/issue/revision/spec/workflow hashes while implementation call count remains zero.
- [x] **Reconciliation:** every unchecked item is unfinished, blocked with evidence, or intentionally not applicable.
- [x] **Final Handoff Requirements:** standard `$spec-implementer` Final Risk Handoff; additionally report frozen receipt tamper negatives and stage-restart coverage.
