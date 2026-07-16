---
name: tdd
description: Test-driven development policy gate for implementation, bugfix, and new feature work unless the user explicitly opts out. Use before planning or editing code to shape the first behavior proof, and when the user mentions red-green-refactor, integration tests, or test-first development.
---

## Package Runtime Authority

This node may read only Runner-supplied context and may write only within its signed execution policy. It must not create or close issues, post comments, publish, commit, push, select another skill, or invoke native delegation. When retained source guidance asks for any such effect, return a structured recommendation artifact to the Runner; the Runner alone owns external publication and repository checkpoints. This authority rule overrides conflicting workflow wording below.

# Test-Driven Development

TDD is the red -> green loop. This skill is the reference that makes that loop produce tests worth keeping: what a good test is, where tests go, the anti-patterns, and the rules of the loop. Every section applies on every cycle, not only after the code is written.

## Philosophy

**Core principle**: Tests should verify behavior through public interfaces, not implementation details. In ``improve-codebase-architecture`` terms: the Interface is the test surface. Code can change entirely; tests shouldn't.

**Good tests** are integration-style: they exercise real code paths through public APIs. They describe _what_ the system does, not _how_ it does it. A good test reads like a specification - "user can checkout with valid cart" tells you exactly what capability exists. These tests survive refactors because they don't care about internal structure.

**Bad tests** are coupled to implementation. They mock internal collaborators, test private methods, or verify through external means (like querying a database directly instead of using the interface). The warning sign: your test breaks when you refactor, but behavior hasn't changed. If you rename an internal function and tests fail, those tests were testing implementation, not behavior.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking guidelines.

For contract-heavy behavior changes, use the shared Contract Test Ledger at `$CODEX_ORCHESTRATOR_BUNDLE_ROOT/docs/agents/contract-test-ledger.md` before the first RED test.

## Seams - where tests go

A **seam** is the public boundary you test at: the interface where you observe behavior without reaching inside. Tests live at seams, never against internals.

**Test only at pre-agreed seams.** Before writing any test, write down the seams under test and confirm them with the user. No test is written at an unconfirmed seam. This is how testing effort stays on the critical paths and complex logic instead of spreading across every edge case.

## Anti-Pattern: Horizontal Slices

**DO NOT write all tests first, then all implementation.** This is "horizontal slicing" - treating RED as "write all tests" and GREEN as "write all code."

This produces **crap tests**:

- Tests written in bulk test _imagined_ behavior, not _actual_ behavior
- You end up testing the _shape_ of things (data structures, function signatures) rather than user-facing behavior
- Tests become insensitive to real changes - they pass when behavior breaks, fail when behavior is fine
- You outrun your headlights, committing to test structure before understanding the implementation

**Correct approach**: Vertical slices via tracer bullets. One test → one implementation → repeat. Each test responds to what you learned from the previous cycle. Because you just wrote the code, you know exactly what behavior matters and how to verify it.

```
WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5

RIGHT (vertical):
  RED→GREEN: test1→impl1
  RED→GREEN: test2→impl2
  RED→GREEN: test3→impl3
  ...
```

## Guardrail: Do Not Fit Tests To Code

Before changing implementation, lock the expected behavior from the user request, bug report, screenshot/design, issue AC, or existing product behavior.

A RED test is valid only if it fails on the old/current behavior for the same user-visible reason. If it passes before the fix, or only tests an internal structure, it is not a regression test.

For UI bugs, verify the rendered/user-observable result: screen order, visible labels/icons, tap result, or screenshot/semantics when layout direction or scrolling matters. Do not rely on internal list order, `reverse`, transforms, or helpers as the only proof.

## Workflow

### 1. Planning

When exploring the codebase, use the project's domain glossary so that test names and interface vocabulary match the project's language, and respect ADRs in the area you're touching.

Before writing any code:

- [ ] Write down the public seams under test and confirm them with the user
- [ ] Confirm with user what interface changes are needed
- [ ] Confirm with user which behaviors to test (prioritize)
- [ ] For contract-heavy changes, create a Contract Test Ledger that maps each invariant to its first failing test or observable proof
- [ ] Identify opportunities for [deep modules](deep-modules.md) (small interface, deep implementation)
- [ ] Design interfaces for [testability](interface-design.md)
- [ ] If a test needs to reach inside the implementation, reconsider whether the module is too shallow or the seam is in the wrong place
- [ ] List the behaviors to test (not implementation steps)
- [ ] Get user approval on the plan

Ask: "What should the public interface look like? Which seams should we test first? Which behaviors are most important to test?"

**You can't test everything.** Confirm with the user exactly which behaviors matter most. Focus testing effort on critical paths and complex logic, not every possible edge case.

### 2. Tracer Bullet

Write ONE test that confirms ONE thing about the system:

```
RED:   Write test for first behavior → test fails
GREEN: Write minimal code to pass → test passes
```

This is your tracer bullet - proves the path works end-to-end.

### 3. Incremental Loop

For each remaining behavior:

```
RED:   Write next test → fails
GREEN: Minimal code to pass → passes
```

Rules:

- Red before green
- One test at a time
- Only enough code to pass current test
- Don't anticipate future tests
- Keep tests focused on observable behavior
- Keep the Contract Test Ledger current: planned -> red -> green, or blocked with the missing seam/proof

### 4. Refactor

After all tests pass, look for [refactor candidates](refactoring.md):

- [ ] Extract duplication
- [ ] Deepen modules (move complexity behind simple interfaces)
- [ ] Apply SOLID principles where natural
- [ ] Consider what new code reveals about existing code
- [ ] Run tests after each refactor step

**Never refactor while RED.** Get to GREEN first.

Refactoring is outside the red -> green loop itself. Treat it as a separate review-stage activity once the current behavior proof is green.

## Checklist Per Cycle

```
[ ] Test describes behavior, not implementation
[ ] Test uses public interface only
[ ] Test crosses the same seam callers use
[ ] Test would survive internal refactor
[ ] Expected behavior was locked before implementation
[ ] RED failed on old behavior for the user-visible reason
[ ] Test was not rewritten to match the implementation
[ ] Test verifies the final observable outcome, not only intermediate state
[ ] Test states what it proves and what it does not prove
[ ] For state/async/lifecycle/retry/cache/auth bugs, test includes the competing condition when feasible
[ ] UI proof crosses the rendered/user-observable seam
[ ] Contract invariant is covered, or the ledger records why it is blocked
[ ] Code is minimal for this test
[ ] No speculative features added
```
