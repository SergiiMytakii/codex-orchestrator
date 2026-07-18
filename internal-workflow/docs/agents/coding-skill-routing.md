# Coding Skill Routing

This file is the normative global route and ownership policy. Keep repository
commands, domain facts, credentials, deployment assumptions, and product
behavior in repository `AGENTS.md`, `CONTEXT.md`, ADRs, or local skills.

## Ownership

- Personal skills live only in `../../skills`.
- `agents/openai.yaml` owns invocation metadata; `agents/*.toml` owns named-role
  model and effort.
- A shared rule has one owner. Callers link to it instead of copying its prose.
- Skill-specific detail belongs in that skill's `references/` and loads only
  when its branch is active.
- Root owns the user dialogue, decisions, critical path, integration, and final
  handoff. A reviewer child owns independent review.

## Default Implementation Route

`medium` is the default for behavior-changing implementation. Use:

- `simple` only for a tiny local change with one obvious proof;
- `medium` for a clear coherent outcome with settled authority, one ownership
  path, and credible affected validation—even across several files, modules,
  API, persistence, or shared state;
- `high` only when a sensitive mechanism has both a material failure
  consequence and an uncertainty amplifier such as unclear ownership,
  cross-trust effects, non-local recovery, an unproven external contract, or
  proof that cannot isolate the dangerous state.

Prefer direct root implementation for `simple` and ordinary `medium` work. Use
`$implementation-spec-maker` only for a real execution decision or coordination
gap. Use `$tickets-orchestrator` only for an approved ticket graph, real delivery
dependencies or disjoint parallel slices, or an explicit orchestration request.
Do not manufacture PRDs, tickets, specs, agents, or review checkpoints from
file count or generic risk labels.

## Core Routes

| Situation | Route |
| --- | --- |
| Tiny, clear, low-risk edit | `$small-task-implementer` after its Fit Gate |
| Clear feature or fix | Root + one `$tdd` activation + affected validation |
| Missing execution detail | `$implementation-spec-maker` -> artifact review -> `$spec-implementer` |
| Approved implementation spec | `$spec-implementer` |
| Approved dependency graph or explicit orchestration | `$tickets-orchestrator` |
| Product discovery or ticket decomposition | `$to-spec`, `$spec-to-tickets`, or `$wayfinder` as applicable; stop before delivery |
| Explain-only bug | `$bug-root-cause-explainer`; no edits |
| Confirmed bounded bug fix | `$tdd` + `$code-debugger` unless already inside an authorized implementation flow |
| Hard, flaky, unclear, or performance bug | `$diagnosing-bugs` before the explain/fix route |
| Review request | `$code-review` in the profile-selected reviewer child |
| External multi-source uncertainty | `$research`; narrow documentation lookup stays inline |
| Commit request | `$commit`; push/PR still require separate authority |

Generated planning artifacts and labels never authorize implementation. One
deterministic approved ticket may run directly; a graph follows the authorized
delivery workflow.

## TDD And Review

Apply `$tdd` before behavior-changing features, fixes, logic, persistence,
APIs, or risky refactors. Do not manufacture RED tests for docs, copy,
formatting, simple config, builds, or read-only work.

Review applicability lives in [`review-gates.md`](review-gates.md). Shared
Full/Closure mechanics live in [`review-protocol.md`](review-protocol.md).
Artifact review is owned by
[`implementation-spec-review/references/review-loop.md`](../../skills/implementation-spec-review/references/review-loop.md);
approved-spec implementation review is owned by
[`spec-implementer/references/review-loop.md`](../../skills/spec-implementer/references/review-loop.md).

Root never substitutes self-review for a required independent reviewer. Use one
`reviewer_fast` for `simple`, one `reviewer_standard` for `medium`, and two
disjoint `reviewer_deep` tracks for `high`. A reviewer Adapter executes inline
only after it is already inside that assigned child.

## Delegation

Run work inline by default. Delegate only when the user, an invoked skill, or
repository policy authorizes it and the task benefits from independent review,
isolated deep analysis, or disjoint implementation ownership.

| Need | Named role |
| --- | --- |
| Mechanical inventory | `explorer_quick` |
| Bounded cross-module trace | `explorer_fast` |
| Ambiguous architecture, contract, or cause | `analyst_deep` |
| Primary-source external research | `researcher_standard` |
| Independent review | `reviewer_fast`, `reviewer_standard`, or `reviewer_deep` by profile |
| Approved isolated implementation slice | `implementer_standard`; `implementer_deep` only for material uncertainty |

Keep the root critical path local. Use at most two explorers for disjoint
questions and at most two parallel implementers with disjoint write scopes.
Children do not conduct user dialogue or spawn grandchildren.

## Validation And Runtime Safety

Use targeted behavior proof plus the smallest affected integration check for
simple and medium work. Run a full repository suite only when repository policy
requires it, a broad shared contract cannot be isolated, or the task is `high`.

For Flutter UI, follow [`tool-usage.md`](tool-usage.md): platform QA owns UI
work and `$flutter-attach-session` is only the attach-safe runtime layer. Treat
live app, IDE, VM Service, and `flutter run` sessions as user-owned.

Read local evidence before external search: applicable `AGENTS.md`, `CONTEXT.md`,
ADRs, manifests, lockfiles, tests, scripts, and code owners. Mark missing facts
unconfirmed rather than inventing them.

Contract-risk implementation uses
[`contract-test-ledger.md`](contract-test-ledger.md) only for material
invariants. Long framework lenses, examples, and recipes remain skill-local and
load on demand.
