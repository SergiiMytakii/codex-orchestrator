---
name: tdd
description: Use test-driven development where possible for observable behavior changes with a natural public seam and a meaningful pre-change failure.
---

# Test-Driven Development

Use TDD where possible. TDD is the RED -> GREEN loop. Work in short vertical
cycles through the same public seam real callers use. This skill is the
reference that makes that loop produce tests worth keeping: what a good test
is, where tests go, the anti-patterns, and the rules of the loop.

When exploring the codebase, read `CONTEXT.md` (if it exists) so test names and
interface vocabulary match the project's domain language, and respect ADRs in
the area you're touching.

TDD is an internal proof discipline. It does not own or start the
implementation workflow, production mutations, Review, or Git; the invoking
Implement owner retains those responsibilities.

## What a good test is

Tests verify behavior through public interfaces, not implementation details.
Code can change entirely; tests shouldn't. A good test reads like a
specification — "user can checkout with valid cart" tells you exactly what
capability exists — and survives refactors because it doesn't care about
internal structure.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking
guidelines.

## Seams — where tests go

A **seam** is the natural public boundary you test at: the interface where you
observe behavior without reaching inside. Tests live at seams, never against
internals. Choose that seam from repository evidence and the real caller path;
ask only when choosing it would change product behavior or ownership.

## Contract

- Lock expected behavior from the authorized request, issue, Parent PRD, or
  existing product contract.
- Choose the natural public seam from repository evidence. Ask only when the
  seam itself changes product behavior or ownership.
- Write one behavior test and confirm it fails before implementation for the
  intended observable reason.
- Add only enough production code to make that test pass, then repeat for the
  next behavior.
- Derive expected values independently; do not reproduce the production
  algorithm in the assertion.
- Prefer tests that survive internal refactors. Do not test private methods or
  introduce production indirection solely for mocks.
- Refactor only after GREEN and only to remove concrete complexity introduced
  by the change.

## Anti-patterns

- **Implementation-coupled** — mocks internal collaborators, tests private methods, or verifies through a side channel (querying the database instead of using the interface). The tell: the test breaks when you refactor but behavior hasn't changed.
- **Tautological** — the assertion recomputes the expected value the way the code does (`expect(add(a, b)).toBe(a + b)`, a snapshot derived by hand the same way, a constant asserted equal to itself), so it passes by construction and can never disagree with the code. Expected values must come from an independent source of truth — a known-good literal, a worked example, the spec.
- **Horizontal slicing** — writing all tests first, then all implementation. Bulk tests verify _imagined_ behavior: you test the _shape_ of things rather than user-facing behavior, the tests go insensitive to real changes, and you commit to test structure before understanding the implementation. Work in **vertical slices** instead — one test -> one implementation -> repeat, each test a **tracer bullet** that responds to what the last cycle taught you.

## Rules of the loop

- **RED before GREEN.** Confirm a meaningful pre-change failure for the
  intended observable reason, then add only enough code to pass it. Do not
  anticipate future tests or add speculative features.
- **One slice at a time.** One seam, one test, one minimal implementation per
  cycle.
- **Refactor only after GREEN.** Use [refactoring.md](refactoring.md) and act
  only on specific observed complexity. Refactoring is not a mandatory phase.

If no natural public seam or meaningful pre-change failure exists, use direct
observable proof instead. Do not manufacture RED for docs, copy, formatting,
mechanical config, generated files, deletion, builds, or read-only work.

Read [interface-design.md](interface-design.md) before changing a production
external seam for testability, and [mocking.md](mocking.md) before introducing
test doubles.
