---
name: tdd
description: Use test-driven development where possible for observable behavior changes with a natural public seam and a meaningful pre-change failure.
---

# Test-Driven Development

TDD is an internal proof discipline invoked by Implement, which retains
ownership of implementation, production mutations, Review, and Git.
Read `GLOSSARY.md` when present and relevant ADRs so test vocabulary and expected
behavior match the project's domain and authorized contract.

## Test Boundary and Expectations

Test observable behavior through the existing public boundary used by callers.
Choose that boundary from repository evidence. When multiple boundaries are
plausible, state in one line per candidate what it catches and what it misses.
Ask only when the choice changes product behavior or ownership. Derive expected
outcomes from the authorized request, issue, Parent PRD, or existing contract
independently of the production algorithm. Current output, copied logic, or
generated snapshots alone do not establish correctness. Do not freeze a known
bug as expected behavior. Resolve material uncertainty about the intended
behavior before encoding expectations.

Use realistic, controlled inputs. Verify required preconditions and assert an
outcome specific to the scenario, such as the expected refusal and unchanged
state when both are required. Missing prerequisites or skipped cases cannot
count as passes.
Do not test private methods or add production indirection solely for mocks.
Assert through the caller-facing interface. Inspect persisted state directly
when persistence is itself the contract under test; do not use database checks
as a substitute for proving caller-visible behavior.

## RED -> GREEN Loop

1. Name one contract violation and add or adapt a focused test for it. Run it
   against the broken behavior and confirm it fails before implementation for
   the intended observable reason. Setup, import, and unrelated errors do not
   establish RED. For an already-fixed bug, reproduce the fault in isolation.
   Verify any temporary change against the saved original before trusting RED,
   and restore the original before verifying GREEN.
2. Add the smallest complete implementation that passes the test, then rerun it.
   Do not add speculative behavior or weaken expectations to obtain GREEN.
3. Refactor only after GREEN when the change exposes concrete complexity.
   Keep the refactor in scope and rerun affected tests; skip it when unnecessary.

Repeat for the next behavior. Work in small behavior-focused cycles; multiple
assertions or cases may establish the same behavior. Do not write a speculative
suite before exercising the first slice. Broader verification, diagnosis-handoff
reproduction, and Review remain governed by Implement.

Tests should still pass after an internal refactor preserving the contract.
Mock calls, presence checks, or snapshots alone are insufficient unless they
establish an explicit lifecycle, compatibility, or observable behavior requirement.

## Avoid

Assertions coupled to private structure or arbitrary internal call order,
expected values copied from the production algorithm, and bulk test-first work
based on unverified implementation assumptions. Preserve meaningful coverage
when adapting existing tests.

If no natural public seam or meaningful pre-change failure exists, use direct
observable proof instead. Do not manufacture RED for docs, copy, formatting,
mechanical config, generated files, deletion, builds, or read-only work.

## References

- [tests.md](tests.md): when examples of test quality are needed.
- [mocking.md](mocking.md): before introducing test doubles.
- [interface-design.md](interface-design.md): for an already-authorized interface change.
- [refactoring.md](refactoring.md): when refactoring after GREEN is needed.
