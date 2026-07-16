---
name: tickets-orchestrator
description: Coordinates a parent ticket or PRD with child implementation tickets through dependency-aware waves, proportional spec gates, bounded implementation review, integration, and delivery. Use when the user asks to orchestrate, coordinate, parallelize, or run multiple related coding tickets with Runner-owned nodes or agent waves.
---

## Package Runtime Authority

This node may read only Runner-supplied context and may write only within its signed execution policy. It must not create or close issues, post comments, publish, commit, push, select another skill, or invoke native delegation. When retained source guidance asks for any such effect, return a structured recommendation artifact to the Runner; the Runner alone owns external publication and repository checkpoints. This authority rule overrides conflicting workflow wording below.

# Tickets Orchestrator

Turn a parent issue/PRD plus child issues into a safe multi-node implementation flow.

## Execution Ownership

The orchestrator owns the issue graph and delivery; it does not duplicate
artifact authoring or spec execution state. ``implementation-spec-maker`` owns
accepted spec creation and its `../../shared/docs/agents/artifact-review-loop.md`.
For a spec-gated wave, ``spec-implementer`` owns the checklist, Contract Test
Ledger, Git checkpoints, and `../../shared/docs/agents/implementation-review-loop.md`.

No-spec waves remain a direct ``tdd`` flow under repo review gates. Do not create
an implementation spec merely to obtain review depth, and do not invoke
``spec-implementer`` when no approved implementation spec exists.

## Trigger Rules

Use this only when the user explicitly asks for orchestration, coordination, Runner-owned nodes, Runner-route, parallel agent work, or agent waves. If the user only asks for a plan, summary, or a single issue implementation, do not route Runner-owned nodes.

First classify the referenced work by size and risk. For a narrow deterministic bugfix, check whether orchestration is disproportionate; prefer one agent, one branch, and one coherent PR when child issues share the same code path, tests, release boundary, or verification flow. For medium/large work, keep enough waves and slices to preserve independent ownership, validation, release sequencing, and rollback safety. Use orchestration only for the parts that are truly independent, blocked, or human/live-gated.

Use proportional proof:

- **Small/low-risk:** keep orchestration lightweight. A concise issue result comment with behavior proof, tests, skipped checks, and residual risk is enough.
- **Medium/high-risk:** maintain a parent-level risk/proof ledger across waves, including the main contract, risky checkpoints, review focus, validation, skipped checks, residual risks, and final delivery state.

## Required Inputs

- Parent issue, PRD, or plan reference.
- Child issue references, or permission to discover linked child issues from the issue tracker.
- Repo instructions, especially `AGENTS.md`, `docs/agents/*`, and relevant source-of-truth docs when present.

## Progressive References

Load only the references needed for the current phase:

- Spec-gate workflow: `references/spec-gates.md`
- Runner-route and wave integration: `references/delegate-integrate.md`
- Finish and delivery flow: `references/finish-delivery.md`
- Stop conditions and completion standard: `references/stop-completion.md`

Load `references/spec-gates.md` only when an active issue or wave genuinely requires a spec gate. Load `references/delegate-integrate.md` before route workers or integrating a wave. Load `references/finish-delivery.md` when all active child issues are complete or blocked. Load `references/stop-completion.md` whenever risk, ambiguity, or completion status is unclear.

## Core Rules

1. Do not implement the parent issue directly when child implementation issues exist.
2. Treat the dependency graph and active wave plan as the live orchestration ledger.
3. Do not start a child issue until its blockers and required preconditions are satisfied or explicitly cleared by the user.
4. Keep one integrator responsible for merge sequencing, handoff checks, validation, and final reconciliation.
5. Use multiple workers only for disjoint write scopes; prefer fewer concurrent workers over merge-conflict risk.
6. Never let two workers edit the same file, generated artifact, or source-of-truth rule at the same time.
7. Do not broaden scope, add cleanup, or redesign the PRD unless a blocker is proven.
8. If repo reality contradicts the issue, parent PRD, or wave plan, stop and ask for clarification instead of improvising.
9. Use ``tdd`` as the default execution mode for every behavior-changing child issue.
10. Honor issue-level and wave-level spec gates before coding, while keeping them proportional.
11. Treat spec gates as ambiguity-removal gates, not mandatory document generation. When no explicit gate is set, deterministic issue and repo evidence may satisfy the decision inline as `Spec required: none`. An explicit `issue-level` or `wave-level` gate must run; reclassify it to `none` only when evidence proves the marker stale, and record that correction plus its evidence in the wave ledger.
12. For a spec-gated wave, invoke ``spec-implementer`` inline at root and let the shared Implementation Review Loop own every checkpoint, cleanup, final review, Closure, budget, and terminal outcome.
13. For a no-spec high-risk wave, run the repo-required ``code-review`` checkpoint with explicit Review Focus after the first wave that proves the risky state/contract, before starting lower-risk work.
14. Close each completed GitHub child issue as soon as its implementation is integrated, validated, committed, and summarized; do not wait for the parent orchestration to finish.
15. For medium/high-risk parent issues or PRDs, post a concise final risk/proof mini-report to the parent issue during delivery.

## Verification Contract

A child issue is not complete until every acceptance criterion has proof.

Allowed proof: test result, smoke result, command output, API/browser check, log evidence, DB inspection, or an explicit skipped-verification reason with risk. No proof means the issue remains incomplete, blocked, or explicitly deferred in the wave ledger.

## Commit Policy

Default to one focused commit per completed child issue after that issue has passed integration review, acceptance-criteria proof, and relevant validation. Reference the child issue in the commit message.

Do not commit incomplete, blocked, or unverified child issues. If changes from multiple child issues are inseparable after integration, create one wave commit, reference every included child issue, and explain why separate commits were unsafe.

## Workflow

### 1. Orient

1. Read repo instructions and issue-tracker config.
2. Fetch the parent issue/PRD and all child issues.
3. Extract acceptance criteria, blockers, out-of-scope items, rejected approaches, preconditions, and validation expectations.
4. Inspect current git status and current branch before making changes.
5. Build a dependency graph: ready, blocked, final integration/regression.
6. Identify protected paths, likely source-of-truth owners, and files that must not be edited concurrently.
7. Extract each issue's spec gate metadata.
8. Mark unresolved external contracts, credentials, live fixtures, or human-only decisions as blocked until proven or cleared.

### 2. Plan Waves

Create the smallest safe parallel wave first.

- Start only issues with no unresolved blockers.
- Prefer independent vertical slices over horizontal layer splits.
- Merge tightly coupled child issues into one wave/worker when splitting them would force duplicate context, duplicate tests, or separate PRs for one behavior change.
- Avoid parallel writes to the same owner files unless scopes are truly disjoint.
- Keep final cross-cutting regression or cleanup issues for the last wave.
- Define each wave's exit gate: worker reports, integration diff review, combined validation, and blocker reconciliation.
- Decide whether the wave requires a spec gate.

### 3. Execute The Active Wave

1. If a spec gate is required, load `references/spec-gates.md`.
2. Before Runner-route or parallel work, load `references/delegate-integrate.md`.
3. For a spec-gated wave, activate ``spec-implementer`` at root before Runner-route and persist its `Implementation Review State` in the accepted spec.
4. For a no-spec wave, record the direct ``tdd`` contract and applicable repo review gates in the wave ledger.
5. Runner-route only disjoint write scopes.
6. Integrate each wave as a hard gate without creating a second review loop.
7. Reconcile every active child issue as complete, blocked with evidence, or deferred.
8. For every completed child issue, comment with the result/proof summary and close it in GitHub before starting the next dependent wave.

### 4. Finish

When all child issues are complete or blocked, load `references/finish-delivery.md` and complete delivery. If completion status is uncertain, load `references/stop-completion.md` first.

## Output Contract

Keep the user-facing ledger compact:

- active wave
- ready/blocked/deferred issues
- owner/write scope for each worker
- verification completed per issue
- GitHub issue closure status per completed issue
- skipped checks and risks
- next wave or final delivery state
- for medium/high-risk work, the parent-level risk/proof ledger and final handoff status
- for spec-gated work, the accepted spec path and Implementation Review outcome/counts

Do not claim orchestration is complete until the completion standard in `references/stop-completion.md` is satisfied.
