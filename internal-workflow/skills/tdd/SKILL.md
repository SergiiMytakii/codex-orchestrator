---
name: tdd
description: Use test-driven development where possible for observable behavior changes with a natural public seam and a meaningful pre-change failure.
---

# Test-Driven Development

TDD is an internal proof discipline invoked by Implement, which retains
ownership of implementation, production mutations, Review, and Git.
Read `CONTEXT.md` when present and relevant ADRs so test vocabulary and expected
behavior match the project's domain and authorized contract.

## Test Boundary and Expectations

Test observable behavior through the existing public boundary used by callers.
Choose that boundary from repository evidence; ask only when the choice changes
product behavior or ownership. Derive expected outcomes from the authorized
request, issue, Parent PRD, or existing contract independently of the production
algorithm. Current output, copied logic, or generated snapshots alone do not
establish correctness; do not freeze a known bug as expected behavior. Resolve
material uncertainty about the intended behavior before encoding expectations.

Prefer realistic inputs and tests that survive internal refactoring.
Do not test private methods or add production indirection solely for mocks.
Assert through the caller-facing interface. Inspect persisted state directly
when persistence is itself the contract under test; do not use database checks
as a substitute for proving caller-visible behavior.

## RED -> GREEN Loop

1. Select one behavior from the authorized contract. Add or adapt a focused test
   and confirm it fails before implementation for the intended observable reason,
   not a setup, import, or unrelated failure.
2. Add the smallest complete implementation that passes the test, then rerun it.
   Do not add speculative behavior or weaken expectations to obtain GREEN.
3. Refactor only after GREEN when the change exposes concrete complexity.
   Keep the refactor in scope and rerun affected tests; skip it when unnecessary.

Repeat for the next behavior. Work in small behavior-focused cycles; multiple
assertions or cases may establish the same behavior. Do not write a speculative
suite before exercising the first slice. Broader verification, diagnosis-handoff
reproduction, and Review remain governed by Implement.

Check that each test would catch a real violation of its protected contract
and still pass after an internal refactor preserving that contract. Mock calls,
presence checks, or snapshots alone are insufficient unless they establish an
explicit lifecycle, compatibility, or observable behavior requirement.

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
