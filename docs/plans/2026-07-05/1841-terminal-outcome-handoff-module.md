---
title: "Terminal Outcome Handoff Module"
created_at: "2026-07-05T18:41:04Z"
complexity: "medium"
status: "approved"
---

## 1. Executive Summary
- **Goal:** Centralize runner terminal-outcome finalization for review-ready, blocked, and promotion-requested paths so draft PR handoff, labels, comments, PR verification, durable-summary rendering, and state cleanup follow one tested ordering contract.
- **Scope:** In scope: normal scoped runs, recovered scoped runs, parent plan-auto completion/blocking, and child blocked/review-ready finalization. Out of scope: publishability decision logic, durable summary record schema, report body copy, live-smoke scenarios, release publishing, and GitHub adapter internals.
- **Chosen Option:** Extract a terminal-outcome module, as delegated by the user and recommended here.
- **Why This Approach:** It is the smallest complete seam because duplicated mutation ordering currently lives across scoped, recovery, parent, and child paths. A narrower label/comment helper would leave PR and state cleanup ordering duplicated; a larger lifecycle rewrite would exceed the requested boundary.

## 2. Current Understanding
- **Confirmed:** `docs/deep-dive.md` and ADR 0001 make publication runner-owned. `scoped-auto-command.ts` already has `finishScopedReviewReadyHandoff`, `finishScopedBlockedHandoff`, and promotion finalization. `scoped-recovery.ts` reuses scoped handoff for recovered review-ready/blocked runs but owns state updates after that. `plan-auto-command.ts` repeats parent review-ready, parent blocked, child review-ready, child blocked, sibling-blocked, and merge-conflict label/comment/store ordering. Durable Run Summary evidence is rendered by `handoff-evidence.ts` and written before final handoff by callers.
- **Assumptions:** Existing report body builders stay as the presentation boundary. Existing in-memory adapters are sufficient for focused ordering tests. Parent terminal state cleanup remains `RunnerStateStore.removeRun` only after the review/blocked handoff mutation succeeds.
- **Open Decisions:** None. The user supplied the desired solution direction and requested implementation.

## 3. Architectural Design
- **Component Flow:** Caller builds or writes outcome evidence -> caller passes prebuilt report body / PR body and optional state cleanup to terminal-outcome module -> module executes push/PR verification when needed -> module removes `agent:running` -> module adds the terminal label -> module posts or idempotently skips the terminal comment -> module runs success-only cleanup hooks -> caller returns its existing result shape.
- **Simplest Viable Path:** Add `src/runner/terminal-outcome.ts` with small functions for `finishReviewReadyOutcome`, `finishBlockedOutcome`, and `finishPromotionRequestedOutcome`, plus child/parent-friendly input shapes. Move ordering out of the four current files without moving evidence construction.
- **Why Not Simpler:** A label/comment utility would not cover the review-ready ordering of push -> draft PR -> verify refs -> label/comment, which is the highest-value publication boundary. Keeping PR creation in `scoped-auto-command.ts` and only extracting child blocking would leave the main duplication intact.
- **Architecture Lens:** Module: `terminal-outcome`. Interface: finish terminal outcomes from already-computed evidence and report text. Seam: runner-owned publication boundary, not a new GitHub adapter abstraction. Deletion test: deleting the module would restore repeated mutation ordering in several runner paths, so the module concentrates real complexity. Depth comes from one small interface enforcing ordering across multiple lifecycle paths; locality stays inside `src/runner`.
- **Clean Architecture Map:** Domain: outcome states and evidence vocabulary remain in `runner-handoff-decision.ts` and `durable-run-summary.ts`. Application/Use Case: terminal-outcome coordinates finalization ordering. Infrastructure: GitHub issue/PR adapters and git push stay injected dependencies. Presentation: existing report and PR body builders stay in `handoff-evidence.ts`.
- **Reuse Strategy:** Reuse `buildScopedPullRequestBody`, `buildScopedReviewReport`, `buildScopedBlockedReport`, `buildPromotionRequestReport`, `buildIssueTreePullRequestBody`, `buildIssueTreeReviewReport`, `buildChildReviewReport`, `buildChildBlockedReport`, `buildParentBlockedReport`, and `verifyPullRequestRefs`. Keep `writeDurableRunSummary` at callers so outcome evidence remains explicit before terminal mutation.
- **Rejected Paths:** Do not rewrite publishability checks, completion report parsing, durable summary schema, or GitHub adapters. Do not introduce an abstract adapter layer around existing adapters. Do not run live smoke unless separately requested.

## 4. Constraints And Edge Cases
- **Data And Scale:** Handoff payloads are bounded issue/PR comments and validation arrays already assembled in memory. The module must not introduce pagination or repository scans.
- **Errors And Fallbacks:** If push, PR creation, PR verification, label mutation, or comment posting fails, cleanup hooks must not run and callers should surface the thrown error. Idempotent blocked comments must preserve existing marker behavior.
- **Concurrency And State:** Terminal mutations are sequential by design. Review-ready cleanup must run only after comment posting succeeds. Recovered children and recovered scoped runs must preserve existing skip-cleanup semantics.

## 5. Impacted Areas
- `src/runner/terminal-outcome.ts`: new module owning terminal mutation ordering.
- `src/runner/scoped-auto-command.ts`: delegate scoped review-ready, blocked, and promotion-requested terminal finalization.
- `src/runner/scoped-recovery.ts`: continue building recovery evidence locally, delegate blocked/review-ready mutation ordering and keep recovery markers.
- `src/runner/plan-auto-command.ts`: delegate parent review-ready/blocked and child review-ready/blocked finalization paths while preserving child result shapes.
- `test/*handoff*`, `test/scoped-auto-command.test.ts`, `test/plan-auto-command.test.ts`: add or adjust focused coverage for ordering and summary rendering.

## 6. Execution Slices And Multi-Agent Model
- **Slices:** Slice 1: add RED tests for scoped terminal outcomes proving review-ready push/PR/verify happens before labels/comments, blocked comments include Durable Run Summary before terminal labels/comments, and promotion-requested uses blocked label plus promotion status. Slice 2: implement `terminal-outcome.ts` and migrate scoped normal/recovery callers. Slice 3: add RED tests for parent and child plan-auto paths proving parent draft PR handoff labels/comments and child blocked/review-ready store cleanup order. Slice 4: migrate plan-auto parent/child paths and remove duplicated ordering code. Slice 5: refactor imports/types and run full validation.
- **Per-Slice Test/Proof:** Slice 1 uses Node test runner through public exported handoff functions and in-memory adapters. Slice 2 passes the scoped tests. Slice 3 uses plan-auto public command tests or exported terminal module tests with fake adapters/stores. Slice 4 passes plan-auto focused tests. Slice 5 runs `npm test` and `npm run typecheck`.
- **Exit Gates:** Each implementation slice must move one failing behavior test to green before the next slice. Final gate is `npm test`; `npm run typecheck` may be redundant because `npm test` runs build first, but run it if import/type changes are not fully covered by the build output.
- **Agent Matrix:** Phase | Owner | Input | Output | Dependencies
  - Plan/review | Main agent | User handoff and code evidence | Saved approved plan | None
  - Scoped slice | Main agent | Scoped finalization tests | Terminal module plus scoped migration | Plan
  - Plan-auto slice | Main agent | Parent/child finalization tests | Plan-auto migration | Scoped slice
  - Validation | Main agent | Changed source/tests | Passing local guards | All implementation slices
- **Parallelization Limits:** Do not edit scoped and plan-auto terminal paths in parallel because they will share the new module and imports. Do not run live smoke concurrently with local tests.

## 7. Implementation Handoff Contract
- **approval_state:** approved
- **approved_scope:** Centralize terminal outcome finalization for review-ready, blocked, and promotion-requested runner paths in `src/runner`, with focused tests.
- **do_not_touch:** `.env`, `.env.*`, release publishing files, package version, unrelated prompt text, live-smoke fixtures unless a failing focused test proves they must change.
- **architecture_rules:** The terminal module owns mutation ordering only. Evidence construction, publishability decisions, durable summary writing, and report copy remain outside or in existing builders. Inject GitHub/git/store dependencies; do not instantiate adapters inside the new module.
- **rejected_paths:** No broad runner lifecycle rewrite, no new GitHub adapter abstraction, no durable summary schema changes, no manual `npm publish`, no live-smoke run unless explicitly requested.
- **required_docs:** None beyond the saved plan.
- **preconditions:** Clean worktree, local npm dependencies installed, no live GitHub mutation required for tests.
- **phase_boundaries:** Plan saved -> scoped RED/GREEN -> plan-auto RED/GREEN -> refactor -> local validation -> final review.
- **validation_gates:** Behavior-first focused tests per slice, then `npm test`; run `npm run typecheck` if not already covered by `npm test` build output or if diagnosing type-only failures.
- **blocking_assumptions:** None.
