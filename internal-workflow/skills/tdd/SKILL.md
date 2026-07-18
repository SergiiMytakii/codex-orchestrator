---
name: tdd
description: Test-driven development for changes that alter observable behavior, have a natural public test seam, and can produce a meaningful failing test before implementation. Use after the global TDD Fit Gate passes, or when the user explicitly requests red-green-refactor, test-first development, or TDD.
---

# Test-Driven Development

Use short vertical RED -> GREEN cycles. Make each test prove observable behavior through the same public seam real callers use.

## Fit

Use this skill only when the change alters observable behavior, a natural public
seam exists, and the pre-change test will fail for the intended behavioral
reason. If an implicit activation fails this gate, stop the TDD route and use
existing regression tests plus affected validation. For mixed tasks, apply TDD
only to the behavioral slice.

Behavior-preserving cleanup, dead-code deletion, documentation, copy,
formatting, generated assets, package maintenance, simple config, builds, and
read-only work do not need TDD. Absence and architecture guards added after a
cleanup are validation, not RED proofs.

## Core Contract

- Lock expected behavior from the request, specification, design, bug report, or existing product behavior before changing implementation.
- Derive expected values from an independent source, never from the production algorithm.
- Prove RED on the old behavior for the same observable reason the user reported or requested.
- Add only enough implementation to make the current test pass; do not anticipate later tests.
- Keep tests stable across behavior-preserving refactors and refactor only while GREEN.

Read [tests.md](tests.md) when choosing or reviewing test shape. Read [mocking.md](mocking.md) before introducing test doubles.

## Before the First RED

1. Read local instructions, domain language, existing tests, and relevant ADRs.
2. List the prioritized observable behaviors, not implementation steps.
3. Select the public seam where callers observe each behavior.
4. Ask the user only when the seam changes the public contract, product intent is unclear, or behavior priorities materially conflict.
5. For contract-risk changes, create or update the shared [Contract Test Ledger](../../docs/agents/contract-test-ledger.md) and map each invariant to its first failing test or observable proof.
6. If no natural public seam exists, stop the TDD route. Consult [interface-design.md](interface-design.md) only when changing the interface is itself required by the task.

For UI behavior, define proof at the rendered seam: visible content and order, interaction result, semantics, or screenshot when layout direction or scrolling matters.

## RED -> GREEN Cycle

For each behavior:

1. **RED:** Write one test through the selected seam.
2. Confirm it fails on current behavior for the expected reason. A passing test or an internal-only failure is not valid RED.
3. **GREEN:** Add the minimal implementation required for that test.
4. Run the proof and update the ledger status to `red`, `green`, or `blocked` with the missing seam or evidence.

Keep each cycle to one seam, one behavior, one test, and one minimal implementation. Do not rewrite the test to fit the code. For state, async, lifecycle, retry, cache, or auth defects, include the competing condition when feasible.

Handle reviewer repairs inside the same activation only under [bug workflow routing](../../docs/agents/bug-workflow-routing.md); group related cases by protected invariant.

## After GREEN

Refactor as a separate review-stage activity, never while RED. Use [refactoring.md](refactoring.md) for candidates and rerun affected tests after each step.

## Cycle Checklist

```text
[ ] Behavior is proved through the caller's public seam
[ ] Expected behavior is locked and the expected value is independent
[ ] RED fails on old behavior for the correct observable reason
[ ] Test was not fitted to implementation details
[ ] GREEN uses only the code needed for the current behavior
[ ] Final outcome and relevant competing condition are proved
[ ] Contract Test Ledger is current when applicable
[ ] Refactoring starts only after GREEN
```
