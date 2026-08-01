---
name: tdd
description: Use test-driven development where possible for observable behavior changes with a natural public seam and a meaningful pre-change failure.
---

# Test-Driven Development

Use TDD where possible. Work in short vertical RED -> GREEN cycles through the
same public seam real callers use.

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

If no natural public seam or meaningful pre-change failure exists, use direct
observable proof instead. Do not manufacture RED for docs, copy, formatting,
mechanical config, generated files, deletion, builds, or read-only work.

Read [tests.md](tests.md) when test shape is uncertain and [mocking.md](mocking.md)
before introducing test doubles.
